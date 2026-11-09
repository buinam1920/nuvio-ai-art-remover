// Pure data logic for Nuvio collections. No DOM, no network.
// Everything here works on plain JSON values and never mutates its inputs.

/** The only tile fields this tool ever writes. Everything else is preserved untouched. */
export const ART_FIELDS = Object.freeze([
  'coverImageUrl',
  'heroBackdropUrl',
  'focusGifUrl',
  'focusGifEnabled',
  'titleLogoUrl',
  'tileShape',
  'hideTitle',
]);

export const BACKUP_FORMAT = 'nuvio-art-fixer-backup';
export const BACKUP_VERSION = 1;

const SEP = '::';

export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function tileKey(collectionId, folderId) {
  return `${collectionId}${SEP}${folderId}`;
}

/** Key-order-insensitive deep equality for JSON values. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b) || typeof a !== 'object') return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** Parse collections_json, which the server may return as a JSON string or as an array. */
export function parseCollectionsJson(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new DataError('collections_json is not valid JSON.');
    }
  }
  if (!Array.isArray(v)) throw new DataError('collections_json is not a list of collections.');
  return v;
}

/**
 * Turn the sync_pull_collections response into { collections, updatedAt }.
 * Throws if the response is malformed or has no collections, so callers abort before any write.
 */
export function parsePullResponse(rows, profileId) {
  if (!Array.isArray(rows)) throw new DataError('Unexpected response from the server (not a list).');
  if (rows.length === 0) throw new DataError('The server returned no collections for this profile.');
  const matching = rows.filter((r) => isObj(r) && Number(r.profile_id) === Number(profileId));
  if (matching.length !== 1) {
    throw new DataError(`Expected one collections row for profile ${profileId}, got ${matching.length}.`);
  }
  const row = matching[0];
  const collections = parseCollectionsJson(row.collections_json);
  if (collections.length === 0) throw new DataError('This profile has no collections.');
  const problems = validateCollections(collections);
  if (problems.length) throw new DataError(`Collections look malformed: ${problems.slice(0, 3).join('; ')}`);
  return { collections, updatedAt: row.updated_at ?? null };
}

/** Returns a list of human-readable problems; empty means the shape is safe to work with. */
export function validateCollections(collections) {
  const problems = [];
  if (!Array.isArray(collections)) return ['collections is not a list'];
  const colIds = new Set();
  collections.forEach((c, ci) => {
    if (!isObj(c)) return problems.push(`collection #${ci + 1} is not an object`);
    if (typeof c.id !== 'string' || !c.id) problems.push(`collection #${ci + 1} has no id`);
    else if (colIds.has(c.id)) problems.push(`duplicate collection id "${c.id}"`);
    else colIds.add(c.id);
    if (c.folders === undefined || c.folders === null) return;
    if (!Array.isArray(c.folders)) return problems.push(`collection "${c.id}" folders is not a list`);
    const folderIds = new Set();
    c.folders.forEach((f, fi) => {
      if (!isObj(f)) return problems.push(`tile #${fi + 1} in "${c.id}" is not an object`);
      if (typeof f.id !== 'string' || !f.id) problems.push(`tile #${fi + 1} in "${c.id}" has no id`);
      else if (folderIds.has(f.id)) problems.push(`duplicate tile id "${f.id}" in "${c.id}"`);
      else folderIds.add(f.id);
    });
  });
  return problems;
}

/** Pick only the art fields of a tile; absent fields stay absent. */
export function pickArt(folder) {
  const out = {};
  for (const f of ART_FIELDS) if (Object.prototype.hasOwnProperty.call(folder, f)) out[f] = folder[f];
  return out;
}

/** Flatten collections into a list of tiles for the UI. */
export function listTiles(collections) {
  const tiles = [];
  for (const c of collections) {
    for (const f of Array.isArray(c.folders) ? c.folders : []) {
      tiles.push({
        key: tileKey(c.id, f.id),
        collectionId: c.id,
        collectionTitle: typeof c.title === 'string' ? c.title : c.id,
        folderId: f.id,
        title: typeof f.title === 'string' ? f.title : '',
        catalogSources: Array.isArray(f.catalogSources) ? f.catalogSources : [],
        coverEmoji: typeof f.coverEmoji === 'string' ? f.coverEmoji : '',
        art: pickArt(f),
      });
    }
  }
  return tiles;
}

/** The art values the tool writes for a chosen backdrop. Matches the fix proven on a real account. */
export function artPatch(backdropUrl) {
  if (!isSafeImageUrl(backdropUrl)) throw new DataError(`Refusing to write a non-https image URL: ${backdropUrl}`);
  return {
    coverImageUrl: backdropUrl,
    heroBackdropUrl: backdropUrl,
    focusGifUrl: null,
    focusGifEnabled: false,
    titleLogoUrl: null,
    tileShape: 'LANDSCAPE',
    hideTitle: false,
  };
}

export function isSafeImageUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Compare the art fields of two tiles. Returns { field: {from, to} } for fields that differ.
 * A field that is absent is reported as undefined.
 */
function artDelta(before, after) {
  const delta = {};
  for (const f of ART_FIELDS) {
    const hasB = Object.prototype.hasOwnProperty.call(before, f);
    const hasA = Object.prototype.hasOwnProperty.call(after, f);
    if (hasB !== hasA || !deepEqual(before[f], after[f])) {
      delta[f] = { from: hasB ? before[f] : undefined, to: hasA ? after[f] : undefined };
    }
  }
  return delta;
}

/** Map over every tile, returning a new collections array. fn returns the new folder or the same one. */
function mapTiles(collections, fn) {
  return collections.map((c) => {
    if (!Array.isArray(c.folders)) return clone(c);
    return { ...clone(c), folders: c.folders.map((f) => fn(c, clone(f))) };
  });
}

/**
 * Apply picks to collections.
 * picks: Map or object of tileKey -> backdropUrl.
 * Only ART_FIELDS of picked tiles change; all other fields (id, sources, catalogSources,
 * coverEmoji, unknown fields, collection settings) are preserved exactly.
 */
export function applyArt(collections, picks) {
  const map = picks instanceof Map ? picks : new Map(Object.entries(picks ?? {}));
  const seen = new Set();
  const changes = [];
  const next = mapTiles(collections, (c, f) => {
    const key = tileKey(c.id, f.id);
    if (!map.has(key)) return f;
    seen.add(key);
    const updated = { ...f, ...artPatch(map.get(key)) };
    const delta = artDelta(f, updated);
    if (Object.keys(delta).length) changes.push({ key, collectionTitle: c.title ?? c.id, title: f.title ?? '', delta });
    return updated;
  });
  const missing = [...map.keys()].filter((k) => !seen.has(k));
  return { collections: next, changes, missing };
}

/**
 * Check that two collection sets differ only in ART_FIELDS of existing tiles.
 * Returns a list of problems (empty = safe).
 */
export function nonArtDifferences(before, after) {
  const problems = [];
  const strip = (cols) =>
    cols.map((c) =>
      Array.isArray(c.folders)
        ? {
            ...c,
            folders: c.folders.map((f) => {
              const g = { ...f };
              for (const k of ART_FIELDS) delete g[k];
              return g;
            }),
          }
        : c,
    );
  if (!Array.isArray(before) || !Array.isArray(after)) return ['not a list'];
  if (before.length !== after.length) problems.push(`collection count changed ${before.length} -> ${after.length}`);
  const sb = strip(before);
  const sa = strip(after);
  for (let i = 0; i < Math.min(sb.length, sa.length); i++) {
    if (!deepEqual(sb[i], sa[i])) problems.push(`non-art data differs in collection "${sb[i]?.id ?? i}"`);
  }
  return problems;
}

// ---------- Backups ----------

/** Canonical form of a server URL, used to bind backups to a server. */
export function canonicalServer(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

export function buildBackup({ server, userId, profileId, profileName, updatedAt, collections, now = new Date() }) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    server: canonicalServer(server),
    userId: userId ?? null,
    profileId: Number(profileId),
    profileName: profileName ?? null,
    updatedAt: updatedAt ?? null,
    collections: clone(collections),
  };
}

export function backupFileName(profileId, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `nuvio-backup-profile${profileId}-${stamp}.json`;
}

/**
 * Parse a backup file's text. Accepts:
 *  - this tool's backup format (with server/user/profile identity)
 *  - a raw sync_pull_collections response [{profile_id, collections_json, updated_at}]
 *  - a bare collections array
 * Returns { collections, meta } where meta may lack identity fields (callers must warn).
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DataError('That file is not valid JSON.');
  }
  let collections;
  let meta = { server: null, userId: null, profileId: null, updatedAt: null, createdAt: null, kind: 'unknown' };
  if (isObj(data) && data.format === BACKUP_FORMAT) {
    if (data.version !== BACKUP_VERSION) throw new DataError(`Unsupported backup version ${data.version}.`);
    collections = parseCollectionsJson(data.collections);
    meta = {
      server: data.server ?? null,
      userId: data.userId ?? null,
      profileId: data.profileId ?? null,
      updatedAt: data.updatedAt ?? null,
      createdAt: data.createdAt ?? null,
      kind: 'tool',
    };
  } else if (Array.isArray(data) && data.length > 0 && isObj(data[0]) && 'collections_json' in data[0]) {
    if (data.length !== 1) throw new DataError('Backup contains more than one profile row; cannot tell which to use.');
    collections = parseCollectionsJson(data[0].collections_json);
    meta = { ...meta, profileId: data[0].profile_id ?? null, updatedAt: data[0].updated_at ?? null, kind: 'pull' };
  } else if (Array.isArray(data)) {
    collections = data;
    meta.kind = 'bare';
  } else {
    throw new DataError('This does not look like a Nuvio collections backup.');
  }
  if (collections.length === 0) throw new DataError('The backup contains no collections.');
  const problems = validateCollections(collections);
  if (problems.length) throw new DataError(`Backup looks malformed: ${problems.slice(0, 3).join('; ')}`);
  return { collections, meta };
}

/**
 * Decide whether a backup may be restored into the current session.
 * errors block the restore; warnings must be shown to the user.
 */
export function checkBackupIdentity(meta, session) {
  const errors = [];
  const warnings = [];
  if (meta.server && canonicalServer(meta.server) !== canonicalServer(session.server)) {
    errors.push(`Backup is from server ${meta.server}, but you are signed in to ${canonicalServer(session.server)}.`);
  }
  if (meta.userId && session.userId && meta.userId !== session.userId) {
    errors.push('Backup belongs to a different Nuvio account.');
  }
  if (meta.profileId != null && Number(meta.profileId) !== Number(session.profileId)) {
    errors.push(`Backup is for profile ${meta.profileId}, but profile ${session.profileId} is selected.`);
  }
  if (meta.kind !== 'tool') {
    warnings.push('This file has no account information, so the tool cannot confirm it belongs to this account and profile.');
  }
  return { errors, warnings };
}

/**
 * Artwork-only restore: start from the CURRENT collections and copy ART_FIELDS back from the
 * backup for tiles that exist in both (matched by collection id + tile id). Fields absent in the
 * backup are removed again. Collections/tiles added since the backup are left alone.
 */
export function buildArtRestore(current, backup) {
  const backupTiles = new Map();
  for (const c of backup) for (const f of Array.isArray(c.folders) ? c.folders : []) backupTiles.set(tileKey(c.id, f.id), f);
  const changes = [];
  let matched = 0;
  const next = mapTiles(current, (c, f) => {
    const key = tileKey(c.id, f.id);
    const old = backupTiles.get(key);
    if (!old) return f;
    matched++;
    const updated = { ...f };
    for (const k of ART_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(old, k)) updated[k] = clone(old[k]);
      else delete updated[k];
    }
    const delta = artDelta(f, updated);
    if (Object.keys(delta).length) changes.push({ key, collectionTitle: c.title ?? c.id, title: f.title ?? '', delta });
    return updated;
  });
  const currentKeys = new Set(listTiles(current).map((t) => t.key));
  const notInCurrent = [...backupTiles.keys()].filter((k) => !currentKeys.has(k));
  return { collections: next, changes, matched, notInCurrent };
}

/**
 * Full restore: the payload is the backup itself. Reports what the current set would lose.
 */
export function buildFullRestore(current, backup) {
  const backupColIds = new Set(backup.map((c) => c.id));
  const backupTileKeys = new Set(listTiles(backup).map((t) => t.key));
  const removedCollections = current.filter((c) => !backupColIds.has(c.id)).map((c) => c.title ?? c.id);
  const removedTiles = listTiles(current).filter((t) => !backupTileKeys.has(t.key)).map((t) => `${t.collectionTitle} / ${t.title}`);
  const currentColIds = new Set(current.map((c) => c.id));
  const addedCollections = backup.filter((c) => !currentColIds.has(c.id)).map((c) => c.title ?? c.id);
  return {
    collections: clone(backup),
    removedCollections,
    removedTiles,
    addedCollections,
    identical: deepEqual(current, backup),
  };
}

/**
 * After a write attempt, classify what the server now holds.
 * 'applied' | 'unchanged' | 'conflict'
 */
export function classifyWrite(pulled, expected, before) {
  if (deepEqual(pulled, expected)) return 'applied';
  if (deepEqual(pulled, before)) return 'unchanged';
  return 'conflict';
}
