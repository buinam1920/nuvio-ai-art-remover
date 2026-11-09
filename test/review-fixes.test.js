// Regression tests for the findings of the independent security/correctness review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../js/nuvio.js';
import {
  tileKey,
  applyArt,
  buildFullRestore,
  buildArtRestore,
  parsePullResponse,
  parseBackup,
  buildBackup,
  checkBackupIdentity,
  assertLosslessNumbers,
  pickArt,
  listTiles,
  DataError,
} from '../js/collections.js';
import { guardedWrite, pullSnapshot } from '../js/workflow.js';
import { sampleCollections, BACKDROP } from './fixtures.js';

const ok = (json) => ({ ok: true, status: 200, text: async () => (typeof json === 'string' ? json : JSON.stringify(json)) });
const discovery = { backend_url: 'https://backend.example', publishable_key: 'k' };

test('#1 API requests never follow redirects (password cannot be forwarded to an unseen host)', async () => {
  const seen = [];
  const client = createClient({
    fetch: async (url, init) => {
      seen.push(init.redirect);
      return url.includes('well-known') ? ok(discovery) : ok({ access_token: 't', user: { id: 'u' } });
    },
  });
  await client.login('a@b.c', 'pw');
  assert.deepEqual(seen, ['error', 'error']);
});

test('#2 tile keys cannot collide across collection/tile id boundaries', () => {
  assert.notEqual(tileKey('a::b', 'c'), tileKey('a', 'b::c'));
  const cols = [
    { id: 'a::b', title: 'X', folders: [{ id: 'c', title: 'one' }] },
    { id: 'a', title: 'Y', folders: [{ id: 'b::c', title: 'two' }] },
  ];
  const { collections, changes } = applyArt(cols, { [tileKey('a::b', 'c')]: BACKDROP });
  assert.equal(changes.length, 1);
  assert.equal(collections[0].folders[0].coverImageUrl, BACKDROP);
  assert.ok(!('coverImageUrl' in collections[1].folders[0]));

  const backupKeepsOnlyOne = [cols[0], { ...cols[1], folders: [] }];
  assert.deepEqual(buildFullRestore(cols, backupKeepsOnlyOne).removedTiles, ['Y / two'], 'deletion is reported');
});

test('#3 numbers JavaScript would round are refused before any backup or write', async () => {
  const big = '[{"id":"c","folders":[{"id":"f","catalogSources":[{"externalId":9007199254740993}]}]}]';
  assert.throws(() => parsePullResponse([{ profile_id: 1, collections_json: big, updated_at: 't' }], 1), DataError);
  assert.throws(() => parseBackup(big), /cannot be handled exactly/);
  assert.throws(() => assertLosslessNumbers('[0.12345678901234567890]'), DataError);
  assert.doesNotThrow(() => assertLosslessNumbers('[1, 1.0, -0, 0.5, 1e3, "9007199254740993", "a\\"9007199254740993"]'));

  // Outer response (collections_json as a real array) is checked by the client too.
  const client = createClient({
    fetch: async (url) => {
      if (url.includes('well-known')) return ok(discovery);
      if (url.includes('/token')) return ok({ access_token: 't', user: { id: 'u' } });
      return ok(`[{"profile_id":1,"updated_at":"t","collections_json":${big}}]`);
    },
  });
  await client.login('a', 'b');
  await assert.rejects(client.pullCollections(1), (e) => e.kind === 'shape' && /exactly/.test(e.message));
});

function fakeServer() {
  const state = { collections: sampleCollections(), updatedAt: 't0', pulls: 0 };
  const client = {
    async pullCollections(profileId) {
      state.pulls++;
      if (state.onPull) state.onPull(state.pulls);
      if (state.failPull) throw Object.assign(new Error('JWT expired'), { status: 401 });
      return [{ profile_id: profileId, collections_json: JSON.stringify(state.collections), updated_at: state.updatedAt }];
    },
    async pushCollections(_p, cols) {
      return state.onPush(cols);
    },
  };
  return { state, client };
}
const key = tileKey('collections.genres', 'f-action');

test('#4 recovery returns the snapshot it actually classified', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = (cols) => {
    state.collections = JSON.parse(JSON.stringify(cols));
    state.updatedAt = 't1';
    // Another device edits right after the recovery read.
    state.onPull = (n) => {
      if (n === 4) state.collections[1].title = 'Edited elsewhere';
    };
    throw Object.assign(new Error('timeout'), { kind: 'timeout' });
  };
  const r = await guardedWrite({ client, profileId: 1, base, payload });
  assert.equal(r.status, 'applied');
  assert.equal(r.snapshot.collections[1].title, 'Streaming', 'returned snapshot is the verified one');
  assert.equal(state.pulls, 3, 'no extra unchecked pull');
});

test('#5 a timeout that shows old data is reported as pending, not "nothing saved"', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = () => {
    throw Object.assign(new Error('The server took too long'), { kind: 'timeout' });
  };
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), (e) => e.outcome === 'pending');
  state.onPush = () => {
    throw Object.assign(new Error('HTTP 500'), { kind: 'http', status: 500 });
  };
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), (e) => e.outcome === 'unchanged');
});

test('#5 a failed read-back after a successful push is flagged unknown', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = (cols) => {
    state.collections = JSON.parse(JSON.stringify(cols));
    state.failPull = true;
    return null;
  };
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), (e) => e.outcome === 'unknown' && e.status === 401);
});

test('#6 undo only reverts tiles this session wrote and that nobody changed since', () => {
  const backup = sampleCollections();
  const horror = tileKey('collections.genres', 'f-horror');
  // Session wrote Action; another device later changed Horror and then Netflix.
  let current = applyArt(backup, { [key]: BACKDROP }).collections;
  const written = new Map([[key, pickArt(current[0].folders[0])]]);
  current = applyArt(current, { [horror]: 'https://images.metahub.space/background/large/tt1/img' }).collections;

  const r = buildArtRestore(current, backup, { only: written });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].key, key);
  assert.equal(r.collections[0].folders[1].coverImageUrl, 'https://images.metahub.space/background/large/tt1/img', 'other device’s change kept');

  // If the session's tile itself was changed elsewhere, leave it alone and report it.
  const changedAgain = applyArt(current, { [key]: 'https://images.metahub.space/background/large/tt2/img' }).collections;
  const r2 = buildArtRestore(changedAgain, backup, { only: written });
  assert.equal(r2.changes.length, 0);
  assert.deepEqual(r2.changedElsewhere, ['Genres / Action']);
});

test('#7 tool backups with missing identity raise a warning', () => {
  const parsed = parseBackup(JSON.stringify({ format: 'nuvio-art-fixer-backup', version: 1, collections: sampleCollections() }));
  const { errors, warnings } = checkBackupIdentity(parsed.meta, { server: 'https://api.nuvio.tv', userId: 'u', profileId: 1 });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /server, account, profile/);
  // Complete identity: no warning. Missing session user: warning.
  const full = parseBackup(JSON.stringify(buildBackup({ server: 'https://api.nuvio.tv', userId: 'u', profileId: 1, collections: sampleCollections() })));
  assert.equal(checkBackupIdentity(full.meta, { server: 'https://api.nuvio.tv', userId: 'u', profileId: 1 }).warnings.length, 0);
  assert.equal(checkBackupIdentity(full.meta, { server: 'https://api.nuvio.tv', userId: null, profileId: 1 }).warnings.length, 1);
});

test('#9 the timeout also covers a response body that stalls', async () => {
  const client = createClient({
    timeoutMs: 20,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    }),
  });
  await assert.rejects(client.discover(), (e) => e.kind === 'timeout');
});

test('#11 deeply nested or huge backups are rejected cleanly', () => {
  let deep = '0';
  for (let i = 0; i < 10000; i++) deep = `{"x":${deep}}`;
  const text = `[{"id":"c","folders":[{"id":"f","junk":${deep}}]}]`;
  assert.throws(() => parseBackup(text), /nested too deeply/);
  assert.equal(listTiles(sampleCollections()).length, 3);
});
