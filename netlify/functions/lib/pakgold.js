// Auto rate: reads the 24K tola (and silver tola) price from pakgold.net, server-side.
// - the source is either pakgold.net's page or an exact "data URL" (JSON feed) set in the admin panel
// - cached for CACHE_MS so visitors never hit the source directly
// - a price is only accepted if it is plausible compared with the shop's manual rate (SANITY_BAND)
// - if the source is down / changes layout / returns nonsense, callers fall back to the manual rate
const SOURCE_URL = 'https://www.pakgold.net/';
const CACHE_KEY = 'pakgold-cache';
// How often the source is re-checked. 1 second = as live as it gets. Change with the PAKGOLD_REFRESH_SECONDS
// environment variable in Netlify (e.g. 10) if you hit Netlify's usage limits or the source starts blocking requests.
const REFRESH_SECONDS = Math.max(1, parseFloat(process.env.PAKGOLD_REFRESH_SECONDS) || 1);
const CACHE_MS = REFRESH_SECONDS * 1000;
const RETRY_MS = 30 * 1000;              // after a failed fetch wait 30 seconds before trying again
const FETCH_TIMEOUT_MS = 8000;
const SANITY_BAND = 0.10;                // accept 24K price within +/-10% of the manual rate
const SILVER_BAND = 0.30;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;   // a good price older than 6 hours is no longer trusted

// ---------- helpers ----------
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

function isSafeUrl(u) {
  let url;
  try { url = new URL(u); } catch (err) { return false; }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;        // no raw IPs (blocks 10.x, 192.168.x, 169.254.x ...)
  if (h.indexOf(':') !== -1 || h.startsWith('[')) return false;
  return true;
}

// ---------- HTML page parsing ----------
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

function pickClosest(cands, anchor) {
  if (!cands.length) return null;
  const withTola = cands.filter((c) => c.tola);
  const pool = withTola.length ? withTola : cands;
  return pool.slice().sort((a, b) => Math.abs(a.value - anchor) - Math.abs(b.value - anchor))[0];
}

function parseHtml(html, ref, anchor) {
  const text = htmlToText(html);
  if (text.length < 200) return { error: 'Page khali / bahut chhota mila (shayad JavaScript se load hota hai).' };

  const lo = ref * (1 - SANITY_BAND), hi = ref * (1 + SANITY_BAND);
  const goldLabel = /24\s*(?:k\b|kt\b|karats?\b|carats?\b|ct\b)/;
  const goldCands = findCandidates(text, goldLabel, lo, hi);

  // pakgold's own headline: "24K Rs 387,872 / Tola" — this is the number they show as THE 24K rate
  let gold = null;
  const head = new RegExp('24\\s*(?:k|kt|karats?|carats?)\\b[^0-9]{0,40}?(?:rs\\.?|pkr)?\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d{5,8}))\\s*(?:/|per)\\s*tola', 'i').exec(text);
  if (head) {
    const v = parseFloat(head[1].replace(/,/g, ''));
    if (v >= lo && v <= hi) gold = { value: v, tola: true, context: text.slice(head.index, head.index + 120), headline: true };
  }
  if (!gold) gold = pickClosest(goldCands, anchor);
  if (!gold) {
    return { error: '24K tola ka rate page par nahi mila (ya manual rate se bahut door hai).' };
  }
  return { gold, goldCands, text };
}

// ---------- JSON feed parsing ----------
function flatten(obj, path, out, state) {
  if (state.n > 4000 || path.split('.').length > 10) return;
  state.n++;
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number' || (typeof obj === 'string' && /^[\d,]+(\.\d+)?$/.test(obj.trim()))) {
    const v = typeof obj === 'number' ? obj : parseFloat(obj.replace(/,/g, ''));
    if (isFinite(v)) out.push({ path: path, value: v });
    return;
  }
  if (Array.isArray(obj)) {
    obj.slice(0, 200).forEach((x, i) => flatten(x, path + '[' + i + ']', out, state));
  } else if (typeof obj === 'object') {
    Object.keys(obj).slice(0, 300).forEach((k) => flatten(obj[k], path ? path + '.' + k : k, out, state));
  }
}

function scorePath(p) {
  let s = 0;
  if (/tola/i.test(p)) s += 3;
  if (/24/.test(p)) s += 1;
  if (/sell|ask|price|rate|value|current/i.test(p)) s += 1;
  if (/buy|bid/i.test(p)) s -= 1;
  if (/10\s*g|gram|ounce|\boz\b|usd|dollar|high|low|open|prev|change|diff/i.test(p)) s -= 3;
  return s;
}

function parseJson(json, ref, refSilver, anchor) {
  const flat = [];
  flatten(json, '', flat, { n: 0 });
  const lo = ref * (1 - SANITY_BAND), hi = ref * (1 + SANITY_BAND);
  const goldCands = flat.filter((f) => f.value >= lo && f.value <= hi)
    .map((f) => ({ value: f.value, score: scorePath(f.path), context: f.path + ' = ' + f.value }));
  if (!goldCands.length) return { error: 'Data URL mein 24K tola ka rate nahi mila (manual rate ke qareeb koi number nahi).' };
  goldCands.sort((a, b) => (b.score - a.score) || (Math.abs(a.value - anchor) - Math.abs(b.value - anchor)));
  const gold = goldCands[0];

  const sLo = refSilver > 0 ? refSilver * (1 - SILVER_BAND) : 1000;
  const sHi = refSilver > 0 ? refSilver * (1 + SILVER_BAND) : 150000;
  const silverCands = flat.filter((f) => /silver/i.test(f.path) && f.value >= sLo && f.value <= sHi)
    .map((f) => ({ value: f.value, score: scorePath(f.path), context: f.path + ' = ' + f.value }));
  silverCands.sort((a, b) => (b.score - a.score) || (Math.abs(a.value - (refSilver || 0)) - Math.abs(b.value - (refSilver || 0))));
  return { gold, goldCands, silver: silverCands[0] || null };
}

// Exported for tests: returns { rate24, silver, ... } or { error }
function parsePrices(body, refRate, refSilver, prevRate) {
  const ref = refRate > 0 ? refRate : 400000;
  const anchor = prevRate > 0 ? prevRate : ref;
  const trimmed = String(body).trim();
  let out;

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let json = null;
    try { json = JSON.parse(trimmed); } catch (err) { json = null; }
    if (json !== null) {
      out = parseJson(json, ref, refSilver, anchor);
      if (out.error) return { error: out.error };
      return {
        rate24: out.gold.value,
        silver: out.silver ? out.silver.value : null,
        goldContext: out.gold.context,
        silverContext: out.silver ? out.silver.context : null,
        candidates: out.goldCands.slice(0, 8).map((c) => c.context),
        kind: 'json'
      };
    }
  }

  out = parseHtml(body, ref, anchor);
  if (out.error) return { error: out.error };

  let silver = null, sPick = null, silverCands = [];
  if (refSilver > 0) {
    silverCands = findCandidates(out.text, /silver/, refSilver * (1 - SILVER_BAND), refSilver * (1 + SILVER_BAND));
  } else {
    silverCands = findCandidates(out.text, /silver/, 1000, 150000);
  }
  sPick = pickClosest(silverCands, refSilver > 0 ? refSilver : 0);
  if (sPick) silver = sPick.value;

  const seen = new Set();
  const list = [];
  out.goldCands.forEach((c) => { if (!seen.has(c.value)) { seen.add(c.value); list.push(c.value.toLocaleString('en-US') + (c.tola ? ' (tola)' : '')); } });
  return {
    rate24: out.gold.value,
    silver: silver,
    goldContext: out.gold.context,
    silverContext: sPick ? sPick.context : null,
    headline: !!out.gold.headline,
    candidates: list.slice(0, 8),
    kind: 'html'
  };
}

// ---------- fetching + cache ----------
async function fetchBody(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RajputJewellersRateBoard/1.0)',
        'Accept': 'application/json,text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache'
      }
    });
    if (!res.ok) throw new Error('Source ne HTTP ' + res.status + ' diya');
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

async function resetCache(store) {
  try { await store.setJSON(CACHE_KEY, {}); } catch (err) { /* best effort */ }
}

// Returns { rate, silver, at, changedAt, fresh, rowPending, error?, debug } — rate is null when there is no trustworthy auto price.
// `ref` = { rate, silver, url } of the manual settings (rate/silver for the sanity check, url = optional exact feed).
async function getAutoRate(store, ref, opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  const cache = (await readCache(store)) || {};
  const good = cache.good && cache.good.rate > 0 ? cache.good : null;
  const sourceUrl = ref && ref.url && isSafeUrl(ref.url) ? ref.url : SOURCE_URL;

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
      const body = await fetchBody(sourceUrl);
      const parsed = parsePrices(body, ref && ref.rate, ref && ref.silver, good ? good.rate : 0);
      debug = parsed;
      if (parsed.error) {
        lastError = parsed.error;
      } else {
        const silver = parsed.silver || 0;
        const same = good && good.rate === parsed.rate24 && (good.silver || 0) === silver;
        newGood = { rate: parsed.rate24, silver: silver, at: now, changedAt: same ? (good.changedAt || good.at) : now };
        lastError = null;
        fresh = true;
      }
    } catch (err) {
      lastError = (err && err.name === 'AbortError') ? 'Source ne waqt par jawab nahi diya.' : (err && err.message) || 'Fetch fail';
    }
    try {
      await store.setJSON(CACHE_KEY, { checkedAt, lastError, good: newGood, rowAt: cache.rowAt || 0 });
    } catch (err) { /* best effort */ }
  }

  const usable = newGood && (now - newGood.at) <= MAX_AGE_MS ? newGood : null;
  const changedAt = usable ? (usable.changedAt || usable.at) : null;
  return {
    rate: usable ? usable.rate : null,
    silver: usable ? usable.silver : 0,
    at: usable ? usable.at : null,
    changedAt: changedAt,
    rowPending: !!(usable && cache.rowAt !== changedAt),   // today's graph row not yet written for this price
    fresh,
    error: lastError,
    checkedAt,
    debug,
    sourceUrl
  };
}

// remember that the graph row for the price that changed at `changedAt` has been written
async function markRowWritten(store, changedAt) {
  const cache = (await readCache(store)) || {};
  cache.rowAt = changedAt;
  try { await store.setJSON(CACHE_KEY, cache); } catch (err) { /* best effort */ }
}

module.exports = { SOURCE_URL, CACHE_MS, isSafeUrl, parsePrices, htmlToText, getAutoRate, markRowWritten, resetCache };
