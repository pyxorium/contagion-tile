/*
  Contagion's rules engine (version 1), compiled to WebAssembly (engine.wasm).

  Everything that decides a Contagion game, and nothing else: no page, no clock, no
  randomness beyond the seeded dice, no imports. The tile's page plays through it,
  and a host (Raku, or anyone) asks it the standard questions about a saved game:
  "here are the essentials (mode, day or seed, moves): is it valid, and what is the
  full result?" and "describe it in a line". The host keeps no copy of these rules.

  The rules are House Dice's Contagion, with one deliberate change:
  - 16 dice on a 4 x 4 grid; faces contamination (1 in 6), defense (2 in 6), home,
    hospital, water (1 in 6 each);
  - after every roll, contamination is set aside and counted;
  - then the player must keep one type showing: defense (any number of times), or
    home, hospital or water (each only once per game); every die of that type is
    set aside;
  - then roll the dice still on the grid again (each stays in its own cell), or bank;
  - a keep that empties the grid ends the game ("emptied");
  - THE CHANGE (decision CT13): a roll that leaves nothing to keep ends the game
    ("stuck") and scores only 1 if defense covers contamination, otherwise 0, with
    no bonuses (House Dice scored it as a bank);
  - otherwise: pass if defense >= contamination; score = resources kept, +3 if all
    three resource types were kept, +1 if the grid was emptied, at least 1 on a
    pass, 0 on a fail.

  The dice (decision CT15): the face of the die in cell k (0 to 15, row by row) on
  roll j (1 = the opening roll) depends only on the seed, j and k (die_face), so
  players who part ways still face the same dice wherever both still have one.
  A daily game's seed is House Dice's string hash of "contagion:YYYY-MM-DD" (the
  America/Denver day), worked out here by seed_for_day.

  Faces: 0 contamination, 1 defense, 2 home, 3 hospital, 4 water.
  Moves: 0 roll, 1 bank, 2 defense, 3 home, 4 hospital, 5 water (the order of the
  lexicon's list of move words, decision CT14).

  Only whole numbers are used. Build: node scripts/build-engine.mjs
  (clang --target=wasm32, no libc).
*/

typedef unsigned int u32;
typedef unsigned long long u64;

#define ENGINE_VERSION 1
#define STD_VERSION 1
#define SIZE 16
#define MAX_MOVES 32
#define EMPTY 255

#define F_CONTAMINATION 0
#define F_DEFENSE 1
#define F_HOME 2
#define F_HOSPITAL 3
#define F_WATER 4

#define M_ROLL 0
#define M_BANK 1
#define MOVE_COUNT 6

#define P_KEEP 0
#define P_CHOOSE 1
#define P_OVER 2

#define E_NONE 0
#define E_BANK 1
#define E_EMPTIED 2
#define E_STUCK 3

#define MODE_NONE 0
#define MODE_DAILY 1
#define MODE_FREE 2

#define ALL_RESOURCES ((1 << F_HOME) | (1 << F_HOSPITAL) | (1 << F_WATER))

static const char *const FACE_NAME[5] = { "contamination", "defense", "home", "hospital", "water" };
static const char *const MOVE_NAME[MOVE_COUNT] = { "roll", "bank", "defense", "home", "hospital", "water" };
static const char *const ENDING_NAME[4] = { "", "bank", "emptied", "stuck" };
static const char *const MONTH_NAME[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

#define EXPORT(name) __attribute__((export_name(#name)))

/* ---- the dice ---- */
static u32 mix32(u32 x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

/* House Dice's die: r = 1 + floor(random * 6); 1 contamination, 2 or 3 defense,
   4 home, 5 hospital, 6 water. Here the random number comes from the seed, the
   roll and the cell only. */
static const unsigned char FACE_OF_DRAW[6] = { F_CONTAMINATION, F_DEFENSE, F_DEFENSE, F_HOME, F_HOSPITAL, F_WATER };

EXPORT(die_face) int die_face(u32 seed, int roll, int cell) {
  u32 x = mix32(mix32(seed) + (u32)(roll * SIZE + cell) * 0x9e3779b9u);
  u32 draw = (u32)(((u64)x * 6u) >> 32);
  return FACE_OF_DRAW[draw];
}

/* House Dice's seedFromString("contagion:YYYY-MM-DD"). */
EXPORT(seed_for_day) u32 seed_for_day(int year, int month, int day) {
  char s[24];
  int n = 0;
  const char *prefix = "contagion:";
  while (prefix[n]) { s[n] = prefix[n]; n++; }
  s[n++] = (char)('0' + (year / 1000) % 10);
  s[n++] = (char)('0' + (year / 100) % 10);
  s[n++] = (char)('0' + (year / 10) % 10);
  s[n++] = (char)('0' + year % 10);
  s[n++] = '-';
  s[n++] = (char)('0' + (month / 10) % 10);
  s[n++] = (char)('0' + month % 10);
  s[n++] = '-';
  s[n++] = (char)('0' + (day / 10) % 10);
  s[n++] = (char)('0' + day % 10);
  u32 hash = 0;
  for (int i = 0; i < n; i++) hash = hash * 31u + (unsigned char)s[i];
  return hash;
}

static int is_real_day(int year, int month, int day) {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return 0;
  static const unsigned char LENGTH[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
  int length = LENGTH[month - 1];
  if (month == 2 && ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0)) length = 29;
  return day <= length;
}

/* ---- game state ---- */
static u32 seed_;
static int mode_;
static int year_, month_, day_;
static unsigned char grid[SIZE];      /* a face, or EMPTY */
static unsigned char rolled[SIZE];    /* the face each die showed on the latest roll, or EMPTY */
static int kept_[5];
static int used_;                     /* resource faces kept, one bit per face */
static int roll_no;
static int phase_ = P_OVER;
static int ending_;
static int pass_, score_, resources_, full_set_, exhaustion_;
static int move_count;
static unsigned char move_list[MAX_MOVES];

static int dice_left(void) {
  int n = 0;
  for (int k = 0; k < SIZE; k++) if (grid[k] != EMPTY) n++;
  return n;
}

/* House Dice's contagionEligibleTypes, as moves: one bit per move code. */
static int eligible(void) {
  if (phase_ != P_KEEP) return 0;
  int present = 0;
  for (int k = 0; k < SIZE; k++) if (grid[k] != EMPTY) present |= 1 << grid[k];
  int mask = 0;
  if (present & (1 << F_DEFENSE)) mask |= 1 << (F_DEFENSE + 1);
  for (int f = F_HOME; f <= F_WATER; f++)
    if ((present & (1 << f)) && !(used_ & (1 << f))) mask |= 1 << (f + 1);
  return mask;
}

/* House Dice's computeContagionScore, with CT13's stuck ending and the real
   resource count on a fail (decision CT17). */
static void finish(int ending) {
  ending_ = ending;
  phase_ = P_OVER;
  resources_ = kept_[F_HOME] + kept_[F_HOSPITAL] + kept_[F_WATER];
  pass_ = kept_[F_DEFENSE] >= kept_[F_CONTAMINATION];
  full_set_ = 0;
  exhaustion_ = 0;
  if (ending == E_STUCK) {
    score_ = pass_ ? 1 : 0;
    return;
  }
  if (!pass_) {
    score_ = 0;
    return;
  }
  full_set_ = used_ == ALL_RESOURCES;
  exhaustion_ = ending == E_EMPTIED;
  score_ = resources_ + (full_set_ ? 3 : 0) + (exhaustion_ ? 1 : 0);
  if (score_ < 1) score_ = 1;
}

/* Roll every die still on the grid, set contamination aside, then either wait
   for a keep or end the game if nothing can be kept. */
static void roll_dice(void) {
  roll_no++;
  for (int k = 0; k < SIZE; k++) {
    if (grid[k] == EMPTY) { rolled[k] = EMPTY; continue; }
    grid[k] = (unsigned char)die_face(seed_, roll_no, k);
    rolled[k] = grid[k];
  }
  for (int k = 0; k < SIZE; k++) {
    if (grid[k] == F_CONTAMINATION) { kept_[F_CONTAMINATION]++; grid[k] = EMPTY; }
  }
  phase_ = P_KEEP;
  if (eligible() == 0) finish(E_STUCK);
}

static void start(u32 seed) {
  seed_ = seed;
  for (int k = 0; k < SIZE; k++) { grid[k] = F_DEFENSE; rolled[k] = EMPTY; }
  for (int f = 0; f < 5; f++) kept_[f] = 0;
  used_ = 0;
  roll_no = 0;
  ending_ = E_NONE;
  pass_ = score_ = resources_ = full_set_ = exhaustion_ = 0;
  move_count = 0;
  roll_dice();
}

EXPORT(start_daily) int start_daily(int year, int month, int day) {
  if (!is_real_day(year, month, day)) { phase_ = P_OVER; mode_ = MODE_NONE; return 0; }
  mode_ = MODE_DAILY;
  year_ = year; month_ = month; day_ = day;
  start(seed_for_day(year, month, day));
  return 1;
}

EXPORT(start_free) void start_free(u32 seed) {
  mode_ = MODE_FREE;
  start(seed);
}

/* One move; 1 done, 0 refused (nothing changes). */
EXPORT(move) int move(int code) {
  if (phase_ == P_OVER || move_count >= MAX_MOVES || code < 0 || code >= MOVE_COUNT) return 0;
  if (phase_ == P_KEEP) {
    if (!(eligible() & (1 << code))) return 0;
    int face = code - 1;
    move_list[move_count++] = (unsigned char)code;
    for (int k = 0; k < SIZE; k++) {
      if (grid[k] == face) { kept_[face]++; grid[k] = EMPTY; }
    }
    if (face != F_DEFENSE) used_ |= 1 << face;
    if (dice_left() == 0) finish(E_EMPTIED);
    else phase_ = P_CHOOSE;
    return 1;
  }
  /* P_CHOOSE */
  if (code == M_ROLL) {
    move_list[move_count++] = (unsigned char)code;
    roll_dice();
    return 1;
  }
  if (code == M_BANK) {
    move_list[move_count++] = (unsigned char)code;
    finish(E_BANK);
    return 1;
  }
  return 0;
}

/* ---- reading the game ---- */
EXPORT(engine_version) int engine_version(void) { return ENGINE_VERSION; }
EXPORT(grid_size) int grid_size(void) { return SIZE; }
EXPORT(max_moves) int max_moves(void) { return MAX_MOVES; }
EXPORT(phase) int phase(void) { return phase_; }
EXPORT(cell) int cell(int k) { return (k >= 0 && k < SIZE && grid[k] != EMPTY) ? grid[k] : -1; }
EXPORT(last_roll) int last_roll(int k) { return (k >= 0 && k < SIZE && rolled[k] != EMPTY) ? rolled[k] : -1; }
EXPORT(roll_number) int roll_number(void) { return roll_no; }
EXPORT(eligible_mask) int eligible_mask(void) { return eligible(); }
EXPORT(kept) int kept(int face) { return (face >= 0 && face < 5) ? kept_[face] : 0; }
EXPORT(used_mask) int used_mask(void) { return used_; }
EXPORT(ending) int ending(void) { return ending_; }
EXPORT(passed) int passed(void) { return pass_; }
EXPORT(score) int score(void) { return score_; }
EXPORT(resource_count) int resource_count(void) { return resources_; }
EXPORT(full_set_bonus) int full_set_bonus(void) { return full_set_; }
EXPORT(exhaustion_bonus) int exhaustion_bonus(void) { return exhaustion_; }
EXPORT(move_total) int move_total(void) { return move_count; }
EXPORT(move_at) int move_at(int i) { return (i >= 0 && i < move_count) ? move_list[i] : -1; }
EXPORT(game_seed) u32 game_seed(void) { return seed_; }
EXPORT(game_mode) int game_mode(void) { return mode_; }

/* ---- the standard questions (version 1) ----
   A host writes a saved game's moves (as numbers, one byte each, in the order of
   the lexicon's move words) at std_input(), then calls std_check_daily or
   std_check_free. 1: valid, and std_output() holds the full result as JSON (the
   record's fields as the game sends them). 0: not valid, and std_output() holds
   the reason in plain words. After a check, std_label() and std_line() write the
   game's label and one-line description there. Lengths in bytes (UTF-8). */
static unsigned char input_buf[MAX_MOVES];
static char out[2048];
static int out_len;

static void put_char(char c) { if (out_len < (int)sizeof(out)) out[out_len++] = c; }
static void put_str(const char *s) { while (*s) put_char(*s++); }
static void put_uint(u32 v) {
  char tmp[12];
  int n = 0;
  do { tmp[n++] = (char)('0' + v % 10u); v /= 10u; } while (v);
  while (n) put_char(tmp[--n]);
}
static void put_2(int v) { put_char((char)('0' + (v / 10) % 10)); put_char((char)('0' + v % 10)); }
static void put_quoted(const char *s) { put_char('"'); put_str(s); put_char('"'); }
static void put_bool(int b) { put_str(b ? "true" : "false"); }

static void put_label(void) {
  put_str("Contagion \xC2\xB7 ");
  if (mode_ == MODE_DAILY) {
    put_str("daily, ");
    put_str(MONTH_NAME[month_ - 1]);
    put_char(' ');
    put_uint((u32)day_);
  } else {
    put_str("free play");
  }
}

static void put_result(void) {
  put_str("{\"mode\":");
  if (mode_ == MODE_DAILY) {
    put_str("\"daily\",\"day\":\"");
    put_uint((u32)year_);
    put_char('-'); put_2(month_);
    put_char('-'); put_2(day_);
    put_char('"');
  } else {
    put_str("\"free\",\"seed\":");
    put_uint(seed_);
  }
  put_str(",\"moves\":[");
  for (int i = 0; i < move_count; i++) {
    if (i) put_char(',');
    put_quoted(MOVE_NAME[move_list[i]]);
  }
  put_str("],\"ending\":"); put_quoted(ENDING_NAME[ending_]);
  put_str(",\"kept\":{");
  for (int f = 0; f < 5; f++) {
    if (f) put_char(',');
    put_quoted(FACE_NAME[f]);
    put_char(':');
    put_uint((u32)kept_[f]);
  }
  put_str("},\"pass\":"); put_bool(pass_);
  put_str(",\"score\":"); put_uint((u32)score_);
  put_str(",\"resourceCount\":"); put_uint((u32)resources_);
  put_str(",\"fullSetBonus\":"); put_bool(full_set_);
  put_str(",\"exhaustionBonus\":"); put_bool(exhaustion_);
  put_str(",\"grid\":[");
  for (int k = 0; k < SIZE; k++) {
    if (k) put_char(',');
    put_quoted(grid[k] == EMPTY ? "empty" : FACE_NAME[grid[k]]);
  }
  put_str("]}");
}

EXPORT(std_version) int std_version(void) { return STD_VERSION; }
EXPORT(std_input) unsigned char *std_input(void) { return input_buf; }
EXPORT(std_input_cap) int std_input_cap(void) { return MAX_MOVES; }
EXPORT(std_output) char *std_output(void) { return out; }
EXPORT(std_output_len) int std_output_len(void) { return out_len; }

EXPORT(std_move_name) int std_move_name(int code) {
  out_len = 0;
  if (code >= 0 && code < MOVE_COUNT) put_str(MOVE_NAME[code]);
  return out_len;
}

static int refuse(const char *why, int index) {
  out_len = 0;
  put_str(why);
  if (index >= 0) {
    put_str(" (move ");
    put_uint((u32)index + 1u);
    if (input_buf[index] < MOVE_COUNT) { put_str(", "); put_str(MOVE_NAME[input_buf[index]]); }
    put_char(')');
  }
  return 0;
}

static int check_moves(int n) {
  if (n < 0 || n > MAX_MOVES) return refuse("too many moves", -1);
  for (int i = 0; i < n; i++) {
    if (input_buf[i] >= MOVE_COUNT) return refuse("not a move", i);
    if (phase_ == P_OVER) return refuse("a move after the game ended", i);
    if (!move(input_buf[i])) return refuse("a move the rules don't allow there", i);
  }
  if (phase_ != P_OVER) return refuse("the game isn't over after the last move", -1);
  out_len = 0;
  put_result();
  return 1;
}

EXPORT(std_check_daily) int std_check_daily(int year, int month, int day, int n) {
  if (!start_daily(year, month, day)) return refuse("not a real day", -1);
  return check_moves(n);
}

EXPORT(std_check_free) int std_check_free(u32 seed, int n) {
  start_free(seed);
  return check_moves(n);
}

/* The current game's result as JSON (the page builds its record from this), or
   nothing if the game isn't over. */
EXPORT(std_result) int std_result(void) {
  out_len = 0;
  if (phase_ == P_OVER && mode_ != MODE_NONE && ending_ != E_NONE) put_result();
  return out_len;
}

/* "Contagion · daily, Nov 24" or "Contagion · free play". */
EXPORT(std_label) int std_label(void) {
  out_len = 0;
  if (mode_ != MODE_NONE) put_label();
  return out_len;
}

/* "Contagion · daily, Nov 24: contained, score 7" / "…: containment failed". */
EXPORT(std_line) int std_line(void) {
  out_len = 0;
  if (mode_ == MODE_NONE || phase_ != P_OVER) return 0;
  put_label();
  if (pass_) { put_str(": contained, score "); put_uint((u32)score_); }
  else put_str(": containment failed");
  return out_len;
}
