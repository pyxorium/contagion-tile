// Contagion's engine loader, shared by the tile's page, the tests and hosts. No imports of its own and no
// network: hand it engine.wasm's bytes.
//
//   const engine = await loadEngine(bytes);     // refuses a module that asks for anything, or is over 64 KB
//   engine.startDaily('2026-11-24');            // or engine.startFree(seed)
//   engine.state();                             // grid, last roll, phase, what can be kept, kept, moves, result parts
//   engine.move('defense');                     // true, or false if refused (nothing changes)
//   engine.result();                            // the record's fields once the game is over (CT17), else null
//   engine.label(), engine.line();              // "Contagion · daily, Nov 24", "…: contained, score 7"
//   engine.check({ mode, day | seed, moves })   // the standard question: { ok, result, label, line } | { ok: false, reason }
//
// Faces: contamination, defense, home, hospital, water. Moves are words, numbered in the lexicon's order:
// roll, bank, defense, home, hospital, water (the engine's own names, std_move_name, must match it). Cells
// 0 to 15, row by row from the top left.

export const FACES = ['contamination', 'defense', 'home', 'hospital', 'water'];
export const MOVES = ['roll', 'bank', 'defense', 'home', 'hospital', 'water'];
export const PHASES = ['keep', 'choose', 'over'];
export const ENDINGS = [null, 'bank', 'emptied', 'stuck'];
export const MAX_ENGINE_BYTES = 64 * 1024;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-24" → [2026, 11, 24], or null if it isn't a real calendar day. */
export function parseDay(day) {
  const m = typeof day === 'string' ? DAY.exec(day) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return [y, mo, d];
}

export async function loadEngine(bytes) {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!buf || buf.byteLength > MAX_ENGINE_BYTES) throw new Error('engine too big');
  const module = await WebAssembly.compile(buf);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('engine asks for imports');
  const instance = await WebAssembly.instantiate(module, {});
  return wrap(instance.exports);
}

const decoder = new TextDecoder();

function wrap(x) {
  const size = x.grid_size();
  const output = (len) => decoder.decode(new Uint8Array(x.memory.buffer, x.std_output(), len));
  const face = (f) => (f < 0 ? null : FACES[f]);
  const movesFromMask = (mask) => MOVES.filter((_, code) => mask & (1 << code));

  const api = {
    version: x.engine_version(),
    stdVersion: x.std_version(),
    size,
    maxMoves: x.max_moves(),
    /** The engine's own move words, in its order. */
    moveNames: Array.from({ length: MOVES.length + 1 }, (_, code) => output(x.std_move_name(code))).filter(Boolean),
    seedForDay(day) {
      const p = parseDay(day);
      if (!p) throw new Error('not a day');
      return x.seed_for_day(p[0], p[1], p[2]) >>> 0;
    },
    /** The face of the die in `cell` on roll `roll` (1 = the opening roll) for `seed`. */
    dieFace(seed, roll, cell) {
      return FACES[x.die_face(seed >>> 0, roll, cell)];
    },
    startDaily(day) {
      const p = parseDay(day);
      if (!p || x.start_daily(p[0], p[1], p[2]) !== 1) throw new Error('not a day');
    },
    startFree(seed) {
      x.start_free(seed >>> 0);
    },
    move(word) {
      const code = MOVES.indexOf(word);
      return code >= 0 && x.move(code) === 1;
    },
    state() {
      const grid = [], lastRoll = [], moves = [];
      for (let k = 0; k < size; k++) {
        grid.push(face(x.cell(k)));
        lastRoll.push(face(x.last_roll(k)));
      }
      for (let i = 0; i < x.move_total(); i++) moves.push(MOVES[x.move_at(i)]);
      const kept = {};
      FACES.forEach((f, i) => { kept[f] = x.kept(i); });
      return {
        phase: PHASES[x.phase()],
        grid, lastRoll, roll: x.roll_number(),
        eligible: movesFromMask(x.eligible_mask()),
        kept,
        used: FACES.filter((_, i) => x.used_mask() & (1 << i)),
        moves,
        ending: ENDINGS[x.ending()],
        pass: x.passed() === 1,
        score: x.score(),
        resourceCount: x.resource_count(),
        fullSetBonus: x.full_set_bonus() === 1,
        exhaustionBonus: x.exhaustion_bonus() === 1,
      };
    },
    result() {
      const len = x.std_result();
      return len ? JSON.parse(output(len)) : null;
    },
    label() {
      return output(x.std_label());
    },
    line() {
      return output(x.std_line());
    },
    /** The standard question: the essentials of a saved game → its full result, label and line, or a reason. */
    check(game) {
      const fail = (reason) => ({ ok: false, reason });
      if (!game || typeof game !== 'object') return fail('not a game');
      const moves = game.moves;
      if (!Array.isArray(moves)) return fail('no moves');
      if (moves.length > x.std_input_cap()) return fail('too many moves');
      const codes = moves.map((w) => MOVES.indexOf(w));
      if (codes.some((c) => c < 0)) return fail('not a move');
      new Uint8Array(x.memory.buffer, x.std_input(), codes.length).set(codes);
      let ok;
      if (game.mode === 'daily' && game.seed === undefined) {
        const p = parseDay(game.day);
        if (!p) return fail('not a real day');
        ok = x.std_check_daily(p[0], p[1], p[2], codes.length);
      } else if (game.mode === 'free' && game.day === undefined && Number.isInteger(game.seed) && game.seed >= 0 && game.seed <= 0xffffffff) {
        ok = x.std_check_free(game.seed, codes.length);
      } else {
        return fail('a daily game needs a day and no seed; free play needs a seed and no day');
      }
      const text = output(x.std_output_len());
      if (ok !== 1) return fail(text);
      return { ok: true, result: JSON.parse(text), label: api.label(), line: api.line() };
    },
  };
  return api;
}
