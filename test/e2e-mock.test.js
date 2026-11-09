// End-to-end over real HTTP against tools/mock-server.mjs (a fake Nuvio server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '../js/nuvio.js';
import { applyArt, buildBackup, parseBackup, buildArtRestore, buildFullRestore, listTiles, nonArtDifferences, deepEqual } from '../js/collections.js';
import { guardedWrite, pullSnapshot, ConflictError } from '../js/workflow.js';

const PORT = 18787 + Math.floor(Math.random() * 1000);
const SERVER = `http://localhost:${PORT}`;
const BACKDROP = (id) => `https://images.metahub.space/background/large/${id}/img`;
let proc;

test.before(async () => {
  proc = spawn(process.execPath, [fileURLToPath(new URL('../tools/mock-server.mjs', import.meta.url)), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => d.toString().includes('Mock Nuvio') && resolve());
    proc.on('exit', reject);
  });
});
test.after(() => proc?.kill());

async function signIn() {
  const client = createClient({ server: SERVER });
  await client.discover();
  await client.login('test@example.com', 'test');
  return client;
}

test('wrong password is rejected', async () => {
  const client = createClient({ server: SERVER });
  await assert.rejects(client.login('test@example.com', 'nope'), /Invalid login/);
});

test('full flow: backup -> apply -> verify -> art restore -> full restore', async () => {
  await fetch(`${SERVER}/__mock/reset`, { method: 'POST' });
  const client = await signIn();
  const profiles = await client.listProfiles();
  assert.deepEqual(profiles.map((p) => p.id), [1, 2]);

  const original = await pullSnapshot(client, 1);
  const backup = buildBackup({ server: client.server, userId: client.user.id, profileId: 1, updatedAt: original.updatedAt, collections: original.collections });
  const backupText = JSON.stringify(backup);

  // Apply art to two tiles
  const tiles = listTiles(original.collections);
  const picks = new Map([
    [tiles.find((t) => t.title === 'Action').key, BACKDROP('tt0468569')],
    [tiles.find((t) => t.title === 'Netflix').key, BACKDROP('tt4574334')],
  ]);
  const { collections: payload, changes } = applyArt(original.collections, picks);
  assert.equal(changes.length, 2);
  const applied = await guardedWrite({ client, profileId: 1, base: original, payload });
  assert.equal(applied.status, 'applied');
  assert.deepEqual(nonArtDifferences(original.collections, applied.snapshot.collections), []);
  const action = applied.snapshot.collections[0].folders[0];
  assert.equal(action.coverImageUrl, BACKDROP('tt0468569'));
  assert.equal(action.focusGifEnabled, false);
  assert.deepEqual(applied.snapshot.collections[2].unknownCollectionField, { keep: 'me' }, 'unknown fields survive the round-trip');

  // Profile 2 untouched
  const p2 = await pullSnapshot(client, 2);
  assert.equal(p2.collections[0].folders[0].tileShape, 'POSTER');

  // Artwork-only restore brings back the exact original
  const parsed = parseBackup(backupText);
  const current = applied.snapshot;
  const art = buildArtRestore(current.collections, parsed.collections);
  assert.equal(art.changes.length, 2);
  const restored = await guardedWrite({ client, profileId: 1, base: current, payload: art.collections });
  assert.ok(deepEqual(restored.snapshot.collections, original.collections), 'round-trip returns the original collections');

  // Full restore of an identical backup is a no-op
  const full = buildFullRestore(restored.snapshot.collections, parsed.collections);
  assert.equal(full.identical, true);
  const noop = await guardedWrite({ client, profileId: 1, base: restored.snapshot, payload: full.collections });
  assert.equal(noop.status, 'nothing-to-do');
});

test('edit from another device between load and save aborts the write', async () => {
  await fetch(`${SERVER}/__mock/reset`, { method: 'POST' });
  const client = await signIn();
  const base = await pullSnapshot(client, 1);
  const key = listTiles(base.collections)[0].key;
  const { collections: payload } = applyArt(base.collections, { [key]: BACKDROP('tt0468569') });
  await fetch(`${SERVER}/__mock/touch?profile=1`, { method: 'POST' });
  await assert.rejects(guardedWrite({ client, profileId: 1, base, payload }), ConflictError);
  const state = await (await fetch(`${SERVER}/__mock/state?profile=1`)).json();
  assert.match(state.collections[0].title, /\(edited\)/, 'the other device’s edit is preserved');
  assert.notEqual(state.collections[0].folders[0].coverImageUrl, BACKDROP('tt0468569'));
});

test('signed-out client cannot pull', async () => {
  const client = await signIn();
  await client.logout();
  await assert.rejects(client.pullCollections(1), /signed out/);
});
