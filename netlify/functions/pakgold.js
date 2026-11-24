const { getStore } = require('@netlify/blobs');
const { SOURCE_URL, getAutoRate } = require('./lib/pakgold');

// Admin-only: switch the live board between AUTO (pakgold.net) and MANUAL (the shop's own daily rate),
// and test what pakgold.net currently returns.
const STORE_NAME = 'gc-admin-settings';
const SETTINGS_KEY = 'settings';
const DEFAULTS = { rate: 450000, silver: 0, masha: 2, vol: '200', live: true, spot: false, updatedAt: 0 };

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
    silverFrom: r.debug && r.debug.silverContext ? r.debug.silverContext : null
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
    const ref = { rate: settings.rate, silver: settings.silver };

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const result = await getAutoRate(store, ref, { force: q.force === '1' });
      return json(200, { auto: !!settings.autoRate, source: SOURCE_URL, result: summarize(result) });
    }

    if (event.httpMethod === 'POST') {
      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return json(400, { error: 'Invalid JSON' });
      }
      const auto = !!payload.auto;
      settings.autoRate = auto;
      settings.updatedAt = Date.now();     // makes every open website page pick the change up
      await store.setJSON(SETTINGS_KEY, settings);
      // when switching ON, fetch right away so the admin immediately sees whether it works
      const result = auto ? await getAutoRate(store, ref, { force: true }) : null;
      return json(200, { ok: true, auto, source: SOURCE_URL, result: result ? summarize(result) : null });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('pakgold function error:', err);
    return json(500, { error: 'Server error' });
  }
};
