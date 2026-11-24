// Reads a saved record (JSON) on stdin and checks it against engine/engine.wasm: prints "ok" or the problem.
//   node test/browser/replay-record.mjs < record.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../../engine/engine.js';
import { checkRecord } from '../../tile/contagion-record.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await loadEngine(readFileSync(path.join(root, 'engine', 'engine.wasm')));
const full = JSON.parse(readFileSync(0, 'utf8'));
const { $type, game, createdAt, engine: engineCid, ...record } = full;
const check = checkRecord(engine, record);
console.log(check.ok ? 'ok' : check.problem);
