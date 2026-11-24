const { getStore } = require('@netlify/blobs');
const { dayKey, loadDays, saveDays } = require('./lib/rate-days');
const { getAutoRate, markRowWritten } = require('./lib/pakgold');

const STORE_NAME = 'gc-admin-settings';
const KEY = 'settings';

const DEFAULTS = {
  rate: 450000,
  silver: 0,
  masha: 2,
  vol: '200',
  live: true,
  spot: false,
  autoRate: false,
  updatedAt: 0
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

function getBlobsStore() {
  // Netlify normally auto-injects the Blobs connection context into every
  // function at deploy time. On some deploys that injection doesn't happen
  // (a known platform quirk — see https://github.com/netlify/blobs/issues/175),
  // which surfaces as MissingBlobsEnvironmentError. As a fallback, allow
  // configuring the store explicitly via env vars: BLOBS_SITE_ID (Site
  // settings > General > Site details > Site ID) and BLOBS_API_TOKEN (a
  // Personal Access Token from https://app.netlify.com/user/applications).
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_API_TOKEN;

  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  try {
    const store = getBlobsStore();

    if (event.httpMethod === 'GET') {
      let settings;
      try {
        settings = await store.get(KEY, { type: 'json' });
      } catch (err) {
        settings = null;
      }
      settings = settings || DEFAULTS;

      // admin panel asks for the stored (manual) settings with ?raw=1
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const providedPass = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];
      const wantsRaw = !!(event.queryStringParameters && event.queryStringParameters.raw) && providedPass === adminPass;
      if (wantsRaw || !settings.autoRate) {
        return json(200, settings);
      }

      // AUTO mode: the website shows the pakgold.net rate; if it is unavailable, the manual rate is used
      const auto = await getAutoRate(store, { rate: settings.rate, silver: settings.silver });
      if (auto.rate) {
        if (auto.rowPending) {
          // keep the 7-day graph in step: today's row = latest auto rate (written once per new price)
          try {
            const days = await loadDays(store);
            days[dayKey(Date.now())] = { rate: auto.rate, silver: auto.silver > 0 ? auto.silver : (settings.silver || 0) };
            await saveDays(store, days);
            await markRowWritten(store, auto.at);
          } catch (err) {
            console.error('auto rate history save failed:', err);
          }
        }
        return json(200, Object.assign({}, settings, {
          rate: auto.rate,
          silver: auto.silver > 0 ? auto.silver : settings.silver,
          live: false,                                  // real prices: no simulated flicker
          updatedAt: Math.max(settings.updatedAt || 0, auto.at),
          auto: { on: true, source: 'pakgold.net', at: auto.at, fallback: false }
        }));
      }
      return json(200, Object.assign({}, settings, {
        auto: { on: true, source: 'pakgold.net', at: null, fallback: true, error: auto.error }
      }));
    }

    if (event.httpMethod === 'POST') {
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];

      if (provided !== adminPass) {
        return json(401, { error: 'Unauthorized' });
      }

      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return json(400, { error: 'Invalid JSON body' });
      }

      const rate = parseFloat(payload.rate);
      const masha = parseFloat(payload.masha);

      // Silver rate per tola (PKR). 0 = not set / hide silver on the board.
      // If the client doesn't send it, keep whatever was saved before.
      let silver;
      if (payload.silver === undefined || payload.silver === null || payload.silver === '') {
        let prev = null;
        try {
          prev = await store.get(KEY, { type: 'json' });
        } catch (err) {
          prev = null;
        }
        silver = prev && isFinite(prev.silver) && prev.silver > 0 ? prev.silver : 0;
      } else {
        silver = parseFloat(payload.silver);
        if (!isFinite(silver) || silver < 0) {
          return json(400, { error: 'Invalid silver rate' });
        }
      }

      if (!isFinite(rate) || rate <= 0) {
        return json(400, { error: 'Invalid rate' });
      }
      if (!isFinite(masha) || masha < 0) {
        return json(400, { error: 'Invalid masha' });
      }

      const settings = {
        rate,
        silver,
        masha,
        vol: payload.vol != null ? String(payload.vol) : DEFAULTS.vol,
        live: !!payload.live,
        spot: !!payload.spot,
        updatedAt: Date.now()
      };

      let before = null;
      try {
        before = await store.get(KEY, { type: 'json' });
      } catch (err) {
        before = null;
      }

      settings.autoRate = !!(before && before.autoRate);   // Save All never switches the source by accident

      await store.setJSON(KEY, settings);

      // one row per date for the 7-day graph. Only when the rate itself changed (not for making/volatility
      // changes); saving again on the same date replaces that date's row.
      const rateChanged = !before || before.rate !== settings.rate || (before.silver || 0) !== (settings.silver || 0);
      if (rateChanged) {
        try {
          const days = await loadDays(store);
          days[dayKey(settings.updatedAt)] = { rate: settings.rate, silver: settings.silver || 0 };
          await saveDays(store, days);
        } catch (err) {
          console.error('rate history save failed:', err);
        }
      }

      return json(200, settings);
    }

    return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  } catch (err) {
    // Surface the real failure instead of a bare 502, so it's diagnosable
    // from the browser Network tab without needing the Netlify function logs.
    return json(500, {
      error: 'Function crashed',
      message: err && err.message ? err.message : String(err)
    });
  }
};
