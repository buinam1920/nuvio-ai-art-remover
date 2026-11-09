import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedWrite, pullSnapshot, ConflictError } from '../js/workflow.js';
import { applyArt, tileKey } from '../js/collections.js';
import { sampleCollections, BACKDROP } from './fixtures.js';

/** In-memory fake of the Nuvio server for one profile. */
function fakeServer({ collections = sampleCollections(), updatedAt = 't0' } = {}) {
  const state = { collections: JSON.parse(JSON.stringify(collections)), updatedAt, pushes: [], n: 0 };
  const client = {
    async pullCollections(profileId) {
      if (state.failPull) throw new Error('pull failed');
      return [{ profile_id: profileId, collections_json: JSON.stringify(state.collections), updated_at: state.updatedAt }];
    },
    async pushCollections(profileId, cols) {
      state.pushes.push(JSON.parse(JSON.stringify(cols)));
      if (state.onPush) return state.onPush(cols);
      state.collections = JSON.parse(JSON.stringify(cols));
      state.updatedAt = `t${++state.n}`;
      return null;
    },
  };
  return { state, client };
}

const key = tileKey('collections.genres', 'f-action');

test('happy path: re-pulls, pushes the full set, verifies', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  const steps = [];
  const r = await guardedWrite({ client, profileId: 1, base, payload, onStep: (s) => steps.push(s) });
  assert.equal(r.status, 'applied');
  assert.equal(state.pushes.length, 1);
  assert.equal(state.pushes[0].length, 2, 'full array pushed');
  assert.equal(r.snapshot.collections[0].folders[0].coverImageUrl, BACKDROP);
  assert.ok(steps.length >= 3);
});

test('aborts without writing if updated_at changed (another device)', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  state.updatedAt = 't-other';
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), ConflictError);
  assert.equal(state.pushes.length, 0);
});

test('aborts without writing if content changed even with the same updated_at', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  state.collections[1].title = 'Edited elsewhere';
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), ConflictError);
  assert.equal(state.pushes.length, 0);
});

test('aborts if the pre-write pull fails or comes back empty', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.failPull = true;
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), /pull failed/);
  state.failPull = false;
  state.collections = [];
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), /no collections/);
  assert.equal(state.pushes.length, 0);
});

test('refuses empty payloads', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload: [] }), /empty/);
  assert.equal(state.pushes.length, 0);
});

test('no-op payload does not push', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const r = await guardedWrite({ client, profileId: 1, base, payload: base.collections });
  assert.equal(r.status, 'nothing-to-do');
  assert.equal(state.pushes.length, 0);
});

test('timeout after commit is detected as applied, not retried', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = (cols) => {
    state.collections = JSON.parse(JSON.stringify(cols));
    state.updatedAt = 't9';
    throw Object.assign(new Error('timeout'), { kind: 'timeout' });
  };
  const r = await guardedWrite({ client, profileId: 1, base, payload });
  assert.equal(r.status, 'applied');
  assert.match(r.note, /landed/);
  assert.equal(state.pushes.length, 1, 'no retry');
});

test('failed push that did not land reports outcome unchanged', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = () => {
    throw new Error('500');
  };
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), (e) => e.outcome === 'unchanged');
  assert.equal(state.pushes.length, 1);
});

test('verification mismatch after push is reported as conflict and never auto-rolled back', async () => {
  const { state, client } = fakeServer();
  const base = await pullSnapshot(client, 1);
  const payload = applyArt(base.collections, { [key]: BACKDROP }).collections;
  state.onPush = (cols) => {
    const mangled = JSON.parse(JSON.stringify(cols));
    mangled[0].folders[0].catalogSources = [];
    state.collections = mangled;
    return null;
  };
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), (e) => e.outcome === 'conflict');
  assert.equal(state.pushes.length, 1, 'exactly one push, no rollback push');
});
