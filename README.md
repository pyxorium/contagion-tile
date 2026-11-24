# Contagion (web tile)

A push-your-luck dice web tile: [House Dice](https://pyxorium.tngl.io/dicestreak/)'s Contagion, with
seeded dice. Its rules run as a small WebAssembly engine, `engine/engine.wasm`, which the tile's page will
play through and which any host can ask to check a saved game, so the host keeps no copy of the rules.

**Status:** the engine (stage 1) and the tile's page (stage 2) built Nov 24 2026. Sounds, the lexicon,
publishing and saving in Raku come next.

## The rules

16 dice on a 4 × 4 grid. Faces: contamination 🦠 (1 in 6), defense ⚗️ (2 in 6), home 🏠, hospital 🏥 and
water 🚰 (1 in 6 each).

- After every roll, contamination is set aside and counted.
- Then you must keep one type showing: defense (any number of times), or home, hospital or water (each
  only once per game). Every die of that type is set aside.
- Then roll the dice still on the grid again (each stays in its own cell), or bank.
- The game ends when you bank, when a keep empties the grid, or when a roll leaves nothing you can keep.
- **Score:** if defense covers contamination (defense ≥ contamination), the resources you kept, +3 if you
  kept all three resource types, +1 if you emptied the grid, at least 1; otherwise 0.
- **One change from House Dice:** a roll that leaves nothing to keep scores only 1 if defense covers
  contamination, otherwise 0, with no bonuses (House Dice scored it as a bank). In House Dice's rules,
  pushing on was almost always right, so Bank hardly mattered; with this rule, knowing when to stop does
  (`scripts/simulate.mjs`).

## The dice

The face of the die in cell *k* (0 to 15, row by row) on roll *j* (1 is the opening roll) depends only on
the seed, *j* and *k*. Two players on the same daily game who make different choices still face the same
dice wherever both still have one. The daily game's seed is House Dice's string hash of `contagion:` + the
America/Denver day (`seed_for_day` in the engine); free play uses any 32-bit seed. Whole numbers only.

## The engine

- `engine/contagion.c`: the rules, in C (no imports, so it asks its host for nothing).
- `engine/engine.wasm`: built from it with clang 18.1.3 (17,794 bytes,
  `bafkreifms2aawbaemihyu7jnvk6zmpv3iuxsqcsjozo7brvdk5j4t5vrta`).
- `engine/engine.js`: a small loader for the page, the tests and hosts (`loadEngine(bytes)`,
  `startDaily('2026-11-24')` / `startFree(seed)`, `state()`, `move('defense')`, `result()`, `label()`,
  `line()`, `check(game)`).
- `reference/contagion-ref.mjs`: House Dice's own Contagion functions, with only the dice and the stuck rule
  changed: the JavaScript reference the engine must match.

**Moves** are words: `roll`, `bank`, `defense`, `home`, `hospital`, `water`. The engine numbers them 0 to 5
in that order, which is also the order of the record lexicon's list of moves. The opening roll isn't a move.
A game alternates a keep, then roll or bank; a game that ends stuck ends on `roll`; at most 32 moves.

**The standard questions** (for hosts; version 1, `std_version`):
- Write the moves as numbers, one byte each, at `std_input()`, then call `std_check_daily(year, month,
  day, count)` or `std_check_free(seed, count)`. 1 means valid, and `std_output()` holds the full result as
  JSON, `std_output_len()` bytes: the record's fields exactly as the game sends them. 0 means not valid, and
  the output holds the reason in plain words.
- Then `std_label()` and `std_line()` write the game's label and a one-line description to the output
  ("Contagion · daily, Nov 24", "Contagion · daily, Nov 24: contained, score 7").
- `std_move_name(code)` gives the engine's word for a move number.

**The result** (what a finished game sends to save): `mode` (`daily` or `free`); `day` (daily) or `seed`
(free play), never both; `moves`; `ending` (`bank`, `emptied` or `stuck`); `kept` (contamination, defense,
home, hospital, water); `pass`; `score`; `resourceCount` (what was really kept, also on a fail);
`fullSetBonus`; `exhaustionBonus`; `grid` (16 strings, row by row: a face, or `empty`).

## The tile (`tile\`)

What will be published as the web tile:

- `index.html`: the game. It never decides anything itself: it asks the engine for the grid, what can be kept
  and the result, and tells it each move. House Dice's Contagion look (the yellow room, the black board, the
  tally, the cream dice, the spin, the red pulse for contamination, the calm pulse for a keep), at a quicker pace:
  the spin 1.2 s, contamination 2.4 s, a keep 1.6 s, the buttons back after each pulse. The dice follow the
  frame; in a short frame (a tile post's card) the buttons stand beside the grid. With reduced motion nothing
  spins or pulses. Daily and Free play; after a daily game, Play again starts free play and the Daily button
  shows the finished daily (a reload brings the daily back). How to play behind the "?".
- `engine.wasm`, `engine.js`: exact copies of `engine\` (a test checks).
- `contagion-record.js`: the record a finished game sends to save (the engine's own result) and the check a
  host can run on one (`checkRecord`: ask the engine the standard question and compare every field).
- `game-client.js`: an exact copy of the Game Host Kit's game helper (a test checks it against Prism's copy, and
  against the kit when it's next to this folder).
- `manifest.json` (name, description, 380 × 540), `icon.png` (256 px; the dice use the Noto Color Emoji font).

For checks: `?seed=…` picks a free-play seed.

## Checks

`npm test` (no packages needed; about 10 seconds): the engine asks for no imports; daily seeds match the
reference for every day of 2026 to 2028; each die depends only on the seed, the roll and the cell, with
House Dice's odds; **100,000 games played side by side, engine and reference identical after every move**
(illegal tries refused by both and changing nothing); every finished game checks to its own result, label
and line; tampered, unfinished and malformed games refused; and ten copies of the engine, each with one rule
broken, all caught (this one needs clang, and is skipped without it). `CONTAGION_GAMES=2000` for a quick run.

`test/tile.test.mjs` (in `npm test`): the tile's copies, the manifest, the page's policy (no network), and 500
games whose records check, with changed records refused.

`python test/browser/check_tile.py` (Playwright with Chromium; about 4 minutes): the page on its own at four
sizes (380 × 540, 340 × 300, 300 × 250, a phone), the pace, reduced motion, and in a stand-in host
(`test/browser/host.html`, speaking the kit's messages and checking each game with the engine before asking): a
daily game saved and checked again in Node, See it, the nudge after a daily, free play saved with its seed, a
declined save, a tampered record refused, a host that doesn't save Contagion, a guest, How to play, and nothing
fetched from outside.

`npm run check-engine` rebuilds the engine to a temporary file and says whether it matches the committed
one (needs clang 18.1.3). `npm run simulate` plays 30,000 games per bot through the engine.

## Credit

Contagion is a game from House Dice by pyxorium (https://pyxorium.tngl.io/dicestreak/).
