// Publishing: the lexicon (scripts/publish-lexicons.mjs) and the tile (scripts/publish-tile.mjs), against a stand-in
// account server; the approved set (engine, declaration, lexicon copy: CT12); the declaration; and the lexicon against
// the records the game actually makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublish, newTid, rakuLink, readManifestFields, ACCOUNT, COLLECTION, FILES, ICONS, SCREENSHOTS, ENGINE_CID, DECLARATION_CID, LEXICON_CID, LEXICON_ID } from '../scripts/publish-tile.mjs';
import { runPublish as runLexicons, readLexicons, TXT, FAMILY } from '../scripts/publish-lexicons.mjs';
import { rawCid } from '../scripts/lib/cid.js';
import { dagCborCid } from '../scripts/lib/dagcbor.js';
import { loadEngine } from '../engine/engine.js';
import { recordFromEngine, COLLECTION as GAME_COLLECTION } from '../tile/contagion-record.js';
import { MOVES } from '../reference/contagion-ref.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const PDS = 'https://fibercap.us-west.host.bsky.network';
const PASSWORD = 'abcd-efgh-ijkl-mnop';
const quiet = () => {};
const yes = async () => 'y';
const KEY = '3n2xcontagion';

function server({ password = PASSWORD, swapFails = false, sessionDid = ACCOUNT.did } = {}) {
  const records = new Map();           // collection/rkey -> { cid, value }
  const blobs = new Map();
  const calls = [];
  let n = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').pop().split('.').pop());
    if (u.host === 'plc.directory') return json({ id: ACCOUNT.did, alsoKnownAs: [`at://${ACCOUNT.handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    if (u.pathname.endsWith('createSession')) return JSON.parse(init.body).password === password ? json({ did: sessionDid, accessJwt: 'jwt' }) : json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
    if (u.pathname.endsWith('getRecord')) {
      const k = `${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`;
      const r = records.get(k);
      if (!r) return json({ error: 'RecordNotFound', message: 'Could not locate record' }, 400);
      // A real server hands records back in its own key order.
      return json({ uri: `at://${ACCOUNT.did}/${k}`, cid: r.cid, value: Object.fromEntries(Object.entries(r.value).reverse()) });
    }
    if (u.pathname.endsWith('uploadBlob')) {
      const bytes = new Uint8Array(init.body);
      const cid = await rawCid(bytes);
      blobs.set(cid, { bytes, type: init.headers['Content-Type'] });
      return json({ blob: { $type: 'blob', ref: { $link: cid }, mimeType: init.headers['Content-Type'], size: bytes.length } });
    }
    if (u.pathname.endsWith('createRecord') || u.pathname.endsWith('putRecord')) {
      const b = JSON.parse(init.body);
      const k = `${b.collection}/${b.rkey}`;
      const had = records.get(k);
      if (u.pathname.endsWith('createRecord') && had) return json({ error: 'InvalidRequest', message: 'Record already exists' }, 400);
      if (u.pathname.endsWith('putRecord') && b.collection === COLLECTION && (swapFails || !had || b.swapRecord !== had.cid)) return json({ error: 'InvalidSwap', message: 'Record was at bafy…' }, 400);
      const cid = `bafyreicontagion${++n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
      records.set(k, { cid, value: b.record });
      return json({ uri: `at://${ACCOUNT.did}/${k}`, cid });
    }
    return json({ error: 'NotFound' }, 404);
  };
  return { fetchImpl, calls, blobs, records };
}
const LEXICON_PUBLISHED = { [LEXICON_ID]: { uri: `at://${ACCOUNT.did}/com.atproto.lexicon.schema/${LEXICON_ID}`, cid: 'bafyreilex', text: JSON.stringify(JSON.parse(readFileSync(new URL(`../lexicons/${LEXICON_ID}.json`, import.meta.url), 'utf8'))) } };
function store(initial = { lexicons: LEXICON_PUBLISHED }) {
  let pub = initial;
  return { readPublished: () => pub, writePublished: (o) => { pub = structuredClone(o); }, get published() { return pub; } };
}
const base = (s, st, over = {}) => ({ fetchImpl: s.fetchImpl, ask: yes, askHidden: async () => PASSWORD, log: quiet, env: {}, saveBackup: () => {},
  readPublished: st.readPublished, writePublished: st.writePublished, tid: () => KEY, now: () => new Date('2026-11-22T20:00:00Z'), ...over });

// ---- the tile ----

test('the files Contagion publishes, and the approved set', async () => {
  assert.deepEqual(FILES.map((f) => f.path), ['/', '/engine.wasm', '/engine.js', '/contagion-record.js', '/game-client.js', '/declaration.json', '/cafe.thunderbird.contagion.game.json', '/icon.png', '/banner.jpg']);
  assert.equal(FILES.find((f) => f.path === '/engine.wasm').type, 'application/wasm');
  for (const f of FILES) assert.ok(read(f.file.replaceAll('\\', '/')).length > 0, f.file);
  assert.equal(await rawCid(new Uint8Array(read('engine/engine.wasm'))), ENGINE_CID);
  assert.equal(await rawCid(new Uint8Array(read('tile/declaration.json'))), DECLARATION_CID, 'the declaration changed: its CID in scripts/publish-tile.mjs (and in the hosts) must change on purpose');
  assert.equal(await rawCid(new Uint8Array(read(`tile/${LEXICON_ID}.json`))), LEXICON_CID, 'the lexicon copy changed: its CID must change on purpose');
  assert.ok(read(`tile/${LEXICON_ID}.json`).equals(read(`lexicons/${LEXICON_ID}.json`)), "the tile's lexicon copy is the lexicon, byte for byte");
  assert.equal(ACCOUNT.handle, 'thunderbird.cafe');
  const html = read('tile/index.html').toString();
  for (const f of FILES.filter((x) => x.path.endsWith('.js'))) assert.match(html, new RegExp(`from "\\.${f.path.replace('.', '\\.')}"`), `index.html imports ${f.path} from beside itself`);
  assert.match(html, /fetch\("\.\/engine\.wasm"\)/);
  assert.doesNotMatch(html, /\.\.\//, 'nothing from outside the tile');
  assert.doesNotMatch(read('tile/manifest.json').toString() + html, /\bmu\b/i);
  const m = readManifestFields(read('tile/manifest.json').toString());
  assert.equal(m.name, 'Contagion');
  assert.deepEqual(m.sizing, { width: 380, height: 540 });
  assert.equal(read('tile/banner.jpg').subarray(0, 2).toString('hex'), 'ffd8', 'the preview picture is a JPEG');
  const attrs = read('.gitattributes').toString();
  for (const f of ['tile/declaration.json', `tile/${LEXICON_ID}.json`, 'tile/engine.wasm']) assert.match(attrs, new RegExp(`^${f.replace(/[.]/g, '\\.')} (binary|-text)$`, 'm'), `git keeps ${f}'s bytes`);
});

test('the declaration (CT9): what Contagion asks of a host, and promises', () => {
  const d = JSON.parse(read('tile/declaration.json'));
  assert.equal(d.declaration, 1);
  assert.equal(d.statement, "No network. Saves one game record. Doesn't see your account.");
  assert.equal(d.network, 'none');
  assert.equal(d.identity, 'none');
  assert.deepEqual(d.writes, { collection: GAME_COLLECTION, perSave: 1, maxBytes: 4096, hostAdds: ['$type', 'game', 'engine', 'createdAt'] });
  assert.equal(d.reads.length, 1);
  assert.equal(d.reads[0].collection, GAME_COLLECTION);
  assert.equal(d.lexicon.id, LEXICON_ID);
  assert.equal(d.lexicon.path, `/${LEXICON_ID}.json`);
  assert.ok(FILES.some((f) => f.path === d.lexicon.path) && FILES.some((f) => f.path === d.engine.path), 'the declaration names files the tile carries');
  assert.deepEqual(d.engine.limits, { bytes: 65536, memoryBytes: 1048576, milliseconds: 1000 });
  assert.ok(read('engine/engine.wasm').length <= d.engine.limits.bytes);
  assert.deepEqual(d.houseRules.modes, { daily: { requires: ['day'], forbids: ['seed'] }, free: { requires: ['seed'], forbids: ['day'] } });
  assert.deepEqual(d.houseRules.daily, { atMost: 1, per: 'day', dayField: 'day', timeZone: 'America/Denver', window: ['today', 'yesterday'] });
  assert.equal(d.engine.essentials.daily.call, 'std_check_daily');
  assert.equal(d.engine.essentials.free.call, 'std_check_free');
});

test("the engine's own memory and the page's policy keep within what's declared", async () => {
  const d = JSON.parse(read('tile/declaration.json'));
  const engine = new WebAssembly.Instance(new WebAssembly.Module(read('engine/engine.wasm')), {});
  assert.ok(engine.exports.memory.buffer.byteLength <= d.engine.limits.memoryBytes);
  for (const call of [d.engine.essentials.daily.call, d.engine.essentials.free.call, d.engine.answers.label, d.engine.answers.line, d.engine.moves.input]) assert.equal(typeof engine.exports[call], 'function', call);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read('tile/index.html').toString())[1];
  assert.doesNotMatch(csp, /https?:|wss?:|connect-src [^;]*\*/, 'network: none');
});

test('a dry run, the first time: says it makes a new record, writes nothing', async () => {
  const s = server(); const st = store();
  const lines = [];
  const r = await runPublish(base(s, st, { dryRun: true, log: (l) => lines.push(l) }));
  assert.equal(r.changed, false);
  assert.deepEqual(r.due, FILES.map((f) => f.path));
  assert.match(lines.join('\n'), /makes a new record/);
  assert.match(lines.join('\n'), new RegExp(`Approved set: engine ${ENGINE_CID}, declaration ${DECLARATION_CID}, lexicon copy ${LEXICON_CID}`));
  assert.deepEqual(s.calls, [ACCOUNT.did]);   // plc.directory only
  assert.equal(st.published.tile, undefined, 'nothing written');
});

test('the first publish: a new record from thunderbird.cafe, its manifest address right, published.json\'s tile part written', async () => {
  const s = server(); const st = store({ account: { handle: 'thunderbird.cafe', did: ACCOUNT.did }, lexicons: LEXICON_PUBLISHED });
  const r = await runPublish(base(s, st));
  assert.equal(r.changed, true);
  assert.equal(r.uri, `at://${ACCOUNT.did}/${COLLECTION}/${KEY}`);
  assert.ok(s.calls.includes('createRecord') && !s.calls.includes('putRecord'));
  const rec = s.records.get(`${COLLECTION}/${KEY}`).value;
  assert.equal(rec.$type, COLLECTION);
  assert.equal(rec.cid, await dagCborCid(rec.tile));
  assert.deepEqual(Object.keys(rec.tile.resources).sort(), FILES.map((f) => f.path).sort());
  assert.equal(rec.tile.resources['/engine.wasm']['content-type'], 'application/wasm');
  assert.equal(rec.tile.resources['/engine.wasm'].src.ref.$link, ENGINE_CID);
  assert.deepEqual(rec.tile.icons, ICONS);
  assert.deepEqual(rec.tile.screenshots, [{ src: '/banner.jpg', sizes: '1280x720' }], 'the card\'s preview picture');
  assert.deepEqual(rec.tile.screenshots, SCREENSHOTS);
  assert.equal(rec.tile.name, 'Contagion');
  for (const f of FILES) assert.equal(rec.tile.resources[f.path].src.ref.$link, await rawCid(new Uint8Array(read(f.file.replaceAll('\\', '/')))));
  assert.equal(st.published.tile.uri, r.uri);
  assert.equal(st.published.tile.engine, ENGINE_CID);
  assert.equal(st.published.tile.declaration, DECLARATION_CID);
  assert.equal(st.published.tile.lexicon, LEXICON_CID);
  assert.equal(rec.tile.resources['/declaration.json'].src.ref.$link, DECLARATION_CID);
  assert.equal(rec.tile.resources[`/${LEXICON_ID}.json`].src.ref.$link, LEXICON_CID);
  assert.equal(st.published.tile.raku, rakuLink(r.uri));
  assert.deepEqual(st.published.tile.earlier, []);
  assert.ok(st.published.lexicons[LEXICON_ID], 'the lexicon part of published.json is kept');
});

test('run again with nothing changed: nothing to do; a changed page: only it uploaded, same address, swapRecord, the engine unchanged', async () => {
  const s = server(); const st = store();
  await runPublish(base(s, st));
  const first = st.published.tile;
  s.calls.length = 0;
  const same = await runPublish(base(s, st));
  assert.equal(same.changed, false);
  assert.ok(!s.calls.includes('createSession'));
  const html = new TextEncoder().encode('<!doctype html><title>changed</title>');
  const readFile = (f) => (f.endsWith('index.html') ? html : new Uint8Array(read(f.replaceAll('\\', '/'))));
  s.calls.length = 0;
  const r = await runPublish(base(s, st, { readFile }));
  assert.equal(r.uri, first.uri);
  assert.equal(s.calls.filter((c) => c === 'uploadBlob').length, 1);
  assert.ok(s.calls.includes('putRecord') && !s.calls.includes('createRecord'));
  assert.equal(st.published.tile.earlier.length, 1);
  assert.equal(st.published.tile.earlier[0].cid, first.cid);
  assert.equal(st.published.tile.files['/'], await rawCid(html));
  assert.equal(st.published.tile.files['/engine.wasm'], ENGINE_CID, 'a page change leaves the engine (and Raku\'s approval) as it was');
  assert.equal(st.published.tile.files['/declaration.json'], DECLARATION_CID);
  assert.equal(st.published.tile.files[`/${LEXICON_ID}.json`], LEXICON_CID);
});

test('only the approved set is published: engine, declaration, lexicon copy; and the lexicon as published', async () => {
  const flip = (bytes) => { const b = new Uint8Array(bytes); b[b.length - 2] ^= 1; return b; };
  const files = (over) => (f) => { const k = f.replaceAll('\\', '/'); return over[k] ? over[k] : new Uint8Array(read(k)); };
  const tries = [
    [{ 'tile/engine.wasm': flip(read('engine/engine.wasm')) }, /isn't engine\\engine\.wasm/],
    [{ 'tile/engine.wasm': flip(read('engine/engine.wasm')), 'engine/engine.wasm': flip(read('engine/engine.wasm')) }, /engine's CID .* not the approved/],
    [{ 'tile/declaration.json': new TextEncoder().encode(read('tile/declaration.json').toString().replace('"atMost": 1', '"atMost": 2')) }, /declaration's CID .* not the approved/],
    [{ [`tile/${LEXICON_ID}.json`]: flip(read(`lexicons/${LEXICON_ID}.json`)) }, /isn't lexicons/],
    [{ [`tile/${LEXICON_ID}.json`]: flip(read(`lexicons/${LEXICON_ID}.json`)), [`lexicons/${LEXICON_ID}.json`]: flip(read(`lexicons/${LEXICON_ID}.json`)) }, /lexicon copy's CID .* not the approved/],
  ];
  for (const [over, why] of tries) {
    const s = server();
    await assert.rejects(runPublish(base(s, store(), { readFile: files(over) })), why);
    assert.equal(s.records.size, 0);
  }
  // (The third try above: a declaration loosened to two dailies a day is refused, CT12.)
  // The lexicon must already be published, as it is.
  await assert.rejects(runPublish(base(server(), store({}))), /isn't in published\.json yet/);
  await assert.rejects(runPublish(base(server(), store({ lexicons: { [LEXICON_ID]: { ...LEXICON_PUBLISHED[LEXICON_ID], text: '{"lexicon":1}' } } }))), /isn't the lexicon as published/);
});

test('refusals: another account\'s password, a record changed meanwhile, no password, "no" at the question, another account\'s record', async () => {
  await assert.rejects(runPublish(base(server({ sessionDid: 'did:plc:someoneelse' }), store())), /different account/);
  const s3 = server({ swapFails: true }); const st3 = store();
  await runPublish(base(s3, st3));
  const readFile = (f) => (f.endsWith('index.html') ? new TextEncoder().encode('<p>x</p>') : new Uint8Array(read(f.replaceAll('\\', '/'))));
  await assert.rejects(runPublish(base(s3, st3, { readFile })), /changed after it was read/);
  await assert.rejects(runPublish(base(server(), store(), { askHidden: async () => '' })), /No app password/);
  const s4 = server();
  const r = await runPublish(base(s4, store(), { ask: async () => 'n' }));
  assert.equal(r.changed, false);
  assert.equal(s4.records.size, 0);
  await assert.rejects(runPublish(base(server(), store({ lexicons: LEXICON_PUBLISHED, tile: { uri: 'at://did:plc:other/ing.dasl.masl/3abc' } }))), /another account/);
  assert.match(newTid(Date.parse('2026-11-22T20:00:00Z'), 5), /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
});

// ---- the lexicon ----

test('the lexicon: one record type under cafe.thunderbird.contagion., named by its file, matching the game\'s collection; the moves in the engine\'s order (CT14)', async () => {
  const lexicons = readLexicons();
  assert.deepEqual(lexicons.map((l) => l.id), [LEXICON_ID]);
  assert.equal(lexicons[0].id, GAME_COLLECTION);
  assert.equal(TXT, '_lexicon.contagion');
  assert.equal(FAMILY, 'cafe.thunderbird.contagion.');
  const main = lexicons[0].defs.main;
  assert.equal(main.type, 'record');
  assert.equal(main.key, 'tid');
  const engine = await loadEngine(read('engine/engine.wasm'));
  assert.deepEqual(main.record.properties.moves.items.enum, engine.moveNames, 'the lexicon lists the moves in the engine\'s order');
  assert.deepEqual(engine.moveNames, MOVES);
});

/** A small check of a record against the lexicon's object (the parts this lexicon uses). */
function fitsLexicon(def, rec, defs = readLexicons()[0].defs) {
  const problems = [];
  for (const k of def.required) if (!(k in rec)) problems.push(`missing ${k}`);
  for (const [k, v] of Object.entries(rec)) {
    if (k === '$type') continue;
    const p = def.properties[k];
    if (!p) { problems.push(`unknown ${k}`); continue; }
    if (p.type === 'integer' && !(Number.isInteger(v) && (p.minimum ?? -Infinity) <= v && v <= (p.maximum ?? Infinity))) problems.push(`${k} out of range`);
    if (p.type === 'string' && !(typeof v === 'string' && v.length >= (p.minLength ?? 0) && v.length <= (p.maxLength ?? Infinity))) problems.push(`${k} not a fitting string`);
    if (p.type === 'boolean' && typeof v !== 'boolean') problems.push(`${k} not a boolean`);
    if (p.type === 'ref' && p.ref === '#kept') {
      const kept = defs.kept;
      for (const r of kept.required) if (!(v && r in v)) problems.push(`kept missing ${r}`);
      for (const [kk, vv] of Object.entries(v || {})) { const q = kept.properties[kk]; if (!q) problems.push(`kept unknown ${kk}`); else if (!(Number.isInteger(vv) && vv >= q.minimum && vv <= q.maximum)) problems.push(`kept ${kk} out of range`); }
      continue;
    }
    if (p.type === 'array') {
      if (!Array.isArray(v) || v.length < (p.minLength ?? 0) || v.length > (p.maxLength ?? Infinity)) problems.push(`${k} wrong length`);
      else for (const item of v) {
        if (p.items.type === 'integer' && !(Number.isInteger(item) && item >= p.items.minimum && item <= p.items.maximum)) problems.push(`${k} item ${item}`);
        if (p.items.type === 'string' && !(typeof item === 'string' && (!p.items.enum || p.items.enum.includes(item)))) problems.push(`${k} item ${item}`);
      }
    }
    if (p.type === 'ref' && p.ref === 'com.atproto.repo.strongRef' && !(v && typeof v.uri === 'string' && typeof v.cid === 'string')) problems.push(`${k} not a strongRef`);
    if (p.knownValues && !p.knownValues.includes(v)) problems.push(`${k} not one of ${p.knownValues}`);
  }
  return problems;
}

test('every record the game makes, with what the host adds, fits the lexicon', async () => {
  const def = readLexicons()[0].defs.main.record;
  const engine = await loadEngine(read('engine/engine.wasm'));
  let rand = 99;
  const next = () => { rand = (rand * 1103515245 + 12345) >>> 0; return rand / 4294967296; };
  const endings = new Set();
  for (let n = 0; n < 600; n++) {
    if (n % 2) engine.startDaily('2026-11-24'); else engine.startFree(n === 0 ? 4294967295 : Math.floor(next() * 4294967296));
    let s = engine.state();
    while (s.phase !== 'over') {
      engine.move(s.phase === 'keep' ? s.eligible[Math.floor(next() * s.eligible.length)] : next() < 0.3 ? 'bank' : 'roll');
      s = engine.state();
    }
    const rec = { $type: GAME_COLLECTION, ...recordFromEngine(engine), game: { uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyreiabc' }, engine: ENGINE_CID, createdAt: '2026-11-24T20:00:00.000Z' };
    endings.add(rec.ending);
    assert.deepEqual(fitsLexicon(def, rec), [], JSON.stringify(rec));
    assert.ok(new TextEncoder().encode(JSON.stringify(rec)).length <= JSON.parse(read('tile/declaration.json')).writes.maxBytes, 'within the declared size');
  }
  assert.deepEqual([...endings].sort(), ['bank', 'emptied', 'stuck']);
  // And the check itself catches what doesn't fit.
  assert.ok(fitsLexicon(def, { mode: 'daily' }).length > 0);
  const good = { $type: GAME_COLLECTION, game: { uri: 'a', cid: 'b' }, mode: 'free', seed: 1, moves: ['defense', 'bank'], ending: 'bank', kept: { contamination: 1, defense: 2, home: 0, hospital: 0, water: 0 }, pass: true, score: 1, resourceCount: 0, fullSetBonus: false, exhaustionBonus: false, grid: Array(16).fill('empty'), createdAt: 'x' };
  assert.deepEqual(fitsLexicon(def, good), []);
  assert.ok(fitsLexicon(def, { ...good, moves: ['jump'] }).includes('moves item jump'));
  assert.ok(fitsLexicon(def, { ...good, grid: Array(15).fill('empty') }).includes('grid wrong length'));
  assert.ok(fitsLexicon(def, { ...good, kept: { ...good.kept, extra: 1 } }).includes('kept unknown extra'));
  assert.ok(fitsLexicon(def, { ...good, pass: 'yes' }).includes('pass not a boolean'));
  assert.ok(fitsLexicon(def, { ...good, usedTypes: [] }).includes('unknown usedTypes'));
});

test('the lexicon publisher: a dry run lists it as new and writes nothing; a publish writes it once, then has nothing to do', async () => {
  const s = server(); const st = store({});
  const r1 = await runLexicons(base(s, st, { dryRun: true }));
  assert.deepEqual(r1.due, [LEXICON_ID]);
  assert.ok(!s.calls.includes('putRecord'));
  const r2 = await runLexicons(base(s, st));
  assert.equal(r2.changed, true);
  assert.ok(s.records.has(`com.atproto.lexicon.schema/${LEXICON_ID}`));
  assert.equal(st.published.lexicons[LEXICON_ID].text, JSON.stringify(readLexicons()[0]));
  const r3 = await runLexicons(base(s, st));
  assert.equal(r3.changed, false);
  await assert.rejects(runLexicons(base(server({ sessionDid: 'did:plc:someoneelse' }), store({}))), /different account/);
});

test('both publishers share published.json without losing each other\'s part', async () => {
  const s = server(); const st = store({});
  await runLexicons(base(s, st));
  await runPublish(base(s, st));
  assert.ok(st.published.lexicons[LEXICON_ID] && st.published.tile.uri);
  await runLexicons(base(s, st, { lexicons: [{ ...readLexicons()[0], description: 'changed' }] }));
  assert.ok(st.published.tile.uri, 'publishing the lexicon again keeps the tile part');
});
