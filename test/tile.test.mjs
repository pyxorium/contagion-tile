// The tile's files: the engine copies, the Game Host Kit's game helper, the manifest, the page's policy (no
// network), and records made from games checking through contagion-record.js's checkRecord (as a host would).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../tile/engine.js';
import { recordFromEngine, checkRecord, COLLECTION } from '../tile/contagion-record.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p));
// The Game Host Kit's folder: KIT_DIR, or next to this one (C:\thunderbird-cafe\game-host-kit).
const kitDir = process.env.KIT_DIR || path.join(root, '..', 'game-host-kit');
// Prism's folder, whose tile carries the same copy of the kit's helper (C:\thunderbird-cafe\prism-tile).
const prismDir = process.env.PRISM_DIR || path.join(root, '..', 'prism-tile');

test("the tile's engine.wasm and engine.js are exact copies of engine/", () => {
  assert.ok(read('tile', 'engine.wasm').equals(read('engine', 'engine.wasm')));
  assert.ok(read('tile', 'engine.js').equals(read('engine', 'engine.js')));
});

test("the tile's game-client.js is the kit's, byte for byte", { skip: existsSync(path.join(kitDir, 'game', 'game-client.js')) ? false : `the kit isn't at ${kitDir}` }, () => {
  assert.ok(read('tile', 'game-client.js').equals(readFileSync(path.join(kitDir, 'game', 'game-client.js'))));
});

test("the tile's game-client.js is the same as Prism's", { skip: existsSync(path.join(prismDir, 'tile', 'game-client.js')) ? false : `Prism isn't at ${prismDir}` }, () => {
  assert.ok(read('tile', 'game-client.js').equals(readFileSync(path.join(prismDir, 'tile', 'game-client.js'))));
});

test('the manifest', () => {
  const m = JSON.parse(read('tile', 'manifest.json'));
  assert.equal(m.name, 'Contagion');
  assert.ok(m.description.length > 20);
  assert.deepEqual(m.sizing, { width: 380, height: 540 });
});

test("the page's policy: no network, WebAssembly allowed", () => {
  const html = read('tile', 'index.html').toString();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  assert.match(csp, /default-src 'self' blob: data:;/);
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /connect-src|https?:/);
  const code = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /https?:\/\//, 'an address outside comments');
  assert.match(html, /CAST_MS = 1200, RED_MS = 2400, CALM_MS = 1600/, 'the pace (CT19)');
});

test('500 games become records that check; changed records are refused', async () => {
  const engine = await loadEngine(read('tile', 'engine.wasm'));
  const checker = await loadEngine(read('engine', 'engine.wasm'));
  assert.equal(COLLECTION, 'cafe.thunderbird.contagion.game');
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const records = [];
  for (let n = 0; n < 500; n++) {
    if (n % 5 === 0) engine.startDaily(`2026-11-${String(1 + (n % 28)).padStart(2, '0')}`);
    else engine.startFree(Math.floor(rand() * 4294967296));
    while (engine.state().phase !== 'over') {
      const s = engine.state();
      engine.move(s.phase === 'keep' ? s.eligible[Math.floor(rand() * s.eligible.length)] : rand() < 0.25 ? 'bank' : 'roll');
    }
    const record = recordFromEngine(engine);
    const check = checkRecord(checker, record);
    assert.equal(check.ok, true, `${JSON.stringify(record)}: ${check.problem}`);
    records.push(record);
  }
  const daily = records.find((r) => r.mode === 'daily' && r.ending === 'bank' && r.pass);
  const free = records.find((r) => r.mode === 'free' && r.resourceCount > 0);
  const refused = (r, why) => assert.equal(checkRecord(checker, r).ok, false, why);
  refused({ ...daily, score: daily.score + 1 }, 'a changed score');
  refused({ ...daily, pass: !daily.pass }, 'a changed pass');
  refused({ ...daily, fullSetBonus: !daily.fullSetBonus }, 'a changed bonus');
  refused({ ...daily, resourceCount: 0 }, 'resource count 0');
  refused({ ...daily, ending: 'emptied' }, 'a changed ending');
  refused({ ...daily, kept: { ...daily.kept, defense: daily.kept.defense + 1 } }, 'a changed tally');
  refused({ ...daily, grid: daily.grid.slice(1) }, 'a short grid');
  refused({ ...daily, grid: daily.grid.map((c) => (c === 'empty' ? 'water' : c)) }, 'a changed grid');
  refused({ ...daily, moves: daily.moves.slice(0, -1) }, 'a move dropped');
  refused({ ...daily, day: '2026-11-30' }, 'another day');
  refused({ ...daily, seed: 5 }, 'a daily game with a seed');
  refused({ ...free, day: '2026-11-24' }, 'free play with a day');
  refused({ ...free, mode: 'daily' }, 'free play called daily');
  refused({ ...free, seed: free.seed ^ 1 }, 'another seed');
  refused({ ...free, extra: 1 }, 'an extra field');
  refused({ ...free, kept: { ...free.kept, extra: 0 } }, 'an extra tally field');
  refused(null, 'nothing');
  refused([], 'a list');
  const { usedTypes, ...plain } = free;
  assert.equal(usedTypes, undefined, "no usedTypes (CT17)");
  assert.equal(checkRecord(checker, plain).ok, true);
});
