// Artwork suggestion and search engine for Nuvio collection tiles.

import { SEED } from './seed-map.js';

export const CONFIDENT = 0.75;

const IMDB_RE = /^tt\d+$/;
const DEFAULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 8000;

// In-memory search result cache (used only when default global fetch is active).
const searchCache = new Map();

/** Build the Metahub large backdrop URL for an IMDb ID. */
export function backdropUrl(imdb) {
  return `https://images.metahub.space/background/large/${imdb}/img`;
}

/**
 * Normalize a tile title or search phrase:
 * lowercase, strip accents/emoji/punctuation, '&' -> 'and', '+' -> ' plus', collapse spaces.
 */
export function normalizeTitle(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generic media/collection modifier words that wrap a core genre, service, studio, or decade.
const MODIFIER_WORDS = new Set([
  'movie', 'movies', 'film', 'films', 'cinema', 'pictures',
  'show', 'shows', 'series', 'tv', 'television',
  'original', 'originals', 'exclusive', 'exclusives',
  'best', 'of', 'the', 'in', 'on', 'for', 'from', 'by', 'with', 'and', 'to', 'a', 'an',
  'all', 'time', 'top', 'picks', 'pick', 'favorites', 'favourites', 'favorite', 'favourite',
  'collection', 'collections', 'catalog', 'catalogue', 'category', 'categories',
  'classic', 'classics', 'modern', 'essential', 'essentials', 'ultimate', 'great', 'greatest',
  'must', 'watch', 'watching', 'watchlist', 'continue', 'my', 'your', 'our', 'dads', 'moms',
  'new', 'latest', 'recent', 'recently', 'added', 'releases', 'featured', 'list',
  'hub', 'zone', 'channel', 'network', 'streaming', 'studio', 'studios',
  'cinematic', 'universe', 'world', 'era', 'decade', 'hits', 'night', 'nights',
]);

// Generic catalog/addon tokens that should not trigger streaming/studio matches on their own.
const GENERIC_CATALOG_TOKENS = new Set([
  'top', 'popular', 'new', 'featured', 'trending', 'movie', 'movies', 'series', 'tv',
  'catalog', 'collections', 'addon', 'stremio', 'cinemeta', 'tmdb', 'imdb', 'trakt',
  'com', 'org', 'net', 'io', 'app', 'v3', 'v2', 'v1', 'all', 'list', 'search', 'meta',
]);

/** Basic English plural stemmer for genre/theme tokens. */
function stemToken(w) {
  if (!w || w.length <= 3) return w;
  if (/^\d+0s$/.test(w)) return w; // Keep decades like 90s, 1990s intact
  if (w === 'series' || w === 'species' || w === 'movies') {
    return w === 'movies' ? 'movie' : w;
  }
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('oes') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('zes') || w.endsWith('ches') || w.endsWith('shes')) {
    return w.slice(0, -2);
  }
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1);
  }
  return w;
}

function stemPhrase(norm) {
  if (!norm) return '';
  return norm.split(' ').map(stemToken).join(' ');
}

const GENERIC_MATCH_STEMS = new Set([
  ...[...MODIFIER_WORDS, ...GENERIC_CATALOG_TOKENS].map(stemToken),
  'drama', 'rated', 'recommended',
]);

function isWeakToken(token) {
  return GENERIC_MATCH_STEMS.has(token) || (token.length <= 3 && !/^\d+0s$/.test(token));
}

/** S?rensen-Dice coefficient on character bigrams. */
function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) || 0;
    if (count > 0) {
      bigramsA.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/** Normalized Levenshtein similarity in [0, 1]. */
function levenshteinSimilarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

// Precompute normalized phrases for each SEED entry.
const PREPARED_SEED = SEED.map((entry) => {
  const normKey = normalizeTitle(entry.key);
  const normAliases = (entry.aliases || []).map(normalizeTitle).filter(Boolean);
  const allPhrases = [normKey, ...normAliases];
  const stemmedPhrases = allPhrases.map(stemPhrase);
  const phraseTokens = allPhrases.map((p) => p.split(' ').filter(Boolean));
  const stemmedTokens = stemmedPhrases.map((p) => p.split(' ').filter(Boolean));
  return {
    entry,
    normKey,
    allPhrases,
    allPhrasesSet: new Set(allPhrases),
    stemmedPhrases,
    stemmedPhrasesSet: new Set(stemmedPhrases),
    phraseTokens,
    stemmedTokens,
  };
});

/** Score a normalized tile title against a prepared SEED item. */
function scoreTitleAgainstSeed(normTitle, titleTokens, stemmedTitleTokens, coreTokens, stemmedCoreTokens, prep) {
  if (!normTitle) return { score: 0, source: null };

  // (1) Exact normalized match on key or aliases -> source 'seed', score 1
  if (prep.allPhrasesSet.has(normTitle)) {
    return { score: 1, source: 'seed' };
  }

  // (2) Fuzzy match -> source 'fuzzy', score in (0, 1)
  const stemmedTitle = stemmedTitleTokens.join(' ');
  if (prep.stemmedPhrasesSet.has(stemmedTitle)) {
    return { score: 0.92, source: 'fuzzy' };
  }

  const corePhrase = coreTokens.join(' ');
  const stemmedCorePhrase = stemmedCoreTokens.join(' ');
  if (corePhrase && prep.allPhrasesSet.has(corePhrase)) {
    return { score: 0.9, source: 'fuzzy' };
  }
  if (stemmedCorePhrase && prep.stemmedPhrasesSet.has(stemmedCorePhrase)) {
    return { score: 0.88, source: 'fuzzy' };
  }

  let bestFuzzy = 0;

  // Check token containment and token overlap against each phrase of the seed entry
  const titleStemSet = new Set(stemmedTitleTokens);
  const coreStemSet = new Set(stemmedCoreTokens);

  for (let i = 0; i < prep.allPhrases.length; i++) {
    const phrase = prep.allPhrases[i];
    const pStems = prep.stemmedTokens[i];
    let phraseScore = 0;
    if (!pStems.length) continue;

    // Avoid matching tiny single-letter tokens unless exact
    if (pStems.length === 1 && pStems[0].length < 2) continue;

    // Check if all stemmed tokens of the seed phrase appear in the title
    const allInTitle = pStems.every((t) => titleStemSet.has(t));
    if (allInTitle) {
      const denom = Math.max(pStems.length, stemmedCoreTokens.length || stemmedTitleTokens.length);
      const coverage = pStems.length / denom;
      // Primary key match gets a slightly higher base than a long alias
      const base = i === 0 ? 0.84 : 0.8;
      const candidate = Math.min(0.9, base + coverage * 0.06);
      phraseScore = Math.max(phraseScore, candidate);
    } else if (pStems.length > 1 && coreStemSet.size > 0) {
      // Partial token overlap on multi-word phrases (only on meaningful core tokens)
      let matched = 0;
      for (const t of pStems) {
        if (!MODIFIER_WORDS.has(t) && coreStemSet.has(t)) matched++;
      }
      if (matched > 0) {
        const overlap = (2 * matched) / (pStems.length + coreStemSet.size);
        if (overlap >= 0.6) {
          const candidate = 0.65 + overlap * 0.2;
          phraseScore = Math.max(phraseScore, candidate);
        }
      }
    }

    // Typo tolerance via Levenshtein & Dice on core phrase or full phrase (length >= 4)
    const target = corePhrase.length >= 4 ? corePhrase : normTitle;
    if (target.length >= 4 && phrase.length >= 4 && target[0] === phrase[0]) {
      const lev = levenshteinSimilarity(target, phrase);
      const dice = diceSimilarity(target, phrase);
      const sim = (lev + dice) / 2;
      if (sim >= 0.78) {
        const candidate = Math.min(0.86, sim * 0.92);
        phraseScore = Math.max(phraseScore, candidate);
      }
    }

    // A generic/short token alone is weak evidence for a partial match. Exact
    // phrases and complete core matches were handled above (e.g. Drama Movies).
    // Cap per phrase so a weak alias cannot override a stronger, specific one.
    const shared = pStems.filter((token) => titleStemSet.has(token));
    const evidence = shared.length ? shared : pStems;
    if (evidence.every(isWeakToken)) phraseScore = Math.min(phraseScore, 0.55);
    bestFuzzy = Math.max(bestFuzzy, phraseScore);
  }

  return bestFuzzy > 0 ? { score: Number(bestFuzzy.toFixed(4)), source: 'fuzzy' } : { score: 0, source: null };
}

/** Extract safe normalized signals from catalogSources. */
function parseCatalogSignals(catalogSources) {
  const genres = [];
  const idTokens = [];
  const rawIds = [];
  let movieCount = 0;
  let seriesCount = 0;

  if (Array.isArray(catalogSources)) {
    for (const src of catalogSources) {
      if (!src || typeof src !== 'object') continue;

      if (src.type === 'movie') movieCount++;
      else if (src.type === 'series' || src.type === 'tv') seriesCount++;

      if (typeof src.genre === 'string' && src.genre.trim()) {
        genres.push(normalizeTitle(src.genre));
      } else if (Array.isArray(src.genre)) {
        for (const g of src.genre) {
          if (typeof g === 'string' && g.trim()) genres.push(normalizeTitle(g));
        }
      }

      for (const field of [src.catalogId, src.addonId]) {
        if (typeof field === 'string' && field.trim()) {
          const norm = normalizeTitle(field);
          if (norm) rawIds.push(norm);
          const parts = field
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 2 && !GENERIC_CATALOG_TOKENS.has(t));
          idTokens.push(...parts);
        }
      }
    }
  }

  const preferredType = seriesCount > movieCount ? 'series' : movieCount > seriesCount ? 'movie' : null;
  return { genres: [...new Set(genres.filter(Boolean))], idTokens: [...new Set(idTokens)], rawIds, preferredType };
}

/** Score a SEED entry against extracted catalogSources signals. */
function scoreCatalogSignals(prep, signals) {
  let best = 0;

  // Genre signals in catalogSources
  for (const g of signals.genres) {
    const gStem = stemPhrase(g);
    if (prep.allPhrasesSet.has(g) || prep.stemmedPhrasesSet.has(gStem)) {
      best = Math.max(best, 0.86);
    } else {
      const gTokens = g.split(' ').filter(Boolean);
      const gStemTokens = gTokens.map(stemToken);
      const gCore = gTokens.filter((t) => !MODIFIER_WORDS.has(t));
      const gStemCore = gCore.map(stemToken);
      const { score } = scoreTitleAgainstSeed(g, gTokens, gStemTokens, gCore, gStemCore, prep);
      if (score >= CONFIDENT) best = Math.max(best, 0.82);
    }
  }

  // catalogId / addonId signals (e.g. 'netflix.popular' -> 'netflix')
  for (const tok of signals.idTokens) {
    const tokStem = stemToken(tok);
    if (prep.allPhrasesSet.has(tok) || prep.stemmedPhrasesSet.has(tokStem)) {
      best = Math.max(best, 0.84);
    }
  }
  for (const rawId of signals.rawIds) {
    for (const phrase of prep.allPhrases) {
      if (phrase.length >= 3 && !GENERIC_CATALOG_TOKENS.has(phrase)) {
        const words = rawId.split(' ');
        if (words.includes(phrase)) {
          best = Math.max(best, 0.84);
        }
      }
    }
  }

  return best;
}

/** Perform a fetch with an AbortController timeout; returns parsed JSON or null on any error. */
async function fetchJsonWithTimeout(url, fetchFn, timeoutMs) {
  if (typeof fetchFn !== 'function') return null;
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchFn(url, { signal: ctrl.signal });
        if (!res || !res.ok) return null;
        return await res.json();
      })(),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractYear(info) {
  if (!info && info !== 0) return undefined;
  const m = String(info).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : undefined;
}

/** Optional TMDB v3 multi-search with external_ids lookup. Returns null on error so caller falls back to Cinemeta. */
async function searchTmdb(query, { fetchFn, timeoutMs, tmdbKey, preferredType, limit }) {
  const multiUrl = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(query)}`;
  const data = await fetchJsonWithTimeout(multiUrl, fetchFn, timeoutMs);
  if (!data || !Array.isArray(data.results)) return null;

  const mediaItems = data.results.filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv') && r.id != null);
  if (mediaItems.length === 0) return [];

  // Sort preferredType first if biased
  if (preferredType) {
    const targetMedia = preferredType === 'series' ? 'tv' : 'movie';
    mediaItems.sort((a, b) => (a.media_type === targetMedia ? -1 : 1) - (b.media_type === targetMedia ? -1 : 1));
  }

  const candidates = mediaItems.slice(0, Math.max(limit * 2, 8));
  const resolved = await Promise.all(
    candidates.map(async (item, idx) => {
      let imdb = typeof item.imdb_id === 'string' ? item.imdb_id : null;
      if (!imdb || !IMDB_RE.test(imdb)) {
        const extUrl = `https://api.themoviedb.org/3/${item.media_type}/${item.id}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`;
        const ext = await fetchJsonWithTimeout(extUrl, fetchFn, timeoutMs);
        if (!ext || typeof ext.imdb_id !== 'string') return null;
        imdb = ext.imdb_id;
      }
      if (!IMDB_RE.test(imdb)) return null;
      const type = item.media_type === 'tv' ? 'series' : 'movie';
      const name = item.title || item.name || item.original_title || item.original_name || imdb;
      const year = extractYear(item.release_date || item.first_air_date);
      const typeBoost = preferredType && type === preferredType ? 0.04 : 0;
      const rawScore = Math.max(0.1, Math.min(0.5, 0.46 + typeBoost - idx * 0.03));
      const res = {
        imdb,
        name,
        backdropUrl: backdropUrl(imdb),
        score: Number(rawScore.toFixed(4)),
        source: 'search',
        type,
      };
      if (year) res.year = year;
      return res;
    }),
  );

  const valid = resolved.filter(Boolean);
  return valid.length > 0 ? valid : null;
}

/** Cinemeta catalog search across movie and series endpoints. */
async function searchCinemeta(query, { fetchFn, timeoutMs, preferredType }) {
  const types = preferredType === 'series' ? ['series', 'movie'] : ['movie', 'series'];
  const encoded = encodeURIComponent(query);

  const responses = await Promise.all(
    types.map(async (t) => {
      const url = `https://v3-cinemeta.strem.io/catalog/${t}/top/search=${encoded}.json`;
      const data = await fetchJsonWithTimeout(url, fetchFn, timeoutMs);
      const metas = Array.isArray(data?.metas) ? data.metas : [];
      return { type: t, metas };
    }),
  );

  const items = [];
  for (const { type: endpointType, metas } of responses) {
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      if (!m || typeof m !== 'object') continue;
      const imdb = typeof m.id === 'string' ? m.id : typeof m.imdb_id === 'string' ? m.imdb_id : '';
      if (!IMDB_RE.test(imdb)) continue;
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : imdb;
      const itemType = m.type === 'series' || m.type === 'movie' ? m.type : endpointType;
      const year = extractYear(m.releaseInfo ?? m.year);

      let baseScore = 0.5 - i * 0.03;
      if (preferredType) {
        if (itemType === preferredType) baseScore = 0.5 - i * 0.02;
        else baseScore = 0.42 - i * 0.02;
      } else if (endpointType === 'series') {
        baseScore = 0.48 - i * 0.03;
      }
      const score = Number(Math.max(0.1, Math.min(0.5, baseScore)).toFixed(4));

      const entry = {
        imdb,
        name,
        backdropUrl: backdropUrl(imdb),
        score,
        source: 'search',
        type: itemType,
      };
      if (year) entry.year = year;
      items.push(entry);
    }
  }
  return items;
}

/** Deduplicate results by imdb id (keeping highest score), sort best first, and cap at limit. */
function dedupeAndSort(items, limit) {
  const byImdb = new Map();
  for (const item of items) {
    if (!item || !IMDB_RE.test(item.imdb)) continue;
    const prev = byImdb.get(item.imdb);
    if (!prev || item.score > prev.score) {
      byImdb.set(item.imdb, item);
    }
  }
  return [...byImdb.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Free-text search for the UI search box.
 * Returns Promise<[{imdb, name, backdropUrl, score, source:'search', year?, type}]>.
 */
export async function search(query, opts = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  if (!q || limit <= 0 || opts?.network === false) return [];

  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const preferredType = opts?.type === 'series' || opts?.type === 'movie' ? opts.type : null;
  const tmdbKey = typeof opts?.tmdbKey === 'string' && opts.tmdbKey.trim() ? opts.tmdbKey.trim() : null;

  const useCache = !opts?.fetch && opts?.cache !== false && !tmdbKey;
  const cacheKey = `${q.toLowerCase()}|${preferredType || ''}|${limit}`;
  if (useCache && searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey).map((x) => ({ ...x }));
  }

  let results = null;
  if (tmdbKey) {
    results = await searchTmdb(q, { fetchFn, timeoutMs, tmdbKey, preferredType, limit });
  }
  if (!results) {
    results = await searchCinemeta(q, { fetchFn, timeoutMs, preferredType });
  }

  const finalResults = dedupeAndSort(results, limit);
  if (useCache && finalResults.length > 0) {
    searchCache.set(cacheKey, finalResults);
  }
  return finalResults;
}

/**
 * Suggest artwork for a collection tile given its title and catalogSources.
 * Returns Promise<[{imdb, name, backdropUrl, score, source}]>.
 */
export async function suggest(tileTitle, catalogSources, opts = {}) {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  const normTitle = normalizeTitle(tileTitle);
  const titleTokens = normTitle ? normTitle.split(' ').filter(Boolean) : [];
  const stemmedTitleTokens = titleTokens.map(stemToken);
  const coreTokens = titleTokens.filter((t) => !MODIFIER_WORDS.has(t));
  const stemmedCoreTokens = coreTokens.map(stemToken);

  const signals = parseCatalogSignals(catalogSources);

  // Infer preferred media type from catalogSources or tile title
  let preferredType = signals.preferredType;
  if (!preferredType && titleTokens.length > 0) {
    if (titleTokens.some((t) => t === 'series' || t === 'shows' || t === 'show' || t === 'tv' || t === 'kdrama' || t === 'kdramas')) {
      preferredType = 'series';
    } else if (titleTokens.some((t) => t === 'movie' || t === 'movies' || t === 'film' || t === 'films')) {
      preferredType = 'movie';
    }
  }

  const localCandidates = [];

  for (const prep of PREPARED_SEED) {
    const titleMatch = scoreTitleAgainstSeed(
      normTitle,
      titleTokens,
      stemmedTitleTokens,
      coreTokens,
      stemmedCoreTokens,
      prep,
    );
    const catalogScore = scoreCatalogSignals(prep, signals);

    let score = 0;
    let source = null;

    if (titleMatch.score === 1) {
      score = 1;
      source = 'seed';
    } else if (titleMatch.score > 0 && catalogScore > 0) {
      score = Math.min(0.98, Math.max(titleMatch.score, catalogScore) + 0.05);
      source = 'fuzzy';
    } else if (titleMatch.score > 0) {
      score = titleMatch.score;
      source = 'fuzzy';
    } else if (catalogScore > 0) {
      score = catalogScore;
      source = 'fuzzy';
    }

    if (score > 0 && score < 1 && preferredType && prep.entry.type === preferredType) {
      score = Math.min(0.99, Number((score + 0.02).toFixed(4)));
    }

    if (score >= 0.45 && source) {
      localCandidates.push({
        imdb: prep.entry.imdb,
        name: prep.entry.name,
        backdropUrl: backdropUrl(prep.entry.imdb),
        score: Number(score.toFixed(4)),
        source,
      });
    }
  }

  const sortedLocal = dedupeAndSort(localCandidates, limit);
  const hasConfident = sortedLocal.some((c) => c.score >= CONFIDENT);

  // (3) Network fallback only when no seed/fuzzy result >= CONFIDENT and opts.network !== false
  if (!hasConfident && opts?.network !== false && normTitle) {
    const searchResults = await search(tileTitle, {
      ...opts,
      type: preferredType ?? opts?.type,
      limit,
    });
    const normalizedSearch = searchResults.map((r) => ({
      imdb: r.imdb,
      name: r.name,
      backdropUrl: r.backdropUrl,
      score: Math.min(0.5, r.score),
      source: 'search',
    }));
    return dedupeAndSort([...sortedLocal, ...normalizedSearch], limit);
  }

  return sortedLocal;
}
