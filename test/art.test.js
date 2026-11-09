import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENT, backdropUrl, normalizeTitle, suggest, search } from '../js/art.js';
import { SEED } from '../js/seed-map.js';

// Even a regression in the injected-fetch path must never reach the internet.
test.beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected global fetch'); });
});

const offline = { network: false };
const json = (body) => ({ ok: true, json: async () => body });
const imdbPattern = /^tt\d+$/;

function assertResults(results, limit = 5) {
  assert.ok(results.length <= limit);
  assert.equal(new Set(results.map((r) => r.imdb)).size, results.length);
  for (const [i, r] of results.entries()) {
    assert.match(r.imdb, imdbPattern);
    assert.equal(r.backdropUrl, backdropUrl(r.imdb));
    assert.equal(typeof r.name, 'string');
    assert.ok(r.score >= 0 && r.score <= 1);
    assert.ok(['seed', 'fuzzy', 'search'].includes(r.source));
    if (r.source === 'seed') assert.equal(r.score, 1);
    if (r.source === 'search') assert.ok(r.score <= 0.5);
    if (i) assert.ok(results[i - 1].score >= r.score);
  }
}

test('CONFIDENT and backdropUrl keep the public contract', () => {
  assert.equal(CONFIDENT, 0.75);
  assert.equal(backdropUrl('tt0468569'), 'https://images.metahub.space/background/large/tt0468569/img');
});

test('normalizeTitle handles accents, emoji, punctuation, ampersands and plus', () => {
  assert.equal(normalizeTitle('  🎃 HÓRROR—Movies!!!  '), 'horror movies');
  assert.equal(normalizeTitle('Crème & Café + TV'), 'creme and cafe plus tv');
  assert.equal(normalizeTitle('Apple TV+'), 'apple tv plus');
  assert.equal(normalizeTitle('Sci-Fi / Fantasy?Comedy'), 'sci fi fantasy comedy');
  assert.equal(normalizeTitle("1990's"), '1990s');
  assert.equal(normalizeTitle('1990’s'), '1990s');
  assert.equal(normalizeTitle('Cafe\u0301'), 'cafe');
  for (const value of [undefined, null, 7, {}, [], '🎬']) assert.equal(normalizeTitle(value), '');
});

const positives = [
  ['Action', 'tt0468569', 'The Dark Knight', 'seed'],
  ['🎃 Horror Movies', 'tt0081505', 'The Shining', 'seed'],
  ['Sci-Fi', 'tt0133093', 'The Matrix', 'seed'],
  ['Edge of Your Seat', 'tt0114369', 'Se7en', 'fuzzy', [{ type: 'movie', genre: 'Thriller' }]],
  ['Anime', 'tt22248376', "Frieren: Beyond Journey's End", 'seed'],
  ['Netflix', 'tt4574334', 'Stranger Things', 'seed'],
  ['Disney+', 'tt8111088', 'The Mandalorian', 'seed'],
  ['HBO Max', 'tt0944947', 'Game of Thrones', 'seed'],
  ['Best of the 90s', 'tt0110912', 'Pulp Fiction', 'fuzzy'],
  ["1990's", 'tt0110912', 'Pulp Fiction', 'seed'],
  ['K-Dramas', 'tt10850932', 'Crash Landing on You', 'fuzzy'],
  ['Marvel Cinematic Universe', 'tt2015381', 'Guardians of the Galaxy', 'fuzzy'],
  ['Family', 'tt4468740', 'Paddington 2', 'seed'],
  ['Pixar', 'tt0114709', 'Toy Story', 'seed'],
  ['Studio Ghibli', 'tt0245429', 'Spirited Away', 'seed'],
  ['Apple TV+', 'tt11280740', 'Severance', 'seed'],
];

for (const [title, imdb, name, source, catalogs] of positives) {
  test(`suggest selects ${name} for ${title} without network fallback`, async (t) => {
    const fetch = t.mock.fn(async () => json({ metas: [] }));
    const results = await suggest(title, catalogs, { fetch, limit: 100 });
    assertResults(results, 100);
    assert.equal(results[0]?.imdb, imdb);
    assert.equal(results[0].name, name);
    assert.equal(results[0].source, source);
    assert.ok(results[0].score >= CONFIDENT);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(await suggest(title, catalogs, { ...offline, limit: 100 }), results);
  });
}

for (const [title, imdb] of [['Apple TV+', 'tt11280740'], ['K-Dramas', 'tt10850932']]) {
  test(`${title} has no confident unrelated secondary candidates`, async () => {
    const results = await suggest(title, [], { ...offline, limit: 100 });
    assert.deepEqual(results.filter((r) => r.score >= CONFIDENT).map((r) => r.imdb), [imdb]);
  });
}

for (const title of ['My Watchlist', 'Continue Watching', "Dad's Picks", 'Dad’s Picks']) {
  test(`${title} has no local candidate scoring 0.6 or higher`, async () => {
    const results = await suggest(title, [], { ...offline, limit: 100 });
    assert.ok(results.every((r) => r.score < 0.6));
  });
}

for (const title of ['Zebra TV', 'Zebra Drama', 'Zebra TV Shows', 'Zebra Drama Movies', 'Zebra Movies', 'Zebra Shows', 'Zebra Top', 'Zebra Best', 'Zebra Top Rated', 'Zebra DC']) {
  test(`generic or short partial evidence in ${title} is not confident`, async () => {
    const results = await suggest(title, [], { ...offline, limit: 100 });
    assert.ok(results.every((r) => r.score < CONFIDENT), JSON.stringify(results));
  });
}

test('exact generic titles and complete genre cores remain confident', async () => {
  for (const [title, imdb] of [['TV', 'tt0903747'], ['Drama', 'tt0111161'], ['Top Rated', 'tt0071562'], ['Best Drama Movies', 'tt0111161'], ['Best DC Movies', 'tt1877830']]) {
    const results = await suggest(title, [], offline);
    assert.equal(results[0]?.imdb, imdb, title);
    assert.ok(results[0].score >= CONFIDENT, title);
  }
});

test('catalog genre, catalogId and addonId supply confident signals', async () => {
  for (const [catalogs, imdb] of [
    [[{ type: 'movie', genre: 'Thriller' }], 'tt0114369'],
    [[{ type: 'movie', genre: [null, 'Thrillers', 42] }], 'tt0114369'],
    [[{ type: 'series', catalogId: 'netflix.popular' }], 'tt4574334'],
    [[{ type: 'series', addonId: 'org.netflix.catalog' }], 'tt4574334'],
  ]) {
    const results = await suggest('Uncharted Shelf', catalogs, offline);
    assert.equal(results[0]?.imdb, imdb);
    assert.equal(results[0].source, 'fuzzy');
    assert.ok(results[0].score >= CONFIDENT);
  }
  const generic = await suggest('Uncharted Shelf', [{ type: 'movie', addonId: 'org.stremio.cinemeta', catalogId: 'top.popular' }], offline);
  assert.deepEqual(generic, []);
});

for (const catalogs of [undefined, null, [null], [{}], 'x', [7, { genre: 42, addonId: {}, catalogId: [] }]]) {
  test(`malformed catalogSources ${JSON.stringify(catalogs)} do not throw`, async () => {
    assert.equal((await suggest('Action', catalogs, offline))[0]?.imdb, 'tt0468569');
    assert.deepEqual(await suggest('Uncharted Shelf', catalogs, offline), []);
  });
}

test('fallback runs without a confident local match, filters IMDb IDs and caps scores', async (t) => {
  const fetch = t.mock.fn(async () => json({ metas: [
    { id: 'tt1234', name: 'Found title' },
    { id: 'tmdb:1234', name: 'Invalid' },
    { id: 'tt5678junk' }, { id: 'tt' }, { id: 'TT1234' }, { id: 1234 }, null,
    { imdb_id: 'tt5678', name: 'Second title' },
  ] }));
  for (const title of ['Uncharted Shelf', 'Zebra TV']) {
    const results = await suggest(title, [], { fetch });
    assertResults(results);
    const network = results.filter((r) => r.source === 'search');
    assert.deepEqual(new Set(network.map((r) => r.imdb)), new Set(['tt1234', 'tt5678']));
    assert.ok(results.every((r) => r.score < CONFIDENT));
  }
  assert.equal(fetch.mock.callCount(), 4);
  assert.ok(fetch.mock.calls.every(({ arguments: [url] }) => url.startsWith('https://v3-cinemeta.strem.io/catalog/')));
});

test('search maps Cinemeta results, encodes queries and preserves type and optional year', async (t) => {
  const fetch = t.mock.fn(async (url) => json({ metas: url.includes('/movie/') ? [
    { id: 'tt1001', name: '  Café & Tea  ', releaseInfo: '2023–2024' },
    { imdb_id: 'tt1002', name: '', year: 1999 },
  ] : [{ id: 'tt1003', name: 'A Show', type: 'series' }] }));
  const results = await search('Café & Tea', { fetch, type: 'series' });
  assertResults(results);
  assert.deepEqual(results.map((r) => [r.imdb, r.name, r.type, r.year]), [
    ['tt1003', 'A Show', 'series', undefined],
    ['tt1001', 'Café & Tea', 'movie', '2023'],
    ['tt1002', 'tt1002', 'movie', '1999'],
  ]);
  assert.ok(results.every((r) => r.source === 'search'));
  assert.ok(!Object.hasOwn(results[0], 'year'));
  assert.deepEqual(fetch.mock.calls.map(({ arguments: [url] }) => url), [
    'https://v3-cinemeta.strem.io/catalog/series/top/search=Caf%C3%A9%20%26%20Tea.json',
    'https://v3-cinemeta.strem.io/catalog/movie/top/search=Caf%C3%A9%20%26%20Tea.json',
  ]);
});

for (const [label, fetch] of [
  ['rejection', async () => { throw new Error('offline'); }],
  ['HTTP failure', async () => ({ ok: false })],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })],
  ['malformed body', async () => json({ metas: 'bad' })],
]) {
  test(`network ${label} resolves to []`, async () => {
    assert.deepEqual(await search('Uncharted Shelf', { fetch }), []);
    assert.deepEqual(await suggest('Uncharted Shelf', [], { fetch }), []);
  });
}

for (const phase of ['fetch', 'body']) {
  test(`timeout during ${phase} resolves to [] even if transport ignores abort`, { timeout: 2000 }, async (t) => {
    const fetch = t.mock.fn(async () => phase === 'fetch'
      ? new Promise(() => {})
      : { ok: true, json: () => new Promise(() => {}) });
    assert.deepEqual(await search('Uncharted Shelf', { fetch, timeoutMs: 10 }), []);
    assert.deepEqual(await suggest('Uncharted Shelf', [], { fetch, timeoutMs: 10 }), []);
    assert.equal(fetch.mock.callCount(), 4);
    assert.ok(fetch.mock.calls.every(({ arguments: [, { signal }] }) => signal.aborted));
  });
}

test('network:false never calls fetch, including direct search with a TMDB key', async (t) => {
  const fetch = t.mock.fn(async () => json({ metas: [{ id: 'tt1', name: 'Unexpected' }] }));
  assert.deepEqual(await suggest('Uncharted Shelf', [], { fetch, network: false }), []);
  assert.deepEqual(await search('Uncharted Shelf', { fetch, network: false, tmdbKey: 'mock-key' }), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('search uses the mocked global fetch when no fetch override is supplied', async () => {
  assert.deepEqual(await search('Global fetch fallback', { cache: false }), []);
  assert.equal(globalThis.fetch.mock.callCount(), 2);
});

test('search and suggest dedupe by IMDb, keep the best score and enforce default/custom limits', async (t) => {
  const metas = Array.from({ length: 8 }, (_, i) => ({ id: `tt${2000 + i}`, name: `Result ${i}` }));
  const fetch = t.mock.fn(async (url) => json({ metas: url.includes('/series/') ? [...metas].reverse() : metas }));
  for (const limit of [undefined, 2, 20]) {
    const opts = { fetch, ...(limit === undefined ? {} : { limit }) };
    const direct = await search('Uncharted Shelf', opts);
    const suggested = await suggest('Uncharted Shelf', [], opts);
    for (const results of [direct, suggested]) {
      assertResults(results, limit ?? 5);
      assert.equal(results.length, Math.min(limit ?? 5, 8));
      assert.equal(results[0].imdb, 'tt2000');
      assert.equal(results.find((r) => r.imdb === 'tt2007')?.score, 0.48);
    }
  }
  const mixedFetch = async () => json({ metas: [{ id: 'tt0903747', name: 'Network duplicate' }, { id: 'tt9999', name: 'Other' }] });
  const mixed = await suggest('Zebra TV', [], { fetch: mixedFetch });
  assertResults(mixed);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].source, 'fuzzy');
  assert.equal(mixed[0].name, 'Breaking Bad');
  const locals = await suggest('Netflix Pixar', [], { ...offline, limit: 1 });
  assert.equal(locals.length, 1);
});

test('empty input and nonpositive limits return [] without fetching', async (t) => {
  const fetch = t.mock.fn(async () => json({ metas: [] }));
  for (const value of ['', '  ', null, undefined, {}]) {
    assert.deepEqual(await search(value, { fetch }), []);
    assert.deepEqual(await suggest(value, [], { fetch }), []);
  }
  for (const limit of [0, -1]) {
    assert.deepEqual(await search('Action', { fetch, limit }), []);
    assert.deepEqual(await suggest('Action', [], { fetch, limit }), []);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('optional TMDB search resolves external IDs and keeps network results below confidence', async (t) => {
  const fetch = t.mock.fn(async (url) => {
    if (url.includes('/search/multi')) return json({ results: [
      { id: 1, media_type: 'movie', title: 'Mock Movie', release_date: '2024-01-01' },
      { id: 2, media_type: 'person', name: 'Ignore Person' },
      { id: 3, media_type: 'tv', name: 'Mock Show', imdb_id: 'tt3003' },
    ] });
    return json({ imdb_id: 'tt3001' });
  });
  const results = await search('Mock', { fetch, tmdbKey: 'temporary-test-key' });
  assertResults(results);
  assert.deepEqual(results.map((r) => r.imdb), ['tt3001', 'tt3003']);
  assert.equal(results[0].year, '2024');
  assert.ok(results.every((r) => r.source === 'search'));
  assert.equal(fetch.mock.callCount(), 2);
});

test('failed TMDB request falls back to Cinemeta', async (t) => {
  const fetch = t.mock.fn(async (url) => {
    if (url.includes('api.themoviedb.org')) throw new Error('TMDB unavailable');
    return json({ metas: [{ id: 'tt4001', name: 'Fallback' }] });
  });
  const results = await search('Mock', { fetch, tmdbKey: 'temporary-test-key' });
  assertResults(results);
  assert.equal(results[0]?.imdb, 'tt4001');
  assert.equal(fetch.mock.callCount(), 3);
});

// Frozen expectations transcribed from nuvio-toolkit/art_map.json. The tests
// deliberately do not read that external file or derive expectations from SEED.
const ORIGINAL_PICKS = {
  'Action': 'tt0468569',
  'Animation': 'tt4633694',
  'Anime': 'tt22248376',
  'Comedy': 'tt2278388',
  'Crime': 'tt0068646',
  'Documentary': 'tt7775622',
  'Drama': 'tt0111161',
  'Family': 'tt4468740',
  'Fantasy': 'tt0120737',
  'History': 'tt15398776',
  'Horror': 'tt0081505',
  'Music': 'tt2582802',
  'Mystery': 'tt8946378',
  'Talk': 'tt3530232',
  'Reality': 'tt1877368',
  'Romance': 'tt3783958',
  'Thriller': 'tt0114369',
  'TV': 'tt0903747',
  'Western': 'tt0060196',
  'Time Travel': 'tt0088763',
  'Revenge': 'tt0266697',
  'Spy': 'tt0381061',
  'Magic': 'tt0241527',
  'K-Drama': 'tt10850932',
  'Treasure Hunt': 'tt0082971',
  'Romantic Comedy': 'tt0098635',
  'Coming of Age': 'tt1065073',
  'Superhero': 'tt4154796',
  'Space': 'tt0816692',
  'Martial Arts': 'tt0070034',
  'Vampire': 'tt0110148',
  'Satire': 'tt0057012',
  'Recommended': 'tt6710474',
  'Popular': 'tt1517268',
  'Trending': 'tt1160419',
  'Top Rated': 'tt0071562',
  'Netflix': 'tt4574334',
  'Disney Plus': 'tt8111088',
  'Prime Video': 'tt1190634',
  'Apple TV': 'tt11280740',
  'HBO Max': 'tt0944947',
  'Hulu': 'tt14452776',
  'Paramount Plus': 'tt12327578',
  'Peacock': 'tt0386676',
  'Crunchyroll': 'tt21209876',
  'Discovery Plus': 'tt0446809',
  'Curiosity Stream': 'tt2395695',
  'JioHotstar': 'tt1187043',
  'Starz': 'tt3006802',
  'Shudder': 'tt12749596',
  'Cartoon Network': 'tt1305826',
  'DC': 'tt1877830',
  'DreamWorks': 'tt0126029',
  'Ghibli': 'tt0245429',
  'Marvel': 'tt2015381',
  'Nickelodeon': 'tt0417299',
  'Pixar': 'tt0114709',
  'Lucasfilm': 'tt0076759',
  '2020s': 'tt15239678',
  '2010s': 'tt1392190',
  '2000s': 'tt0172495',
  '1990s': 'tt0110912',
  '1980s': 'tt0080684',
  '1970s': 'tt0073195',
  '1960s': 'tt0056172',
  '1950s': 'tt0052357',
  'Short (<90 min)': 'tt0130827',
  'Standard (90-150 min)': 'tt1745960',
  'Long (150-180 min)': 'tt0407887',
  'Epic (180+ min)': 'tt0167260',
  'Brazilian': 'tt0317248',
  'Chinese': 'tt0190332',
  'French': 'tt0211915',
  'German': 'tt0405094',
  'Indian': 'tt8178634',
  'Italian': 'tt0095765',
  'Japanese': 'tt0047478',
  'Korean': 'tt6751668',
  'Latin American': 'tt0245712',
  'Nordic': 'tt10288566',
  'Russian': 'tt2802154',
  'Spanish': 'tt0457430',
  'Turkish': 'tt2758880',
};

test('SEED preserves all 83 original key-to-IMDb picks', () => {
  assert.equal(Object.keys(ORIGINAL_PICKS).length, 83);
  for (const [key, imdb] of Object.entries(ORIGINAL_PICKS)) {
    assert.equal(SEED.find((entry) => entry.key === key)?.imdb, imdb, key);
  }
});

test('every SEED ID is valid and normalized keys/aliases never belong to different entries', () => {
  const owners = new Map();
  for (const entry of SEED) {
    assert.match(entry.imdb, imdbPattern, entry.key);
    for (const phrase of [entry.key, ...entry.aliases]) {
      const normalized = normalizeTitle(phrase);
      assert.ok(normalized, entry.key);
      if (owners.has(normalized)) assert.equal(owners.get(normalized), entry, `Conflicting phrase: ${phrase}`);
      owners.set(normalized, entry);
    }
  }
});
