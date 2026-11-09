#!/usr/bin/env node
// A fake Nuvio server for local development and end-to-end testing. Never use real credentials here.
//
//   node tools/mock-server.mjs [port]        (default 8787)
//
// Then sign in on the tool with server http://localhost:8787, email test@example.com, password test.
// Extra endpoints:
//   POST /__mock/touch?profile=1   simulate an edit from another device (bumps updated_at)
//   GET  /__mock/state?profile=1   inspect what the server holds
//   POST /__mock/reset             restore the initial fixture

import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const KEY = 'mock-publishable-key';
const TOKEN = 'mock-access-token';
const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.com' };

const ai = (slug) => ({
  hideTitle: true,
  tileShape: 'POSTER',
  focusGifUrl: `https://images.metahub.space/background/small/tt0000000/img#ai-${slug}.gif`,
  titleLogoUrl: `https://images.metahub.space/logo/medium/tt0000000/img#ai-${slug}`,
  coverImageUrl: `https://images.metahub.space/background/small/tt0000000/img#ai-${slug}`,
  focusGifEnabled: true,
  heroBackdropUrl: `https://images.metahub.space/background/small/tt0000000/img#ai-${slug}-hero`,
});

function folder(id, title, catalogSources, extra = {}) {
  return { id, title, sources: [], coverEmoji: null, catalogSources, ...ai(id), ...extra };
}

function fixture() {
  const genre = (g, type = 'movie') => [{ type, genre: g, addonId: 'org.tmdb', catalogId: 'tmdb.top' }];
  const svc = (s) => [{ type: 'movie', genre: null, addonId: 'org.streaming', catalogId: `${s}.popular` }];
  return {
    1: [
      {
        id: 'collections.genres', title: 'Genres', pinToTop: true, viewMode: 'ROWS', showAllTab: true, focusGlowEnabled: true,
        folders: [
          folder('g-action', 'Action', genre('Action')),
          folder('g-horror', '🎃 Horror Movies', genre('Horror')),
          folder('g-scifi', 'Sci-Fi', genre('Science Fiction')),
          folder('g-comedy', 'Comedy', genre('Comedy'), { coverEmoji: '😂' }),
          folder('g-thriller', 'Edge of Your Seat', genre('Thriller')),
          folder('g-anime', 'Anime', genre('Animation', 'series')),
        ],
      },
      {
        id: 'collections.streaming', title: 'Streaming', pinToTop: false, viewMode: 'GRID', showAllTab: false, focusGlowEnabled: false,
        folders: [
          folder('s-netflix', 'Netflix', svc('netflix')),
          folder('s-disney', 'Disney+', svc('disney')),
          folder('s-max', 'HBO Max', svc('hbo')),
          folder('s-apple', 'Apple TV+', svc('apple')),
        ],
      },
      {
        id: 'collections.mine', title: 'My Stuff', pinToTop: false, viewMode: 'ROWS', showAllTab: true, focusGlowEnabled: true,
        unknownCollectionField: { keep: 'me' },
        folders: [
          folder('m-watch', 'My Watchlist', [{ type: 'movie', genre: null, addonId: 'local', catalogId: 'watchlist' }], { futureField: [1, 2, 3] }),
          folder('m-90s', 'Best of the 90s', [{ type: 'movie', genre: null, addonId: 'org.tmdb', catalogId: 'tmdb.decade.1990' }]),
        ],
      },
    ],
    2: [
      {
        id: 'collections.kids', title: 'Kids', pinToTop: true, viewMode: 'ROWS', showAllTab: false, focusGlowEnabled: true,
        folders: [folder('k-family', 'Family', genre('Family')), folder('k-pixar', 'Pixar', svc('pixar'))],
      },
    ],
  };
}

let db;
function reset() {
  db = Object.fromEntries(Object.entries(fixture()).map(([p, cols]) => [p, { collections: cols, updatedAt: new Date(Date.UTC(2026, 10, 1)).toISOString() }]));
}
reset();

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, accept, prefer',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const authed = (req) => req.headers.apikey === KEY && req.headers.authorization === `Bearer ${TOKEN}`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      if (p === '/.well-known/nuvio') return send(res, 200, { version: 1, service: 'nuvio', backend_url: ORIGIN, publishable_key: KEY });

      if (p === '/auth/v1/token' && req.method === 'POST') {
        if (req.headers.apikey !== KEY) return send(res, 401, { message: 'No API key found in request' });
        const { email, password } = await readJson(req);
        if (email !== USER.email || password !== 'test') return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(res, 200, { access_token: TOKEN, token_type: 'bearer', expires_in: 3600, refresh_token: 'mock-refresh', user: USER });
      }
      if (p === '/auth/v1/logout') return send(res, 204);

      if (p.startsWith('/__mock/')) {
        const prof = url.searchParams.get('profile') || '1';
        if (p === '/__mock/reset') { reset(); return send(res, 200, { ok: true }); }
        if (p === '/__mock/touch') {
          db[prof].updatedAt = new Date().toISOString();
          db[prof].collections[0].title += ' (edited)';
          return send(res, 200, { ok: true, updatedAt: db[prof].updatedAt });
        }
        if (p === '/__mock/state') return send(res, 200, db[prof]);
      }

      if (!authed(req)) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });

      if (p === '/rest/v1/profiles' && req.method === 'GET') {
        return send(res, 200, [
          { profile_id: 1, profile_index: 0, name: 'Main', avatar_color_hex: '#1E88E5' },
          { profile_id: 2, profile_index: 1, name: 'Kids', avatar_color_hex: '#43A047' },
        ]);
      }
      if (p === '/rest/v1/rpc/sync_pull_collections' && req.method === 'POST') {
        const { p_profile_id } = await readJson(req);
        const row = db[p_profile_id];
        // Real servers may return collections_json as a string; mimic that.
        return send(res, 200, row ? [{ profile_id: p_profile_id, collections_json: JSON.stringify(row.collections), updated_at: row.updatedAt }] : []);
      }
      if (p === '/rest/v1/rpc/sync_push_collections' && req.method === 'POST') {
        const body = await readJson(req);
        for (const k of ['p_profile_id', 'p_collections_json', 'p_origin_client_id']) {
          if (!(k in body)) return send(res, 404, { code: 'PGRST202', message: `Could not find the function sync_push_collections without ${k}` });
        }
        if (!Array.isArray(body.p_collections_json)) return send(res, 400, { message: 'p_collections_json must be an array' });
        db[body.p_profile_id] = { collections: body.p_collections_json, updatedAt: new Date().toISOString() };
        console.log(`push profile=${body.p_profile_id} collections=${body.p_collections_json.length} origin=${body.p_origin_client_id}`);
        return send(res, 204);
      }
      return send(res, 404, { message: 'not found' });
    } catch (err) {
      return send(res, 500, { message: String(err?.message || err) });
    }
  })
  .listen(PORT, () => console.log(`Mock Nuvio server on ${ORIGIN} (email ${USER.email}, password test)`));
