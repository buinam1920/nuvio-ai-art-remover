import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ART_FIELDS,
  deepEqual,
  parseCollectionsJson,
  parsePullResponse,
  validateCollections,
  listTiles,
  tileKey,
  applyArt,
  artPatch,
  nonArtDifferences,
  buildBackup,
  parseBackup,
  checkBackupIdentity,
  buildArtRestore,
  buildFullRestore,
  classifyWrite,
  canonicalServer,
  backupFileName,
  DataError,
} from '../js/collections.js';
import { sampleCollections, BACKDROP } from './fixtures.js';

const pullRow = (cols, extra = {}) => [{ profile_id: 1, collections_json: cols, updated_at: '2026-11-01T00:00:00Z', ...extra }];

test('ART_FIELDS is exactly the proven 7-field fix and excludes protected fields', () => {
  assert.deepEqual([...ART_FIELDS].sort(), [
    'coverImageUrl', 'focusGifEnabled', 'focusGifUrl', 'heroBackdropUrl', 'hideTitle', 'tileShape', 'titleLogoUrl',
  ]);
  for (const f of ['id', 'sources', 'catalogSources', 'coverEmoji', 'title']) assert.ok(!ART_FIELDS.includes(f));
});

test('deepEqual ignores key order but not values', () => {
  assert.ok(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: null }));
  assert.ok(!deepEqual([1, 2], [2, 1]));
  assert.ok(!deepEqual({ a: '1' }, { a: 1 }));
});

test('parseCollectionsJson accepts strings and arrays, rejects junk', () => {
  const cols = sampleCollections();
  assert.deepEqual(parseCollectionsJson(JSON.stringify(cols)), cols);
  assert.equal(parseCollectionsJson(cols), cols);
  assert.throws(() => parseCollectionsJson('{nope'), DataError);
  assert.throws(() => parseCollectionsJson('{"a":1}'), DataError);
  assert.throws(() => parseCollectionsJson(null), DataError);
});

test('parsePullResponse handles string collections_json and returns updatedAt', () => {
  const cols = sampleCollections();
  const r = parsePullResponse(pullRow(JSON.stringify(cols)), 1);
  assert.deepEqual(r.collections, cols);
  assert.equal(r.updatedAt, '2026-11-01T00:00:00Z');
});

test('parsePullResponse aborts on empty, wrong profile, malformed or non-list responses', () => {
  assert.throws(() => parsePullResponse([], 1), /no collections/);
  assert.throws(() => parsePullResponse(pullRow([]), 1), /no collections/);
  assert.throws(() => parsePullResponse(pullRow(sampleCollections()), 2), /profile 2/);
  assert.throws(() => parsePullResponse({ message: 'error' }, 1), /not a list/);
  assert.throws(() => parsePullResponse(pullRow('not json'), 1), /not valid JSON/);
  const dup = sampleCollections();
  dup[0].folders[1].id = dup[0].folders[0].id;
  assert.throws(() => parsePullResponse(pullRow(dup), 1), /duplicate tile id/);
});

test('validateCollections reports duplicates and missing ids', () => {
  assert.deepEqual(validateCollections(sampleCollections()), []);
  const bad = sampleCollections();
  bad[1].id = bad[0].id;
  delete bad[0].folders[0].id;
  const problems = validateCollections(bad);
  assert.ok(problems.some((p) => p.includes('duplicate collection id')));
  assert.ok(problems.some((p) => p.includes('has no id')));
});

test('listTiles flattens tiles with keys and art', () => {
  const tiles = listTiles(sampleCollections());
  assert.equal(tiles.length, 3);
  assert.equal(tiles[0].key, tileKey('collections.genres', 'f-action'));
  assert.equal(tiles[0].art.coverImageUrl, 'https://ai.example/action.png');
  assert.equal(tiles[2].catalogSources[0].catalogId, 'netflix.popular');
  assert.ok(!('coverImageUrl' in tiles[1].art), 'absent fields stay absent');
});

test('artPatch matches the proven fix and rejects non-https URLs', () => {
  assert.deepEqual(artPatch(BACKDROP), {
    coverImageUrl: BACKDROP,
    heroBackdropUrl: BACKDROP,
    focusGifUrl: null,
    focusGifEnabled: false,
    titleLogoUrl: null,
    tileShape: 'LANDSCAPE',
    hideTitle: false,
  });
  assert.throws(() => artPatch('http://x/y.png'), DataError);
  assert.throws(() => artPatch('javascript:alert(1)'), DataError);
});

test('applyArt changes only art fields of picked tiles and preserves everything else', () => {
  const before = sampleCollections();
  const snapshot = JSON.parse(JSON.stringify(before));
  const key = tileKey('collections.genres', 'f-action');
  const { collections, changes, missing } = applyArt(before, new Map([[key, BACKDROP]]));

  assert.deepEqual(before, snapshot, 'input not mutated');
  assert.deepEqual(missing, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].title, 'Action');

  const tile = collections[0].folders[0];
  assert.equal(tile.coverImageUrl, BACKDROP);
  assert.equal(tile.heroBackdropUrl, BACKDROP);
  assert.equal(tile.focusGifUrl, null);
  assert.equal(tile.focusGifEnabled, false);
  assert.equal(tile.titleLogoUrl, null);
  assert.equal(tile.tileShape, 'LANDSCAPE');
  assert.equal(tile.hideTitle, false);
  // protected + unknown fields untouched
  assert.deepEqual(tile.catalogSources, snapshot[0].folders[0].catalogSources);
  assert.deepEqual(tile.sources, snapshot[0].folders[0].sources);
  assert.equal(tile.id, 'f-action');
  assert.equal(tile.coverEmoji, '💥');
  assert.deepEqual(tile.someFutureField, { nested: [1, 2, 3] });
  // un-picked tiles and collection settings identical
  assert.deepEqual(collections[0].folders[1], snapshot[0].folders[1]);
  assert.deepEqual(collections[1], snapshot[1]);
  assert.equal(collections[0].pinToTop, true);
  assert.deepEqual(nonArtDifferences(snapshot, collections), []);
});

test('applyArt accepts plain objects, reports unknown keys, skips no-op changes', () => {
  const cols = applyArt(sampleCollections(), { [tileKey('collections.genres', 'f-action')]: BACKDROP }).collections;
  const again = applyArt(cols, { [tileKey('collections.genres', 'f-action')]: BACKDROP, 'nope::x': BACKDROP });
  assert.equal(again.changes.length, 0);
  assert.deepEqual(again.missing, ['nope::x']);
});

test('applyArt adds art fields to a tile that had none', () => {
  const key = tileKey('collections.genres', 'f-horror');
  const { collections, changes } = applyArt(sampleCollections(), { [key]: BACKDROP });
  assert.equal(collections[0].folders[1].coverImageUrl, BACKDROP);
  assert.equal(changes[0].delta.coverImageUrl.from, undefined);
});

test('nonArtDifferences catches changes outside the art fields', () => {
  const a = sampleCollections();
  const b = sampleCollections();
  b[0].folders[0].catalogSources = [];
  assert.equal(nonArtDifferences(a, b).length, 1);
  const c = sampleCollections();
  c.pop();
  assert.ok(nonArtDifferences(a, c).some((p) => p.includes('count')));
});

test('buildBackup / parseBackup round-trip with identity', () => {
  const cols = sampleCollections();
  const backup = buildBackup({
    server: 'https://API.nuvio.tv/',
    userId: 'u1',
    profileId: 1,
    profileName: 'Main',
    updatedAt: 'ts',
    collections: cols,
    now: new Date('2026-11-09T10:00:00Z'),
  });
  assert.equal(backup.server, 'https://api.nuvio.tv');
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.collections, cols);
  assert.equal(parsed.meta.kind, 'tool');
  assert.equal(parsed.meta.userId, 'u1');
  assert.equal(backupFileName(1, new Date('2026-11-09T10:00:00Z')), 'nuvio-backup-profile1-2026-11-09T10-00-00-000.json');
});

test('parseBackup accepts raw pull rows and bare arrays, rejects junk', () => {
  const cols = sampleCollections();
  assert.equal(parseBackup(JSON.stringify(pullRow(JSON.stringify(cols)))).meta.kind, 'pull');
  assert.equal(parseBackup(JSON.stringify(cols)).meta.kind, 'bare');
  assert.throws(() => parseBackup('nope'), /not valid JSON/);
  assert.throws(() => parseBackup('{"x":1}'), /does not look like/);
  assert.throws(() => parseBackup('[]'), /no collections/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'nuvio-art-fixer-backup', version: 99, collections: cols })), /version/);
  assert.throws(() => parseBackup(JSON.stringify([...pullRow(cols), ...pullRow(cols, { profile_id: 2 })])), /more than one/);
});

test('checkBackupIdentity blocks other server, account or profile', () => {
  const session = { server: 'https://api.nuvio.tv', userId: 'u1', profileId: 1 };
  const meta = { server: 'https://api.nuvio.tv', userId: 'u1', profileId: 1, kind: 'tool' };
  assert.deepEqual(checkBackupIdentity(meta, session), { errors: [], warnings: [] });
  assert.equal(checkBackupIdentity({ ...meta, userId: 'u2' }, session).errors.length, 1);
  assert.equal(checkBackupIdentity({ ...meta, profileId: 2 }, session).errors.length, 1);
  assert.equal(checkBackupIdentity({ ...meta, server: 'https://evil.example' }, session).errors.length, 1);
  const bare = checkBackupIdentity({ server: null, userId: null, profileId: null, kind: 'bare' }, session);
  assert.equal(bare.errors.length, 0);
  assert.equal(bare.warnings.length, 1);
});

test('buildArtRestore restores only art fields and keeps tiles added later', () => {
  const backupCols = sampleCollections();
  const key = tileKey('collections.genres', 'f-action');
  const current = applyArt(backupCols, { [key]: BACKDROP, [tileKey('collections.genres', 'f-horror')]: BACKDROP }).collections;
  // user later added a tile and renamed a collection
  current[1].folders.push({ id: 'f-new', title: 'New tile', coverImageUrl: 'https://x/y.png' });
  current[0].title = 'Genres (renamed)';

  const { collections, changes, matched, notInCurrent } = buildArtRestore(current, backupCols);
  assert.equal(matched, 3);
  assert.equal(changes.length, 2);
  assert.deepEqual(notInCurrent, []);
  assert.equal(collections[0].title, 'Genres (renamed)', 'non-art edits kept');
  assert.equal(collections[1].folders.length, 2, 'new tile kept');
  assert.deepEqual(collections[0].folders[0], backupCols[0].folders[0], 'art restored exactly');
  // fields absent in the backup are removed again, not set to null
  assert.ok(!('coverImageUrl' in collections[0].folders[1]));
  assert.ok(!('focusGifUrl' in collections[0].folders[1]));
  assert.deepEqual(collections[0].folders[1], backupCols[0].folders[1]);
});

test('buildArtRestore reports backup tiles that no longer exist', () => {
  const backupCols = sampleCollections();
  const current = sampleCollections();
  current[0].folders.pop();
  assert.deepEqual(buildArtRestore(current, backupCols).notInCurrent, [tileKey('collections.genres', 'f-horror')]);
});

test('buildFullRestore returns the backup and lists what would be lost', () => {
  const backupCols = sampleCollections();
  const current = sampleCollections();
  current.push({ id: 'collections.mine', title: 'Mine', folders: [{ id: 'z', title: 'Z' }] });
  const r = buildFullRestore(current, backupCols);
  assert.deepEqual(r.collections, backupCols);
  assert.notEqual(r.collections, backupCols, 'payload is a copy');
  assert.deepEqual(r.removedCollections, ['Mine']);
  assert.deepEqual(r.removedTiles, ['Mine / Z']);
  assert.deepEqual(r.addedCollections, []);
  assert.equal(r.identical, false);
  assert.equal(buildFullRestore(backupCols, backupCols).identical, true);
});

test('classifyWrite', () => {
  const before = sampleCollections();
  const expected = applyArt(before, { [tileKey('collections.genres', 'f-action')]: BACKDROP }).collections;
  assert.equal(classifyWrite(expected, expected, before), 'applied');
  assert.equal(classifyWrite(before, expected, before), 'unchanged');
  assert.equal(classifyWrite([], expected, before), 'conflict');
});

test('canonicalServer normalizes case and trailing slashes', () => {
  assert.equal(canonicalServer('https://API.Nuvio.tv///'), 'https://api.nuvio.tv');
  assert.equal(canonicalServer('https://host.example/sub/'), 'https://host.example/sub');
});
