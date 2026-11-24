// What a finished Contagion game sends its host to save, and how a host can check one: by asking the engine the
// standard question (decision CT7) and comparing every field. The host adds $type, createdAt, which tile and
// version this is (game) and, in Raku, the engine's CID.
//
// The record is exactly the engine's result (engine.result(), decision CT17): mode; day (daily) or seed (free
// play), never both; moves (words); ending; kept; pass; score; resourceCount; fullSetBonus; exhaustionBonus; grid.
// The page builds its record from the engine, so the page and a check can't disagree.

export const COLLECTION = 'cafe.thunderbird.contagion.game';

/** The record for the game the engine has just finished, or null if it isn't over. */
export function recordFromEngine(engine) {
  return engine.result();
}

function same(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/**
 * Checks a saved game's own fields against an engine (from engine.js): the essentials (mode, day or seed, moves)
 * are replayed, and every other field must equal the engine's result, with nothing extra.
 * → { ok: true, result, label, line } or { ok: false, problem }.
 */
export function checkRecord(engine, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, problem: 'not a record' };
  const essentials = { mode: record.mode, moves: record.moves };
  if ('day' in record) essentials.day = record.day;
  if ('seed' in record) essentials.seed = record.seed;
  const answer = engine.check(essentials);
  if (!answer.ok) return { ok: false, problem: answer.reason };
  if (!same(record, answer.result)) return { ok: false, problem: "the record doesn't match its moves" };
  return { ok: true, result: answer.result, label: answer.label, line: answer.line };
}
