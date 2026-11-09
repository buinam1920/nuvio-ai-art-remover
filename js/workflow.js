// The guarded write sequence shared by "Apply" and "Restore".
// No DOM here, so it can be tested with a mocked client.

import { parsePullResponse, deepEqual, classifyWrite, DataError } from './collections.js';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Pull + parse in one step. Throws (and so aborts the caller) on failure or an empty result. */
export async function pullSnapshot(client, profileId) {
  const rows = await client.pullCollections(profileId);
  return parsePullResponse(rows, profileId);
}

/** Errors where the request may still reach the server after we gave up on it. */
const isTransportFailure = (err) => err?.kind === 'timeout' || err?.kind === 'network';

/**
 * guardedWrite:
 *  1. Re-pull right before writing and make sure nothing changed since `base` was read
 *     (same updated_at AND same content). Otherwise abort: another device edited collections.
 *  2. Push the full payload.
 *  3. Re-pull and check the server now holds exactly the payload.
 * If the push itself fails, re-pull and classify the outcome instead of retrying, so a write
 * that actually landed is never repeated or rolled back automatically.
 *
 * Returns { status: 'applied' | 'nothing-to-do', snapshot, note? } or throws.
 * Errors thrown after a push was attempted carry `.outcome`:
 *   'unchanged' - the server rejected the save; it still holds the old data
 *   'pending'   - the request failed in transit; the server shows old data now, but the save may still land
 *   'conflict'  - the server holds something other than old data or the payload
 *   'unknown'   - the tool could not read back what the server holds
 */
export async function guardedWrite({ client, profileId, base, payload, onStep = () => {} }) {
  if (!Array.isArray(payload) || payload.length === 0) throw new DataError('Refusing to write an empty collection set.');

  onStep('Checking for changes made on other devices…');
  const fresh = await pullSnapshot(client, profileId);
  if (fresh.updatedAt !== base.updatedAt || !deepEqual(fresh.collections, base.collections)) {
    throw new ConflictError(
      'Your collections changed since they were loaded (maybe from another device). Nothing was written. Reload and try again.',
    );
  }
  if (deepEqual(payload, fresh.collections)) {
    return { status: 'nothing-to-do', snapshot: fresh };
  }

  onStep('Saving to Nuvio…');
  try {
    await client.pushCollections(profileId, payload);
  } catch (err) {
    onStep('Save did not confirm. Checking what the server holds…');
    let outcome = 'unknown';
    let after = null;
    try {
      after = await pullSnapshot(client, profileId);
      outcome = classifyWrite(after.collections, payload, fresh.collections);
    } catch {
      /* keep 'unknown' */
    }
    if (outcome === 'applied') {
      return { status: 'applied', snapshot: after, note: 'The save landed even though the server did not confirm it.' };
    }
    if (outcome === 'unchanged' && isTransportFailure(err)) outcome = 'pending';
    err.outcome = outcome;
    if (after) err.snapshot = after;
    throw err;
  }

  onStep('Verifying…');
  let after;
  try {
    after = await pullSnapshot(client, profileId);
  } catch (err) {
    // The push went through but we could not read it back (e.g. session expired, network).
    err.outcome = 'unknown';
    throw err;
  }
  const outcome = classifyWrite(after.collections, payload, fresh.collections);
  if (outcome !== 'applied') {
    const e = new Error(
      outcome === 'unchanged'
        ? 'The server accepted the save but still holds the old collections.'
        : 'After saving, the server holds something different from what was sent. Your backup file is unaffected.',
    );
    e.outcome = outcome;
    e.snapshot = after;
    throw e;
  }
  return { status: 'applied', snapshot: after };
}
