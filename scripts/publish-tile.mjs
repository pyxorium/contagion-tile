// Publishes Contagion (the tile in tile\) from thunderbird.cafe. Prism's scripts/publish-tile.mjs (the Game Host
// Kit's publish-demo.mjs, after Cosmic Junkyard's revise-tile.mjs), for Contagion. No packages: run from
// C:\thunderbird-cafe\contagion-tile with Node 22 or later.
//
//   node scripts/publish-tile.mjs              publish (the first time: a new record) or update it in place after
//   node scripts/publish-tile.mjs --dry-run    show what would happen; ask nothing, write nothing
//
// The first run makes a new tile record and writes its address into published.json under "tile" (commit that file:
// it says which files each version was made from; the lexicon script keeps its own part of the same file). Later runs
// update that same record, so its address never changes: they upload only the files that changed, take the name,
// description, size and icon from tile\manifest.json, and replace the record only if it hasn't changed since it was
// read (swapRecord). Every run reads the record back to check it. The app password comes from $env:BSKY_APP_PASSWORD,
// or is asked for (hidden as you type); it must belong to thunderbird.cafe.
//
// It publishes only the approved set (decision CT12): the engine, the declaration and the lexicon copy, each with the
// CID below. Hosts such as Raku approve the three together by these CIDs, so a host's approval stays good across
// page-only revisions. tile\engine.wasm must be engine\engine.wasm byte for byte, the tile's lexicon copy must be
// lexicons\cafe.thunderbird.contagion.game.json byte for byte, and the lexicon must already be published as it is
// (published.json, from scripts\publish-lexicons.mjs). Changing any of the three means changing its CID here on
// purpose, and telling the hosts.
import readline from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawCid } from './lib/cid.js';
import { dagCborCid } from './lib/dagcbor.js';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ACCOUNT = Object.freeze({ did: 'did:plc:6vxjigxrqizmbo56gojxico3', handle: 'thunderbird.cafe' });
export const COLLECTION = 'ing.dasl.masl';
export const TILE = 'tile';
export const PUBLISHED_FILE = join(ROOT, 'published.json');
/** The approved set (CT12): the engine (version 1, built from engine\\contagion.c with clang 18.1.3), the declaration,
 *  and the lexicon copy. */
export const ENGINE_CID = 'bafkreifms2aawbaemihyu7jnvk6zmpv3iuxsqcsjozo7brvdk5j4t5vrta';
export const DECLARATION_CID = 'bafkreicrfhdcr73nzby6z2xnvfz76q5kfyavhwoo3wu6kgokqbdw4frwqi';
export const LEXICON_CID = 'bafkreihovgusssrmfxf7zjko2e36fpkrdr3m7r7zvccxd7hrvgdzdkrrwq';
export const LEXICON_ID = 'cafe.thunderbird.contagion.game';
const BACKUP_DIR = join(ROOT, 'backups');
// Contagion's files, as published: its path in the tile, the file here, its content type.
export const FILES = Object.freeze([
  { path: '/', file: join(TILE, 'index.html'), type: 'text/html' },
  { path: '/engine.wasm', file: join(TILE, 'engine.wasm'), type: 'application/wasm' },
  { path: '/engine.js', file: join(TILE, 'engine.js'), type: 'text/javascript' },
  { path: '/contagion-record.js', file: join(TILE, 'contagion-record.js'), type: 'text/javascript' },
  { path: '/game-client.js', file: join(TILE, 'game-client.js'), type: 'text/javascript' },
  { path: '/declaration.json', file: join(TILE, 'declaration.json'), type: 'application/json' },
  { path: `/${LEXICON_ID}.json`, file: join(TILE, `${LEXICON_ID}.json`), type: 'application/json' },
  { path: '/icon.png', file: join(TILE, 'icon.png'), type: 'image/png' },
  { path: '/banner.jpg', file: join(TILE, 'banner.jpg'), type: 'image/jpeg' },
]);
export const ICONS = Object.freeze([{ src: '/icon.png', sizes: '256x256' }]);
// The preview picture hosts show on the tile's card (Raku's tile posts and cards: the first screenshot), 1280 x 720.
export const SCREENSHOTS = Object.freeze([{ src: '/banner.jpg', sizes: '1280x720' }]);

/** A raku.lexicographer.space link that opens a tile (Raku's own link shape). */
export const rakuLink = (uri) => `https://raku.lexicographer.space/#t=${encodeURIComponent(uri)}&a=0`;

/** A new record key (a TID: microseconds since 1970 and a clock id, in atproto's sortable base32). */
export function newTid(nowMs = Date.now(), clockId = Math.floor(Math.random() * 1024)) {
  const S32 = '234567abcdefghijklmnopqrstuvwxyz';
  let n = (BigInt(Math.floor(nowMs)) * 1000n) << 10n | BigInt(clockId & 1023);
  let out = '';
  for (let i = 0; i < 13; i += 1) { out = S32[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const err = new Error((body && (body.message || body.error)) || `Request failed (${res.status})`);
    err.status = res.status; err.error = body && body.error;
    throw err;
  }
  return body;
}
/** Parses "Expected: X, Got: Y" from a PDS InvalidMimeType message (as the Foundry's publish.js). */
const mimeMismatch = (message) => { const m = /Expected:\s*([^,\s]+)\s*,\s*Got:\s*([^\s,]+)/i.exec(message || ''); return m ? { expected: m[1], got: m[2] } : null; };

/** The manifest's own fields from tile\\manifest.json, checked. */
export function readManifestFields(text) {
  const m = JSON.parse(text);
  if (!m || typeof m.name !== 'string' || !m.name.trim()) throw new Error('tile\\manifest.json needs a name.');
  const out = { name: m.name.trim() };
  if (typeof m.description === 'string' && m.description.trim()) out.description = m.description.trim();
  const s = m.sizing;
  if (s && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0) out.sizing = { width: s.width, height: s.height };
  return out;
}

export async function runPublish({ fetchImpl = fetch, ask, askHidden, log = console.log, dryRun = false, env = process.env,
  readFile = (f) => new Uint8Array(readFileSync(join(ROOT, f))),
  readText = (f) => readFileSync(join(ROOT, f), 'utf8'),
  saveBackup = (name, text) => { mkdirSync(BACKUP_DIR, { recursive: true }); writeFileSync(join(BACKUP_DIR, name), text); },
  readPublished = () => (existsSync(PUBLISHED_FILE) ? JSON.parse(readFileSync(PUBLISHED_FILE, 'utf8')) : null),
  writePublished = (o) => writeFileSync(PUBLISHED_FILE, JSON.stringify(o, null, 2) + '\n'),
  now = () => new Date(), tid = () => newTid() } = {}) {
  const fields = readManifestFields(readText(join(TILE, 'manifest.json')));
  const whole = readPublished() || {};
  const published = whole.tile || null;
  // Only the approved set (CT12): the engine, the declaration and the lexicon copy, by their CIDs.
  const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const engineHere = readFile(join(TILE, 'engine.wasm'));
  if (!sameBytes(engineHere, readFile(join('engine', 'engine.wasm')))) throw new Error("tile\\engine.wasm isn't engine\\engine.wasm; nothing was changed (copy it again, and run npm test).");
  const lexiconHere = readFile(join(TILE, `${LEXICON_ID}.json`));
  if (!sameBytes(lexiconHere, readFile(join('lexicons', `${LEXICON_ID}.json`)))) throw new Error(`tile\\${LEXICON_ID}.json isn't lexicons\\${LEXICON_ID}.json; nothing was changed (copy it again, and run npm test).`);
  const engineCid = await rawCid(engineHere);
  const declarationCid = await rawCid(readFile(join(TILE, 'declaration.json')));
  const lexiconCid = await rawCid(lexiconHere);
  for (const [what, cid, approved, name] of [['engine', engineCid, ENGINE_CID, 'ENGINE_CID'], ['declaration', declarationCid, DECLARATION_CID, 'DECLARATION_CID'], ['lexicon copy', lexiconCid, LEXICON_CID, 'LEXICON_CID']]) {
    if (cid !== approved) throw new Error(`The ${what}'s CID is ${cid}, not the approved ${approved}; nothing was changed. A change to the ${what} needs ${name} changed on purpose (and the hosts told).`);
  }
  // The lexicon copy in the tile is the lexicon as published.
  const publishedLexicon = whole.lexicons && whole.lexicons[LEXICON_ID];
  if (!publishedLexicon) throw new Error(`The lexicon ${LEXICON_ID} isn't in published.json yet: publish it first (node scripts\\publish-lexicons.mjs); nothing was changed.`);
  if (JSON.stringify(JSON.parse(new TextDecoder().decode(lexiconHere))) !== publishedLexicon.text) throw new Error(`The tile's copy of ${LEXICON_ID} isn't the lexicon as published; publish the lexicon again first. Nothing was changed.`);
  const doc = await getJson(fetchImpl, `https://plc.directory/${ACCOUNT.did}`);
  const svc = (doc.service || []).find((s) => s.type === 'AtprotoPersonalDataServer' || String(s.id).endsWith('#atproto_pds'));
  if (!svc) throw new Error(`Could not find ${ACCOUNT.handle}'s server.`);
  const pds = String(svc.serviceEndpoint).replace(/\/+$/, '');

  // The record now (none the first time).
  const rkey = published && published.uri ? published.uri.split('/').pop() : null;
  if (published && published.uri && !published.uri.startsWith(`at://${ACCOUNT.did}/${COLLECTION}/`)) throw new Error('published.json names a tile record of another account; nothing was changed.');
  const recordUrl = (key) => `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(ACCOUNT.did)}&collection=${COLLECTION}&rkey=${encodeURIComponent(key)}`;
  let current = null;
  if (rkey) {
    current = await getJson(fetchImpl, recordUrl(rkey));
    const manifest = current.value && current.value.tile;
    if (!manifest || !manifest.resources) throw new Error("That record isn't a web tile; nothing was changed.");
    if ((await dagCborCid(manifest)) !== current.value.cid) throw new Error("Contagion's manifest address doesn't recompute the way this script expects, so it stopped without changing anything.");
  }
  const before = current ? current.value.tile : { resources: {} };

  const files = [];
  for (const f of FILES) {
    const bytes = readFile(f.file);
    const cid = await rawCid(bytes);
    const was = before.resources[f.path];
    files.push({ ...f, bytes, cid, changed: !was || was.src?.ref?.$link !== cid, was });
  }
  const changed = files.filter((f) => f.changed);
  const fieldsChanged = ['name', 'description'].some((k) => (before[k] ?? null) !== (fields[k] ?? null))
    || JSON.stringify(before.sizing ?? null) !== JSON.stringify(fields.sizing ?? null)
    || JSON.stringify(before.icons ?? null) !== JSON.stringify(ICONS)
    || JSON.stringify(before.screenshots ?? null) !== JSON.stringify(SCREENSHOTS);
  const uri = rkey ? `at://${ACCOUNT.did}/${COLLECTION}/${rkey}` : null;

  log(`\nTile: ${fields.name}  (@${ACCOUNT.handle})`);
  log(`Approved set: engine ${engineCid}, declaration ${declarationCid}, lexicon copy ${lexiconCid}`);
  log(uri ? `Address: ${uri}\nRecord now: ${current.cid}` : 'Not published yet: this makes a new record.');
  if (current && !changed.length && !fieldsChanged) { log('\nThe files and settings in tile\\ are the ones already published. Nothing to change.'); return { changed: false, uri }; }
  log('\nThis will:');
  for (const f of changed) log(`  - ${f.was ? 'replace' : 'add'} ${f.path} with ${f.file} (${(f.bytes.length / 1024).toFixed(1)} KB, ${f.cid})`);
  for (const f of files.filter((x) => !x.changed)) log(`  - keep ${f.path} as it is`);
  if (fieldsChanged) log(`  - ${current ? 'set' : 'give it'} the name, description, size and icon from tile\\manifest.json, and the preview picture`);
  if (current) log('  - keep its address; anything that shows this address gets the new version');
  if (dryRun) { log('\nDry run: nothing was written.'); return { changed: false, due: changed.map((f) => f.path), uri }; }

  let password = (env.BSKY_APP_PASSWORD || '').trim();
  if (password) log(`\nUsing the app password in $env:BSKY_APP_PASSWORD (${password.length} characters).`);
  else password = await askHidden(`\nApp password for @${ACCOUNT.handle} (hidden): `);
  if (!password) throw new Error('No app password given; nothing was changed.');
  const session = await getJson(fetchImpl, `${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: ACCOUNT.did, password }),
  });
  if (session.did !== ACCOUNT.did) throw new Error('That app password belongs to a different account; nothing was changed.');
  const auth = { Authorization: `Bearer ${session.accessJwt}` };
  const ok = (await ask(current ? `Update Contagion at ${uri}? [y/N] ` : `Publish Contagion as a new tile from @${ACCOUNT.handle}? [y/N] `)).trim().toLowerCase();
  if (ok !== 'y' && ok !== 'yes') { log('Stopped; nothing was changed.'); return { changed: false, uri }; }

  if (current) {
    const backupName = `backup-contagion-${rkey}-${now().toISOString().replace(/[:.]/g, '-')}.json`;
    saveBackup(backupName, JSON.stringify(current, null, 2) + '\n');
    log(`Saved a backup of the current record: backups\\${backupName}`);
  }

  const next = { ...structuredClone(before), ...fields, icons: structuredClone(ICONS), screenshots: structuredClone(SCREENSHOTS) };
  if (!fields.description) delete next.description;
  if (!fields.sizing) delete next.sizing;
  next.resources = { ...(next.resources || {}) };
  for (const f of changed) {
    const res = await getJson(fetchImpl, `${pds}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...auth, 'Content-Type': f.type }, body: f.bytes });
    const link = res && res.blob && res.blob.ref && res.blob.ref.$link;
    if (link !== f.cid) throw new Error(`The server stored ${f.path} under a different address than expected; ${current ? 'the record is unchanged' : 'nothing was published'}.`);
    next.resources[f.path] = { ...(f.was || {}), src: { $type: 'blob', ref: { $link: link }, mimeType: res.blob.mimeType || f.type, size: res.blob.size ?? f.bytes.length }, 'content-type': f.type };
    log(`Uploaded ${f.path}`);
  }
  const key = rkey || tid();
  const target = `at://${ACCOUNT.did}/${COLLECTION}/${key}`;
  const createdAt = current ? current.value.createdAt || now().toISOString() : now().toISOString();
  const build = async () => ({ $type: COLLECTION, cid: await dagCborCid(next), tile: next, createdAt });
  let record = await build();
  let put;
  for (let attempt = 1; ; attempt++) {
    try {
      const body = { repo: ACCOUNT.did, collection: COLLECTION, rkey: key, record, validate: false };
      // The first time: createRecord, which refuses rather than overwrite a record already at that key.
      put = current
        ? await getJson(fetchImpl, `${pds}/xrpc/com.atproto.repo.putRecord`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, swapRecord: current.cid }) })
        : await getJson(fetchImpl, `${pds}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      break;
    } catch (err) {
      // A server that already held these bytes under another type says so: use its type, once.
      const mm = err.error === 'InvalidMimeType' ? mimeMismatch(err.message) : null;
      const which = mm && changed.find((f) => next.resources[f.path].src.mimeType === mm.got);
      if (attempt === 1 && which) { next.resources[which.path].src.mimeType = mm.expected; record = await build(); continue; }
      if (err.error === 'InvalidSwap') throw new Error('The record changed after it was read (someone else updated it?), so it was not replaced. Run this again.');
      throw new Error(`${current ? 'Replacing the record' : 'Publishing'} failed: ${err.message}.${current ? ' The old record is unchanged.' : ''}`);
    }
  }
  const after = await getJson(fetchImpl, recordUrl(key));
  if (!after.value || after.value.cid !== record.cid || after.cid !== put.cid) throw new Error(`The record was ${current ? 'replaced' : 'written'}, but reading it back didn't match. Check it${current ? ', and restore the backup if needed' : ''}.`);

  const filesNow = Object.fromEntries(FILES.map((f) => [f.path, next.resources[f.path].src.ref.$link]));
  const entry = { uri: target, cid: put.cid, manifestCid: record.cid, files: filesNow, [current ? 'revisedAt' : 'publishedAt']: now().toISOString() };
  const earlier = current
    ? [{ uri: target, cid: current.cid, manifestCid: current.value.cid, files: Object.fromEntries(Object.entries(before.resources).map(([k, v]) => [k, v?.src?.ref?.$link || null])), replacedAt: now().toISOString() },
      ...((published && published.earlier) || [])]
    : [];
  writePublished({ ...whole, account: whole.account || { handle: ACCOUNT.handle, did: ACCOUNT.did }, tile: { ...entry, engine: engineCid, declaration: declarationCid, lexicon: lexiconCid, raku: rakuLink(target), earlier } });
  log(`\nDone. Contagion is at ${target}, record ${put.cid}.`);
  log(`  play it in Raku: ${rakuLink(target)}`);
  log(`  look: https://pdsls.dev/${target}`);
  log('Commit published.json. Delete this app password once you are done with it (Bluesky: Settings > Privacy and security > App passwords).');
  return { changed: true, record, cid: put.cid, uri: target };
}

function makeAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted || s.includes('\n')) write(muted ? '\n' : s); };
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const askHidden = (q) => new Promise((r) => { process.stdout.write(q); muted = true; rl.question('', (a) => { muted = false; r(a.trim()); }); });
  return { ask, askHidden, close: () => rl.close() };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const io = makeAsk();
  runPublish({ ask: io.ask, askHidden: io.askHidden, dryRun: process.argv.slice(2).includes('--dry-run') })
    .catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; })
    .finally(() => io.close());
}
