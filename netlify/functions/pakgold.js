const { getStore } = require('@netlify/blobs');
const { SOURCE_URL, isSafeUrl, getAutoRate, resetCache } = require('./lib/pakgold');
const { appendPoint } = require('./lib/rate-days');

// Admin-only: switch the live board between AUTO (pakgold.net) and MANUAL (the shop's own daily rate),
// and test what pakgold.net currently returns.
const STORE_NAME = 'gc-admin-settings';
const SETTINGS_KEY = 'settings';
const DEFAULTS = { rate: 450000, silver: 0, masha: 2, vol: '200', live: true, spot: false, autoRate: false, autoUrl: '', updatedAt: 0 };

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function getBlobsStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

function summarize(r) {
  return {
    rate: r.rate,
    silver: r.silver,
    at: r.at,
    fresh: r.fresh,
    error: r.error,
    pickedFrom: r.debug && r.debug.goldContext ? r.debug.goldContext : null,
    silverFrom: r.debug && r.debug.silverContext ? r.debug.silverContext : null,
    candidates: r.debug && r.debug.candidates ? r.debug.candidates : [],
    headline: !!(r.debug && r.debug.headline),
    kind: r.debug && r.debug.kind ? r.debug.kind : null,
    sourceUrl: r.sourceUrl
  };
}

exports.handler = async (event) => {
  try {
    const adminPass = process.env.ADMIN_PASS || 'admin123';
    const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];
    if (provided !== adminPass) {
      return json(401, { error: 'Unauthorized' });
    }

    const store = getBlobsStore();
    let settings = null;
    try {
      settings = await store.get(SETTINGS_KEY, { type: 'json' });
    } catch (err) {
      settings = null;
    }
    settings = settings || Object.assign({}, DEFAULTS);
    const ref = { rate: settings.rate, silver: settings.silver, url: settings.autoUrl };

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const result = await getAutoRate(store, ref, { force: q.force === '1' });
      return json(200, { auto: !!settings.autoRate, url: settings.autoUrl || '', source: SOURCE_URL, result: summarize(result) });
    }

    if (event.httpMethod === 'POST') {
      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return json(400, { error: 'Invalid JSON' });
      }
      // optional exact data link (https only); empty string = back to the pakgold.net page
      if (typeof payload.url === 'string') {
        const u = payload.url.trim();
        if (u !== '' && !isSafeUrl(u)) {
          return json(400, { error: 'Link https:// se shuru hona chahiye (aur sahi website ka honi chahiye).' });
        }
        settings.autoUrl = u;
        ref.url = u;
        await resetCache(store);           // next check uses the new source
      }
      const wasAuto = !!settings.autoRate;
      const auto = payload.auto === undefined ? wasAuto : !!payload.auto;
      settings.autoRate = auto;
      settings.updatedAt = Date.now();     // makes every open website page pick the change up
      await store.setJSON(SETTINGS_KEY, settings);
      // switching back to manual: the graph shows the moment the manual rate took over
      if (wasAuto && !auto) {
        try { await appendPoint(store, settings.rate, settings.silver || 0, Date.now()); } catch (err) { /* best effort */ }
      }
      // when ON (or the link changed), fetch right away so the admin immediately sees whether it works
      const result = auto ? await getAutoRate(store, ref, { force: true }) : null;
      return json(200, { ok: true, auto, url: settings.autoUrl || '', source: SOURCE_URL, result: result ? summarize(result) : null });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('pakgold function error:', err);
    return json(500, { error: 'Server error' });
  }
};
