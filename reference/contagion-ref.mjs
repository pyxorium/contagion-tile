// The JavaScript reference for Contagion's engine: House Dice's own Contagion functions (main.jsx), with only
// these changes, all deliberate (see claude/contagion-tile-plan.md):
// - CT15, the dice: rollContagionDie draws from the seed, the roll number and the cell (dieFace) instead of
//   Math.random(); the mapping of 1 to 6 onto faces is House Dice's.
// - CT13, nothing to keep: checkContagionEligibility no longer scores a stuck game as a bank; it scores 1 if
//   defense covers contamination, otherwise 0, with no bonuses.
// - CT17, the record: resourceCount is the real count also on a fail; `ending` is added; House Dice's
//   usedTypes, date and createdAt aren't part of the result (the host adds createdAt).
// House Dice's timers, pulses and animation (setTimeout, motion, casting) aren't rules and aren't here.
// computeContagionScore and contagionEligibleTypes below are copied unchanged.

export const CONTAGION_GRID_SIZE = 16; // 4x4
export const CONTAGION_SYMBOLS = ['contamination', 'defense', 'home', 'hospital', 'water'];
export const CONTAGION_RESOURCE_TYPES = ['home', 'hospital', 'water'];
/** The move words, in the lexicon's order (CT14). */
export const MOVES = ['roll', 'bank', 'defense', 'home', 'hospital', 'water'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- the dice (CT15) ----
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
/** A number in [0, 1) from the seed, the roll (1 = the opening roll) and the cell (0 to 15). */
function dieRandom(seed, roll, cell) {
  const x = mix32((mix32(seed >>> 0) + Math.imul(roll * CONTAGION_GRID_SIZE + cell, 0x9e3779b9)) >>> 0);
  return x / 4294967296;
}
/** House Dice's rollContagionDie, with the seeded number in place of Math.random(). */
export function dieFace(seed, roll, cell) {
  const r = 1 + Math.floor(dieRandom(seed, roll, cell) * 6);
  if (r === 1) return 'contamination';
  if (r === 2 || r === 3) return 'defense'; // most common face — the renewable countermeasure
  if (r === 4) return 'home';
  if (r === 5) return 'hospital';
  return 'water';
}

// House Dice's seedFromString, for the daily seed: "contagion:" + the America/Denver day.
export function seedFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}
export const seedForDay = (day) => seedFromString(`contagion:${day}`);

// ---- copied unchanged from House Dice ----
export function contagionEligibleTypes(pool, usedTypes) {
  const present = new Set(pool);
  const eligible = [];
  if (present.has('defense')) eligible.push('defense');
  CONTAGION_RESOURCE_TYPES.forEach((t) => {
    if (present.has(t) && !usedTypes.has(t)) eligible.push(t);
  });
  return eligible;
}
export function computeContagionScore(kept, gridFullyEmpty) {
  const pass = kept.defense >= kept.contamination;
  if (!pass) return { pass, score: 0, resourceCount: 0, fullSetBonus: false, exhaustionBonus: false };
  const resourceCount = kept.home + kept.hospital + kept.water;
  const fullSetBonus = kept.home > 0 && kept.hospital > 0 && kept.water > 0;
  const exhaustionBonus = gridFullyEmpty;
  const score = Math.max(resourceCount + (fullSetBonus ? 3 : 0) + (exhaustionBonus ? 1 : 0), 1);
  return { pass, score, resourceCount, fullSetBonus, exhaustionBonus };
}

// ---- House Dice's game flow, without the timers ----
export class ContagionGame {
  /** { day: '2026-11-24' } (daily) or { seed } (free play). */
  constructor(game) {
    if (typeof game.day === 'string') {
      this.mode = 'daily';
      this.day = game.day;
      this.seed = seedForDay(game.day);
    } else {
      this.mode = 'free';
      this.seed = game.seed >>> 0;
    }
    // startContagionGame
    this.kept = { contamination: 0, defense: 0, home: 0, hospital: 0, water: 0 };
    this.usedTypes = new Set();
    this.grid = Array(CONTAGION_GRID_SIZE).fill('defense'); // every cell holds a die before the opening roll
    this.lastRoll = Array(CONTAGION_GRID_SIZE).fill(null);
    this.rollNumber = 0;
    this.moves = [];
    this.phase = 'keep';
    this.ending = null;
    this.outcome = null;
    this.roll();
  }

  // the opening roll, and continueContagionRoll: only the dice still on the grid, each in its own cell
  roll() {
    this.rollNumber++;
    this.grid = this.grid.map((cell, i) => (cell == null ? null : dieFace(this.seed, this.rollNumber, i)));
    this.lastRoll = [...this.grid];
    this.processContagionContamination();
  }

  processContagionContamination() {
    const contamIndices = [];
    this.grid.forEach((s, i) => {
      if (s === 'contamination') contamIndices.push(i);
    });
    contamIndices.forEach((i) => {
      this.grid[i] = null;
    });
    this.kept = { ...this.kept, contamination: this.kept.contamination + contamIndices.length };
    this.checkContagionEligibility();
  }

  checkContagionEligibility() {
    const present = this.grid.filter((s) => s != null);
    const eligible = contagionEligibleTypes(present, this.usedTypes);
    if (eligible.length === 0) {
      // CT13 (changed): nothing to keep ends the game; 1 if contained, otherwise 0; no bonuses.
      const pass = this.kept.defense >= this.kept.contamination;
      this.finish('stuck', { pass, score: pass ? 1 : 0, fullSetBonus: false, exhaustionBonus: false });
    } else {
      this.phase = 'keep';
    }
  }

  eligible() {
    return this.phase === 'keep' ? contagionEligibleTypes(this.grid.filter((s) => s != null), this.usedTypes) : [];
  }

  /** One move word; true if done, false if refused (nothing changes). */
  move(word) {
    if (this.phase === 'over' || this.moves.length >= 32) return false;
    if (this.phase === 'keep') {
      if (!this.eligible().includes(word)) return false;
      this.moves.push(word);
      this.takeContagionType(word);
      return true;
    }
    if (word === 'roll') {
      this.moves.push(word);
      this.roll();
      return true;
    }
    if (word === 'bank') {
      this.moves.push(word);
      this.bankContagion();
      return true;
    }
    return false;
  }

  takeContagionType(type) {
    const indices = [];
    this.grid.forEach((s, i) => {
      if (s === type) indices.push(i);
    });
    indices.forEach((i) => {
      this.grid[i] = null;
    });
    this.kept = { ...this.kept, [type]: this.kept[type] + indices.length };
    if (type !== 'defense') this.usedTypes.add(type);
    const leftover = this.grid.filter((s) => s != null).length;
    if (leftover === 0) this.finishContagionGame('emptied', true);
    else this.phase = 'choose';
  }

  bankContagion() {
    this.finishContagionGame('bank', false); // voluntary bank always leaves dice unspent
  }

  finishContagionGame(ending, gridFullyEmpty) {
    const { pass, score, fullSetBonus, exhaustionBonus } = computeContagionScore(this.kept, gridFullyEmpty);
    this.finish(ending, { pass, score, fullSetBonus, exhaustionBonus });
  }

  finish(ending, outcome) {
    this.phase = 'over';
    this.ending = ending;
    // CT17: the real resource count, also on a fail or a stuck end.
    this.outcome = { ...outcome, resourceCount: this.kept.home + this.kept.hospital + this.kept.water };
  }

  /** The record's fields as the game sends them (CT17), in the engine's order; null until the game is over. */
  result() {
    if (this.phase !== 'over') return null;
    const o = this.outcome;
    return {
      mode: this.mode,
      ...(this.mode === 'daily' ? { day: this.day } : { seed: this.seed }),
      moves: [...this.moves],
      ending: this.ending,
      kept: { ...this.kept },
      pass: o.pass,
      score: o.score,
      resourceCount: o.resourceCount,
      fullSetBonus: o.fullSetBonus,
      exhaustionBonus: o.exhaustionBonus,
      grid: this.grid.map((s) => (s == null ? 'empty' : s)),
    };
  }

  label() {
    if (this.mode === 'daily') {
      const [, m, d] = this.day.split('-').map(Number);
      return `Contagion · daily, ${MONTHS[m - 1]} ${d}`;
    }
    return 'Contagion · free play';
  }

  line() {
    if (this.phase !== 'over') return '';
    return `${this.label()}: ${this.outcome.pass ? `contained, score ${this.outcome.score}` : 'containment failed'}`;
  }
}
