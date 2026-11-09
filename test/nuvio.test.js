import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, assertSafeServerUrl, ApiError } from '../js/nuvio.js';

const KEY = 'pk_test';
const BACKEND = 'https://backend.example';

/** Tiny fetch mock: routes is [[matcher(url, init), responder(url, init)]] */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, respond] of routes) {
      if (match(url, init)) {
        const r = await respond(url, init);
        const status = r.status ?? 200;
        const text = r.raw ?? (r.json === undefined ? '' : JSON.stringify(r.json));
        return { ok: status >= 200 && status < 300, status, text: async () => text };
      }
    }
    return { ok: false, status: 404, text: async () => '{"message":"not found"}' };
  };
  fn.calls = calls;
  return fn;
}

const discovery = [(u) => u.endsWith('/.well-known/nuvio'), () => ({ json: { backend_url: BACKEND, publishable_key: KEY } })];
const token = [
  (u) => u.includes('/auth/v1/token'),
  () => ({ json: { access_token: 'tok123', user: { id: 'user-1', email: 'a@b.c' } } }),
];

async function signedInClient(extraRoutes = []) {
  const fetch = mockFetch([discovery, token, ...extraRoutes]);
  const client = createClient({ server: 'https://api.nuvio.tv', fetch });
  await client.login('a@b.c', 'secret-pw');
  return { client, fetch };
}

test('assertSafeServerUrl requires https except localhost', () => {
  assert.equal(assertSafeServerUrl('https://api.nuvio.tv/'), 'https://api.nuvio.tv');
  assert.equal(assertSafeServerUrl('http://localhost:54321'), 'http://localhost:54321');
  assert.throws(() => assertSafeServerUrl('http://api.nuvio.tv'), ApiError);
  assert.throws(() => assertSafeServerUrl('ftp://x'), ApiError);
  assert.throws(() => assertSafeServerUrl('not a url'), ApiError);
  assert.throws(() => assertSafeServerUrl('https://user:pw@host.example'), ApiError);
});

test('discover reads backend_url and key at runtime and validates them', async () => {
  const client = createClient({ fetch: mockFetch([discovery]) });
  assert.deepEqual(await client.discover(), { backendUrl: BACKEND, backendHost: 'backend.example' });

  const insecure = createClient({
    fetch: mockFetch([[(u) => u.includes('well-known'), () => ({ json: { backend_url: 'http://evil.example', publishable_key: 'k' } })]]),
  });
  await assert.rejects(insecure.discover(), /https/);
  const junk = createClient({ fetch: mockFetch([[(u) => u.includes('well-known'), () => ({ json: { hello: 1 } })]]) });
  await assert.rejects(junk.discover(), /discovery/);
});

test('login sends credentials only to the auth endpoint and keeps the token in memory', async () => {
  const { client, fetch } = await signedInClient();
  const auth = fetch.calls.find((c) => c.url.includes('/auth/v1/token'));
  assert.equal(auth.url, `${BACKEND}/auth/v1/token?grant_type=password`);
  assert.equal(auth.init.method, 'POST');
  assert.equal(auth.init.headers.apikey, KEY);
  assert.deepEqual(auth.body, { email: 'a@b.c', password: 'secret-pw' });
  assert.equal(auth.init.credentials, 'omit');
  // password went nowhere else
  for (const c of fetch.calls.filter((x) => x !== auth)) assert.ok(!JSON.stringify(c).includes('secret-pw'));
  assert.equal(client.signedIn, true);
  assert.deepEqual(client.user, { id: 'user-1', email: 'a@b.c' });
  // the client object exposes no token or password
  assert.ok(!JSON.stringify(Object.getOwnPropertyNames(client).map((k) => [k, String(client[k])])).includes('tok123'));
});

test('login failure surfaces the server message', async () => {
  const fetch = mockFetch([
    discovery,
    [(u) => u.includes('/auth/v1/token'), () => ({ status: 400, json: { error_description: 'Invalid login credentials' } })],
  ]);
  const client = createClient({ fetch });
  await assert.rejects(client.login('a', 'b'), (e) => e instanceof ApiError && e.status === 400 && /Invalid login/.test(e.message));
  assert.equal(client.signedIn, false);
});

test('authenticated calls send Bearer token plus apikey', async () => {
  const { client, fetch } = await signedInClient([
    [(u) => u.includes('/rest/v1/profiles'), () => ({ json: [{ profile_id: 1, name: 'Me', avatar_color_hex: '#112233' }, { profile_id: 2, name: '' }] })],
  ]);
  const profiles = await client.listProfiles();
  assert.deepEqual(profiles, [
    { id: 1, name: 'Me', color: '#112233' },
    { id: 2, name: 'Profile 2', color: null },
  ]);
  const call = fetch.calls.at(-1);
  assert.equal(call.init.headers.Authorization, 'Bearer tok123');
  assert.equal(call.init.headers.apikey, KEY);
  assert.ok(!call.url.includes('pin_hash'), 'never selects PIN hashes');
});

test('listProfiles falls back to profile 1 when none are listed', async () => {
  const { client } = await signedInClient([[(u) => u.includes('/rest/v1/profiles'), () => ({ json: [] })]]);
  assert.deepEqual(await client.listProfiles(), [{ id: 1, name: 'Main profile', color: null }]);
});

test('pull and push use the RPC contract', async () => {
  const { client, fetch } = await signedInClient([
    [(u) => u.endsWith('/rpc/sync_pull_collections'), () => ({ json: [{ profile_id: 2, collections_json: '[]', updated_at: 't' }] })],
    [(u) => u.endsWith('/rpc/sync_push_collections'), () => ({ status: 204, raw: '' })],
  ]);
  const rows = await client.pullCollections(2);
  assert.equal(rows[0].profile_id, 2);
  assert.deepEqual(fetch.calls.at(-1).body, { p_profile_id: 2 });

  await client.pushCollections(2, [{ id: 'c', folders: [] }]);
  const push = fetch.calls.at(-1).body;
  assert.equal(push.p_profile_id, 2);
  assert.deepEqual(push.p_collections_json, [{ id: 'c', folders: [] }], 'sent as JSON array, not a string');
  assert.match(push.p_origin_client_id, /^nuvio-ai-art-remover-/);
});

test('push refuses an empty set without calling the server', async () => {
  const { client, fetch } = await signedInClient();
  const before = fetch.calls.length;
  await assert.rejects(client.pushCollections(1, []), /empty/);
  await assert.rejects(client.pushCollections(1, null), /empty/);
  assert.equal(fetch.calls.length, before);
});

test('401 clears the token; calls after logout are refused locally', async () => {
  const { client, fetch } = await signedInClient([
    [(u) => u.includes('sync_pull'), () => ({ status: 401, json: { message: 'JWT expired' } })],
    [(u) => u.includes('/auth/v1/logout'), () => ({ status: 204 })],
  ]);
  await assert.rejects(client.pullCollections(1), /JWT expired/);
  assert.equal(client.signedIn, false);
  const n = fetch.calls.length;
  await assert.rejects(client.pullCollections(1), /signed out/);
  assert.equal(fetch.calls.length, n);
});

test('logout revokes server-side and forgets the user', async () => {
  const { client, fetch } = await signedInClient([[(u) => u.includes('/auth/v1/logout'), () => ({ status: 204 })]]);
  await client.logout();
  assert.ok(fetch.calls.some((c) => c.url.endsWith('/auth/v1/logout')));
  assert.equal(client.signedIn, false);
  assert.equal(client.user, null);
});

test('network failures and timeouts become ApiError with kind', async () => {
  const failing = createClient({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(failing.discover(), (e) => e.kind === 'network');

  const slow = createClient({
    timeoutMs: 20,
    fetch: (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))),
  });
  await assert.rejects(slow.discover(), (e) => e.kind === 'timeout');
});

test('non-JSON success bodies are rejected', async () => {
  const client = createClient({ fetch: mockFetch([[() => true, () => ({ raw: '<html>' })]]) });
  await assert.rejects(client.discover(), (e) => e.kind === 'shape');
});
