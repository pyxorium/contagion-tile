#!/usr/bin/env node
// Plays many games through the real engine with a few bots, to see how the rules play (decision CT13).
//
//   node scripts/simulate.mjs              (30,000 games per bot; CONTAGION_SIM_GAMES to change)
//
// "best play" is exact: before playing, it works out the best average score from every position (how many dice
// are left, defense minus contamination, resources kept, which resource types are used), then always takes the
// move with the higher average. The others: "never banks" (best keeps, always rolls), "banks once safe" (best
// keeps, banks as soon as defense covers contamination), "random". Bots, not people: a rough guide only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../engine/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = await loadEngine(readFileSync(path.join(root, 'engine', 'engine.wasm')));
const GAMES = Number(process.env.CONTAGION_SIM_GAMES || 30000);

// ---- the exact solver (the rules as decided: CT13's stuck ending) ----
const RES = ['home', 'hospital', 'water'];
const fact = [1];
for (let i = 1; i <= 16; i++) fact[i] = fact[i - 1] * i;
const outcomes = [];
for (let n = 0; n <= 16; n++) {
  outcomes[n] = [];
  for (let c = 0; c <= n; c++) for (let d = 0; d <= n - c; d++) for (let h = 0; h <= n - c - d; h++) for (let o = 0; o <= n - c - d - h; o++) {
    const w = n - c - d - h - o;
    const p = (fact[n] / (fact[c] * fact[d] * fact[h] * fact[o] * fact[w])) * (1 / 6) ** c * (2 / 6) ** d * (1 / 6) ** (h + o + w);
    outcomes[n].push([c, d, h, o, w, p]);
  }
}
const finalScore = (m, R, used, emptied) => (m < 0 ? 0 : Math.max(R + (used === 7 ? 3 : 0) + (emptied ? 1 : 0), 1));
const stuckScore = (m) => (m >= 0 ? 1 : 0);
const memo = new Map();
const key = (...a) => a.join(',');
function after(n, m, R, used) {
  if (n === 0) return { value: finalScore(m, R, used, true), choice: 'end' };
  const bank = finalScore(m, R, used, false);
  const roll = rollValue(n, m, R, used);
  return roll > bank ? { value: roll, choice: 'roll' } : { value: bank, choice: 'bank' };
}
function rollValue(n, m, R, used) {
  const k = key('r', n, m, R, used);
  if (memo.has(k)) return memo.get(k);
  let ev = 0;
  for (const [c, d, h, o, w, p] of outcomes[n]) ev += p * take(n - c, m - c, R, used, [d, h, o, w]).value;
  memo.set(k, ev);
  return ev;
}
function take(n, m, R, used, [d, h, o, w]) {
  const k = key('t', n, m, R, used, d, h, o, w);
  if (memo.has(k)) return memo.get(k);
  const options = [];
  if (d) options.push({ word: 'defense', value: after(n - d, m + d, R, used).value });
  [h, o, w].forEach((count, i) => {
    if (count && !(used & (1 << i))) options.push({ word: RES[i], value: after(n - count, m, R + count, used | (1 << i)).value });
  });
  const best = options.length ? options.reduce((a, b) => (b.value > a.value ? b : a)) : { word: null, value: stuckScore(m) };
  memo.set(k, best);
  return best;
}
function position(s) {
  const n = s.grid.filter(Boolean).length;
  const m = s.kept.defense - s.kept.contamination;
  const R = s.kept.home + s.kept.hospital + s.kept.water;
  const used = RES.reduce((acc, t, i) => acc | (s.used.includes(t) ? 1 << i : 0), 0);
  const count = (f) => s.grid.filter((x) => x === f).length;
  return { n, m, R, used, counts: [count('defense'), count('home'), count('hospital'), count('water')] };
}
const bestKeep = (s) => { const p = position(s); return take(p.n, p.m, p.R, p.used, p.counts).word; };
const bestChoice = (s) => { const p = position(s); return after(p.n, p.m, p.R, p.used).choice; };

let r = 12345;
const rand = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
const BOTS = {
  'best play': { keep: bestKeep, choose: bestChoice },
  'never banks': { keep: bestKeep, choose: () => 'roll' },
  'banks once safe': { keep: bestKeep, choose: (s) => (s.kept.defense >= s.kept.contamination ? 'bank' : 'roll') },
  random: { keep: (s) => s.eligible[Math.floor(rand() * s.eligible.length)], choose: () => (rand() < 0.5 ? 'bank' : 'roll') },
};

console.log(`Best play's exact average from the start: ${rollValue(16, 0, 0, 0).toFixed(2)}`);
console.log(`${GAMES} games per bot, through engine.wasm:\n`);
console.log('bot              | average | pass | full set | all dice | ends: bank / emptied / stuck');
for (const [name, bot] of Object.entries(BOTS)) {
  let total = 0, pass = 0, full = 0, emptied = 0;
  const ends = { bank: 0, emptied: 0, stuck: 0 };
  for (let g = 0; g < GAMES; g++) {
    engine.startFree(Math.floor(rand() * 4294967296));
    let s = engine.state();
    while (s.phase !== 'over') {
      if (!engine.move(s.phase === 'keep' ? bot.keep(s) : bot.choose(s))) throw new Error('a bot move was refused');
      s = engine.state();
    }
    total += s.score;
    pass += s.pass;
    full += s.fullSetBonus;
    emptied += s.ending === 'emptied';
    ends[s.ending]++;
  }
  const pc = (x) => `${Math.round((x / GAMES) * 100)}%`.padStart(4);
  console.log(`${name.padEnd(16)} | ${(total / GAMES).toFixed(2).padStart(7)} | ${pc(pass)} | ${pc(full).padStart(8)} | ${pc(emptied).padStart(8)} | ${pc(ends.bank)} / ${pc(ends.emptied)} / ${pc(ends.stuck)}`);
}
