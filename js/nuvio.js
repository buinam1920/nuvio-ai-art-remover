// Minimal client for the (unofficial) Nuvio sync API.
// The password is passed straight to the auth endpoint and never kept.
// The access token lives only inside this closure, in memory.

import { assertLosslessNumbers, assertJsonLimits } from './collections.js';

export const DEFAULT_SERVER = 'https://api.nuvio.tv';

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, kind = 'http' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.kind = kind; // 'http' | 'network' | 'timeout' | 'shape'
  }
}

/** Only https URLs are allowed, except plain http on localhost for self-hosting/dev. */
export function assertSafeServerUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new ApiError('That server address is not a valid URL.', { kind: 'shape' });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new ApiError('The server must use https://', { kind: 'shape' });
  }
  if (u.username || u.password) throw new ApiError('The server URL must not contain credentials.', { kind: 'shape' });
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function newClientId() {
  const c = globalThis.crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `nuvio-art-fixer-${id}`;
}

/**
 * createClient({ server, fetch, timeoutMs }) -> client
 * All network calls go through the injected fetch so tests can mock them.
 */
export function createClient({ server = DEFAULT_SERVER, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 20000 } = {}) {
  const serverUrl = assertSafeServerUrl(server);
  let backendUrl = null;
  let apiKey = null;
  let token = null;
  let user = null;
  const originClientId = newClientId();

  async function request(url, { method = 'GET', headers = {}, body, auth = true } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (apiKey) h.apikey = apiKey;
    if (auth) {
      if (!token) throw new ApiError('You are signed out. Please sign in again.', { status: 401 });
      h.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        // Never follow redirects: a redirect could carry the password (or token) to a host the user never saw.
        redirect: 'error',
      });
      // The timeout also covers reading the body, so a stalled response cannot hang the app.
      text = await res.text();
    } catch (err) {
      if (err?.name === 'AbortError') throw new ApiError('The server took too long to answer.', { kind: 'timeout' });
      throw new ApiError('Could not reach the server (or it tried to redirect). Check your connection and server address.', { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const msg = data?.error_description || data?.msg || data?.message || data?.error || `HTTP ${res.status}`;
      if (res.status === 401) token = null;
      throw new ApiError(String(msg).slice(0, 300), { status: res.status, code: data?.code ?? data?.error_code ?? null });
    }
    if (text && data === null) throw new ApiError('The server sent a response that is not JSON.', { status: res.status, kind: 'shape' });
    if (text) {
      try {
        assertLosslessNumbers(text);
        assertJsonLimits(data);
      } catch (err) {
        throw new ApiError(err.message, { status: res.status, kind: 'shape' });
      }
    }
    return data;
  }

  return {
    get server() {
      return serverUrl;
    },
    get backendUrl() {
      return backendUrl;
    },
    get user() {
      return user;
    },
    get signedIn() {
      return token !== null;
    },
    originClientId,

    /** Read backend_url and publishable_key from the server's discovery document. */
    async discover() {
      const data = await request(`${serverUrl}/.well-known/nuvio`, { auth: false });
      if (!data || typeof data.backend_url !== 'string' || typeof data.publishable_key !== 'string' || !data.publishable_key) {
        throw new ApiError('This server did not return a valid Nuvio discovery document.', { kind: 'shape' });
      }
      backendUrl = assertSafeServerUrl(data.backend_url);
      apiKey = data.publishable_key;
      return { backendUrl, backendHost: new URL(backendUrl).host };
    },

    /** Exchange email + password for an access token. The password is not stored anywhere. */
    async login(email, password) {
      if (!backendUrl) await this.discover();
      const data = await request(`${backendUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        body: { email, password },
        auth: false,
      });
      if (!data || typeof data.access_token !== 'string') throw new ApiError('Sign-in did not return a token.', { kind: 'shape' });
      token = data.access_token;
      user = { id: data.user?.id ?? null, email: data.user?.email ?? email };
      return user;
    },

    /** Best-effort server-side sign-out, then forget the token. */
    async logout() {
      if (token && backendUrl) {
        try {
          await request(`${backendUrl}/auth/v1/logout`, { method: 'POST' });
        } catch {
          /* ignore */
        }
      }
      token = null;
      user = null;
    },

    async listProfiles() {
      const rows = await request(
        `${backendUrl}/rest/v1/profiles?select=profile_id,profile_index,name,avatar_color_hex&order=profile_index.asc`,
      );
      if (!Array.isArray(rows)) throw new ApiError('Unexpected profiles response.', { kind: 'shape' });
      const profiles = rows
        .filter((r) => r && Number.isInteger(Number(r.profile_id)))
        .map((r) => ({
          id: Number(r.profile_id),
          name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Profile ${r.profile_id}`,
          color: typeof r.avatar_color_hex === 'string' && /^#[0-9a-f]{6}$/i.test(r.avatar_color_hex) ? r.avatar_color_hex : null,
        }));
      return profiles.length ? profiles : [{ id: 1, name: 'Main profile', color: null }];
    },

    /** Raw sync_pull_collections rows: [{profile_id, collections_json, updated_at}] */
    async pullCollections(profileId) {
      return request(`${backendUrl}/rest/v1/rpc/sync_pull_collections`, {
        method: 'POST',
        body: { p_profile_id: Number(profileId) },
      });
    },

    /** Replace the profile's whole collection set. Always pass the full array. */
    async pushCollections(profileId, collections) {
      if (!Array.isArray(collections) || collections.length === 0) {
        throw new ApiError('Refusing to push an empty collection set.', { kind: 'shape' });
      }
      return request(`${backendUrl}/rest/v1/rpc/sync_push_collections`, {
        method: 'POST',
        body: { p_profile_id: Number(profileId), p_collections_json: collections, p_origin_client_id: originClientId },
      });
    },
  };
}
