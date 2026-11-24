// The wasm engine against the JavaScript reference (House Dice's Contagion with CT13 and CT15), move for move.
//
//   npm test                         (CONTAGION_GAMES=100000 by default; set it lower for a quick run)
//
// Also: the dice (each die fixed by seed, roll and cell; House Dice's odds), daily seeds, the standard
// questions (check, label, line) agreeing with play, tampered and unfinished games refused, no imports, and
// copies of the engine with one rule broken caught (those need clang and are skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEngine, parseDay, MOVES as ENGINE_MOVES } from '../engine/engine.js';
import { ContagionGame, seedForDay, dieFace, MOVES } from '../reference/contagion-ref.mjs';
import { CLANG_ARGS } from '../scripts/build-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = path.join(root, 'engine', 'engine.wasm');
const sourcePath = path.join(root, 'engine', 'contagion.c');
const GAMES = Number(process.env.CONTAGION_GAMES || 100000);

/** A small seeded generator for choosing test moves (not the game's dice). */
function driver(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function refState(g) {
  const r = g.outcome || { pass: false, score: 0, resourceCount: 0, fullSetBonus: false, exhaustionBonus: false };
  return {
    phase: g.phase,
    grid: [...g.grid],
    lastRoll: [...g.lastRoll],
    roll: g.rollNumber,
    eligible: g.eligible(),
    kept: { ...g.kept },
    used: ['home', 'hospital', 'water'].filter((t) => g.usedTypes.has(t)),
    moves: [...g.moves],
    ending: g.ending,
    pass: r.pass,
    score: r.score,
    resourceCount: r.resourceCount,
    fullSetBonus: r.fullSetBonus,
    exhaustionBonus: r.exhaustionBonus,
  };
}

const randomDay = (rand) => {
  const y = 2026 + Math.floor(rand() * 3), m = 1 + Math.floor(rand() * 12), d = 1 + Math.floor(rand() * 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Plays `games` games through both, with a mix of styles; returns totals. Throws on any difference. */
function playSideBySide(engine, games, driverSeed) {
  const rand = driver(driverSeed);
  const totals = { moves: 0, endings: { bank: 0, emptied: 0, stuck: 0 } };
  for (let n = 0; n < games; n++) {
    const game = n % 10 === 0 ? { day: randomDay(rand) } : { seed: Math.floor(rand() * 4294967296) };
    const ref = new ContagionGame(game);
    if (game.day) engine.startDaily(game.day);
    else engine.startFree(game.seed);
    assert.deepEqual(engine.state(), refState(ref), `game ${n} (${JSON.stringify(game)}) at the start`);
    const bankChance = [0, 0.1, 0.3, 0.6][n % 4]; // never banks, rarely, sometimes, often
    while (ref.phase !== 'over') {
      // An illegal try: refused by both, nothing changes.
      if (rand() < 0.3) {
        const word = rand() < 0.05 ? 'jump' : MOVES[Math.floor(rand() * MOVES.length)];
        const legal = ref.phase === 'keep' ? ref.eligible() : ['roll', 'bank'];
        if (!legal.includes(word)) {
          const before = engine.state();
          assert.equal(engine.move(word), false, `game ${n}: ${word} accepted in phase ${ref.phase}`);
          assert.equal(ref.move(word), false);
          assert.deepEqual(engine.state(), before, `game ${n}: an illegal move changed something`);
        }
      }
      let word;
      if (ref.phase === 'keep') {
        const eligible = ref.eligible();
        word = eligible[Math.floor(rand() * eligible.length)];
      } else {
        word = rand() < bankChance ? 'bank' : 'roll';
      }
      assert.equal(engine.move(word), true, `game ${n}: ${word} refused`);
      assert.equal(ref.move(word), true);
      totals.moves++;
      assert.deepEqual(engine.state(), refState(ref), `game ${n} (${JSON.stringify(game)}) after move ${ref.moves.length}`);
    }
    for (const word of MOVES) assert.equal(engine.move(word), false, 'a move after the end');
    assert.deepEqual(engine.result(), ref.result(), `game ${n}: the result`);
    assert.equal(JSON.stringify(engine.result()), JSON.stringify(ref.result()), `game ${n}: the result's field order`);
    assert.equal(engine.label(), ref.label());
    assert.equal(engine.line(), ref.line());
    totals.endings[ref.ending]++;
  }
  return totals;
}

const engine = await loadEngine(readFileSync(wasmPath));

test('the engine asks for nothing, is small, and names its moves in the lexicon order', () => {
  const bytes = readFileSync(wasmPath);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
  assert.ok(bytes.length < 32 * 1024, `engine.wasm is ${bytes.length} bytes`);
  assert.equal(engine.version, 1);
  assert.equal(engine.stdVersion, 1);
  assert.equal(engine.size, 16);
  assert.deepEqual(engine.moveNames, MOVES);
  assert.deepEqual(ENGINE_MOVES, MOVES);
});

test('daily seeds match the reference for every day of 2026 to 2028', () => {
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    assert.equal(engine.seedForDay(day), seedForDay(day), day);
  }
  assert.equal(seedForDay('2026-11-24'), engine.seedForDay('2026-11-24'));
  assert.equal(parseDay('2026-02-29'), null);
  assert.deepEqual(parseDay('2028-02-29'), [2028, 2, 29]);
});

test('each die depends only on the seed, the roll and the cell, with House Dice\'s odds', () => {
  const rand = driver(7);
  const counts = { contamination: 0, defense: 0, home: 0, hospital: 0, water: 0 };
  let draws = 0;
  for (let n = 0; n < 3000; n++) {
    const seed = Math.floor(rand() * 4294967296);
    for (let roll = 1; roll <= 16; roll++) {
      for (let cell = 0; cell < 16; cell++) {
        const f = engine.dieFace(seed, roll, cell);
        assert.equal(f, dieFace(seed, roll, cell));
        counts[f]++;
        draws++;
      }
    }
  }
  for (const [f, expected] of Object.entries({ contamination: 1 / 6, defense: 2 / 6, home: 1 / 6, hospital: 1 / 6, water: 1 / 6 })) {
    assert.ok(Math.abs(counts[f] / draws - expected) < 0.005, `${f}: ${(counts[f] / draws).toFixed(4)}`);
  }
  // Two players on the same day who part ways still see the same die wherever both roll it.
  let shared = 0;
  for (let n = 0; n < 2000; n++) {
    const day = randomDay(rand);
    const seen = new Map();
    const play = (pick, compare) => {
      const g = new ContagionGame({ day });
      const look = () => g.lastRoll.forEach((f, cell) => {
        if (f == null) return;
        const key = `${g.rollNumber}:${cell}`;
        if (!compare) seen.set(key, f);
        else if (seen.has(key)) { assert.equal(f, seen.get(key), `${day} roll:cell ${key}`); shared++; }
      });
      look();
      while (g.phase !== 'over') {
        if (g.phase === 'keep') g.move(pick(g.eligible()));
        else { g.move('roll'); look(); }
      }
    };
    play((e) => e[0], false);
    play((e) => e[e.length - 1], true);
  }
  assert.ok(shared > 10000, `only ${shared} shared dice compared`);
});

test(`${GAMES} games: engine and reference identical after every move`, () => {
  const totals = playSideBySide(engine, GAMES, 1);
  console.log(`  ${GAMES} games, ${totals.moves} moves; endings: bank ${totals.endings.bank}, emptied ${totals.endings.emptied}, stuck ${totals.endings.stuck}`);
  assert.ok(totals.endings.bank && totals.endings.emptied && totals.endings.stuck, 'every ending happened');
});

test('the standard questions: every finished game checks to its own result, label and line', () => {
  const rand = driver(2);
  for (let n = 0; n < 3000; n++) {
    const game = n % 2 ? { day: randomDay(rand) } : { seed: Math.floor(rand() * 4294967296) };
    const ref = new ContagionGame(game);
    while (ref.phase !== 'over') {
      if (ref.phase === 'keep') { const e = ref.eligible(); ref.move(e[Math.floor(rand() * e.length)]); }
      else ref.move(rand() < 0.2 ? 'bank' : 'roll');
    }
    const record = ref.result();
    const essentials = record.mode === 'daily'
      ? { mode: 'daily', day: record.day, moves: record.moves }
      : { mode: 'free', seed: record.seed, moves: record.moves };
    const answer = engine.check(essentials);
    assert.equal(answer.ok, true, `${JSON.stringify(essentials)}: ${answer.reason}`);
    assert.deepEqual(answer.result, record);
    assert.equal(answer.label, ref.label());
    assert.equal(answer.line, ref.line());
  }
});

test('the standard questions: tampered, unfinished and malformed games refused', () => {
  // Find a free-play game that banks after a few rolls, and one that ends stuck.
  let banked, stuck;
  for (let seed = 1; !(banked && stuck); seed++) {
    const g = new ContagionGame({ seed });
    let rolls = 0;
    while (g.phase !== 'over') {
      if (g.phase === 'keep') g.move(g.eligible()[0]);
      else g.move(rolls++ < 2 ? 'roll' : 'bank');
    }
    if (!banked && g.ending === 'bank' && g.moves.length >= 6) banked = g.result();
    const h = new ContagionGame({ seed });
    while (h.phase !== 'over') h.move(h.phase === 'keep' ? h.eligible()[h.eligible().length - 1] : 'roll');
    if (!stuck && h.ending === 'stuck' && h.moves.length >= 4) stuck = h.result();
  }
  const ok = (g) => engine.check(g).ok;
  const free = (moves, seed = banked.seed) => ({ mode: 'free', seed, moves });
  assert.ok(ok(free(banked.moves)));
  assert.ok(ok(free(stuck.moves, stuck.seed)));

  assert.equal(ok(free(banked.moves.slice(0, -1))), false, 'unfinished');
  assert.equal(ok(free([...banked.moves, 'roll'])), false, 'a move after the end');
  assert.equal(ok(free(['bank', ...banked.moves])), false, 'a bank before a keep');
  assert.equal(ok(free(['roll', ...banked.moves])), false, 'a roll before a keep');
  assert.equal(ok(free(['defense', 'defense', ...banked.moves.slice(1)])), false, 'two keeps in a row');
  assert.equal(ok(free(banked.moves.map((m) => (m === 'roll' ? 'jump' : m)))), false, 'a word that isn\'t a move');
  assert.equal(stuck.moves.at(-1), 'roll', 'a stuck game ends on a roll');
  assert.equal(ok(free(stuck.moves.slice(0, -1), stuck.seed)), false, 'a stuck game without its last roll is unfinished');
  assert.equal(ok(free(Array(33).fill('roll'))), false, 'too many moves');
  assert.equal(engine.check(free(banked.moves)).ok, true);

  // A resource kept twice: replay a game that keeps a resource, then try keeping it again later.
  for (let seed = 1; seed < 5000; seed++) {
    const g = new ContagionGame({ seed });
    if (g.phase !== 'keep' || !g.eligible().includes('home')) continue;
    g.move('home');
    if (g.phase !== 'choose') continue;
    g.move('roll');
    if (g.phase !== 'keep' || !g.grid.includes('home')) continue;
    assert.equal(ok(free(['home', 'roll', 'home', 'bank'], seed)), false, 'home kept twice');
    break;
  }
  // A type that isn't on the dice.
  for (let seed = 1; seed < 5000; seed++) {
    const g = new ContagionGame({ seed });
    if (g.phase === 'keep' && !g.grid.includes('water')) {
      assert.equal(ok(free(['water', 'bank'], seed)), false, 'water not showing');
      break;
    }
  }

  // Mode fields.
  const daily = { mode: 'daily', day: '2026-11-24', moves: [] };
  assert.equal(engine.check({ ...daily, seed: 5 }).ok, false, 'a daily game carrying a seed');
  assert.equal(engine.check({ mode: 'free', seed: 5, day: '2026-11-24', moves: [] }).ok, false, 'free play carrying a day');
  assert.equal(engine.check({ mode: 'free', moves: [] }).ok, false, 'free play without a seed');
  assert.equal(engine.check({ mode: 'free', seed: -1, moves: [] }).ok, false, 'a negative seed');
  assert.equal(engine.check({ mode: 'free', seed: 2 ** 32, moves: [] }).ok, false, 'a seed too big');
  assert.equal(engine.check({ mode: 'daily', day: '2026-02-30', moves: [] }).ok, false, 'not a real day');
  assert.equal(engine.check({ mode: 'weekly', day: '2026-11-24', moves: [] }).ok, false, 'not a mode');
  assert.match(engine.check({ mode: 'daily', day: '2026-02-30', moves: [] }).reason, /not a real day/);
  assert.match(engine.check(free(['bank'])).reason, /move 1, bank/);
});

test('the result has only strings, whole numbers and booleans, and a daily result its day', () => {
  const answer = (() => {
    const g = new ContagionGame({ day: '2026-11-24' });
    while (g.phase !== 'over') g.move(g.phase === 'keep' ? g.eligible()[0] : 'roll');
    return engine.check({ mode: 'daily', day: '2026-11-24', moves: g.moves });
  })();
  assert.equal(answer.ok, true);
  assert.equal(answer.result.day, '2026-11-24');
  assert.equal(answer.result.seed, undefined);
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') return Object.values(v).forEach(walk);
    assert.ok(typeof v === 'string' || typeof v === 'boolean' || Number.isInteger(v), `bad value ${v}`);
  };
  walk(answer.result);
  assert.equal(answer.result.grid.length, 16);
  assert.match(answer.label, /^Contagion · daily, Nov 24$/);
});

function hasClang() {
  try {
    execFileSync(process.env.CLANG || 'clang', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BREAKS = [
  ['the stuck rule (CT13), scored as a bank', 'if (ending == E_STUCK) {\n    score_ = pass_ ? 1 : 0;\n    return;\n  }', ''],
  ['the full-set bonus', '(full_set_ ? 3 : 0)', '(full_set_ ? 2 : 0)'],
  ['the all-dice bonus', '(exhaustion_ ? 1 : 0)', '(exhaustion_ ? 2 : 0)'],
  ['the pass rule', 'pass_ = kept_[F_DEFENSE] >= kept_[F_CONTAMINATION];', 'pass_ = kept_[F_DEFENSE] > kept_[F_CONTAMINATION];'],
  ['a pass scoring at least 1', 'if (score_ < 1) score_ = 1;', ''],
  ['resources only once', 'if (face != F_DEFENSE) used_ |= 1 << face;', ''],
  ['the faces\' odds', '{ F_CONTAMINATION, F_DEFENSE, F_DEFENSE, F_HOME, F_HOSPITAL, F_WATER }', '{ F_CONTAMINATION, F_CONTAMINATION, F_DEFENSE, F_HOME, F_HOSPITAL, F_WATER }'],
  ['the roll number in the dice', '(u32)(roll * SIZE + cell)', '(u32)(cell)'],
  ['the daily seed\'s name', '"contagion:"', '"contagio:"'],
  ['the real resource count on a fail', 'if (!pass_) {\n    score_ = 0;', 'if (!pass_) {\n    score_ = 0; resources_ = 0;'],
];

test('a copy of the engine with one rule broken is caught', { skip: hasClang() ? false : 'clang not found' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contagion-break-'));
  try {
    const source = readFileSync(sourcePath, 'utf8');
    for (const [name, from, to] of BREAKS) {
      assert.ok(source.includes(from), `can't find ${name} in contagion.c`);
      const src = path.join(dir, 'broken.c');
      const out = path.join(dir, 'broken.wasm');
      writeFileSync(src, source.replace(from, to));
      execFileSync(process.env.CLANG || 'clang', [...CLANG_ARGS, '-o', out, src], { stdio: 'ignore' });
      const broken = await loadEngine(readFileSync(out));
      assert.throws(() => playSideBySide(broken, 2000, 99), `breaking ${name} wasn't caught`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
