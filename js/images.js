// Browser-side image checks. A backdrop is only offered for writing after it is confirmed to load.

const cache = new Map();

/** Metahub serves the same art in several sizes; use small ones for thumbnails. */
export function thumbUrl(url) {
  return typeof url === 'string' ? url.replace('/background/large/', '/background/small/') : url;
}

function loadWithImg(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(ok) {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(ok);
    }
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    img.src = url;
  });
}

async function check(url, timeoutMs) {
  // Cheap path: HEAD request (Metahub allows CORS) confirms status + image type without the download.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) return (res.headers.get('content-type') || '').startsWith('image/');
    if (res.status === 404 || res.status === 410) return false;
  } catch {
    /* CORS or network: fall back to a real image load */
  } finally {
    clearTimeout(timer);
  }
  return loadWithImg(url, timeoutMs);
}

/** Resolves true if the URL serves a loadable image. Never rejects. Results are cached per URL. */
export function checkImage(url, { timeoutMs = 12000 } = {}) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return Promise.resolve(false);
  if (!cache.has(url)) {
    const p = check(url, timeoutMs);
    cache.set(url, p);
    // Do not cache transient failures forever.
    p.then((ok) => { if (!ok) setTimeout(() => cache.delete(url), 60000); });
  }
  return cache.get(url);
}
