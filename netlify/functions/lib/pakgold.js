// Auto rate: reads the 24K tola (and silver tola) price from pakgold.net, server-side.
// - cached for CACHE_MS so visitors never hit pakgold.net directly (one fetch per few minutes at most)
// - a price is only accepted if it is plausible compared with the shop's manual rate (SANITY_BAND)
// - if the site is down / changes layout / returns nonsense, callers fall back to the manual rate
const SOURCE_URL = 'https://www.pakgold.net/';
const CACHE_KEY = 'pakgold-cache';
const CACHE_MS = 5 * 60 * 1000;          // re-fetch at most every 5 minutes
const RETRY_MS = 2 * 60 * 1000;          // after a failed fetch wait 2 minutes before trying again
const FETCH_TIMEOUT_MS = 8000;
const SANITY_BAND = 0.10;                // accept 24K price within +/-10% of the manual rate
const SILVER_BAND = 0.30;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;   // a good price older than 6 hours is no longer trusted

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// numbers like 379,500 / 379500 / 4,700 / 4700.50
function numbersIn(str) {
  const out = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d{4,8})(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(v)) out.push(v);
  }
  return out;
}

// Look for numbers shortly after each match of `labelRe`; keep the plausible ones.
function findCandidates(text, labelRe, lo, hi) {
  const found = [];
  const re = new RegExp(labelRe.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const win = text.slice(m.index, m.index + 240);
    const hasTola = /tola|tolah/i.test(win);
    numbersIn(win).forEach((v) => {
      if (v >= lo && v <= hi) found.push({ value: v, tola: hasTola, context: win.slice(0, 120) });
    });
  }
  return found;
}

function pickClosest(cands, ref) {
  if (!cands.length) return null;
  const withTola = cands.filter((c) => c.tola);
  const pool = withTola.length ? withTola : cands;
  pool.sort((a, b) => Math.abs(a.value - ref) - Math.abs(b.value - ref));
  return pool[0];
}

// Exported for tests: returns { rate24, silver, candidates... } or { error }
function parsePrices(html, refRate, refSilver) {
  const text = htmlToText(html);
  if (text.length < 200) return { error: 'Page khali / bahut chhota mila (shayad JavaScript se load hota hai).' };

  const ref = refRate > 0 ? refRate : 400000;
  const goldLabel = /24\s*(?:k\b|kt\b|karats?\b|carats?\b|ct\b)/;
  const goldCands = findCandidates(text, goldLabel, ref * (1 - SANITY_BAND), ref * (1 + SANITY_BAND));
  const gold = pickClosest(goldCands, ref);
  if (!gold) {
    return { error: '24K tola ka rate page par nahi mila (ya manual rate se bahut door hai).', goldCandidates: 0 };
  }

  let silver = null;
  let silverCands = [];
  if (refSilver > 0) {
    silverCands = findCandidates(text, /silver/, refSilver * (1 - SILVER_BAND), refSilver * (1 + SILVER_BAND));
  } else {
    silverCands = findCandidates(text, /silver/, 1000, 150000);
  }
  const sPick = pickClosest(silverCands, refSilver > 0 ? refSilver : 0);
  if (sPick) silver = sPick.value;

  return {
    rate24: gold.value,
    silver,
    goldContext: gold.context,
    silverContext: sPick ? sPick.context : null,
    goldCandidates: goldCands.length,
    silverCandidates: silverCands.length
  };
}

async function fetchHtml() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RajputJewellersRateBoard/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) throw new Error('pakgold.net ne HTTP ' + res.status + ' diya');
    const text = await res.text();
    return text.length > 3000000 ? text.slice(0, 3000000) : text;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(store) {
  try {
    const c = await store.get(CACHE_KEY, { type: 'json' });
    return c && typeof c === 'object' ? c : null;
  } catch (err) {
    return null;
  }
}

// Returns { rate, silver, at, fresh, error? } — rate is null when there is no trustworthy auto price.
// `ref` = { rate, silver } of the manual settings (used for the sanity check).
async function getAutoRate(store, ref, opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  const cache = (await readCache(store)) || {};
  const good = cache.good && cache.good.rate > 0 ? cache.good : null;

  const dueForFetch = force ||
    !cache.checkedAt ||
    now - cache.checkedAt >= (cache.lastError ? RETRY_MS : CACHE_MS);

  let fresh = false;
  let lastError = cache.lastError || null;
  let debug = null;
  let newGood = good;
  let checkedAt = cache.checkedAt || 0;

  if (dueForFetch) {
    checkedAt = now;
    try {
      const html = await fetchHtml();
      const parsed = parsePrices(html, ref && ref.rate, ref && ref.silver);
      debug = parsed;
      if (parsed.error) {
        lastError = parsed.error;
      } else {
        newGood = { rate: parsed.rate24, silver: parsed.silver || 0, at: now };
        lastError = null;
        fresh = true;
      }
    } catch (err) {
      lastError = (err && err.name === 'AbortError') ? 'pakgold.net ne waqt par jawab nahi diya.' : (err && err.message) || 'Fetch fail';
    }
    try {
      await store.setJSON(CACHE_KEY, { checkedAt, lastError, good: newGood, rowAt: cache.rowAt || 0 });
    } catch (err) { /* best effort */ }
  }

  const usable = newGood && (now - newGood.at) <= MAX_AGE_MS ? newGood : null;
  return {
    rate: usable ? usable.rate : null,
    silver: usable ? usable.silver : 0,
    at: usable ? usable.at : null,
    rowPending: !!(usable && cache.rowAt !== usable.at),   // today's graph row not yet written for this price
    fresh,
    error: lastError,
    checkedAt,
    debug
  };
}

// remember that the graph row for the price fetched at `at` has been written
async function markRowWritten(store, at) {
  const cache = (await readCache(store)) || {};
  cache.rowAt = at;
  try { await store.setJSON(CACHE_KEY, cache); } catch (err) { /* best effort */ }
}

module.exports = { SOURCE_URL, CACHE_MS, parsePrices, htmlToText, getAutoRate, markRowWritten };
