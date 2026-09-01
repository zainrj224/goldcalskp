const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'gc-admin-settings';
const KEY = 'settings';

const DEFAULTS = {
  rate: 450000,
  masha: 2,
  vol: '200',
  live: true,
  spot: false,
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

exports.handler = async (event) => {
  try {
    const store = getStore(STORE_NAME);

    if (event.httpMethod === 'GET') {
      let settings;
      try {
        settings = await store.get(KEY, { type: 'json' });
      } catch (err) {
        settings = null;
      }
      return json(200, settings || DEFAULTS);
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

      if (!isFinite(rate) || rate <= 0) {
        return json(400, { error: 'Invalid rate' });
      }
      if (!isFinite(masha) || masha < 0) {
        return json(400, { error: 'Invalid masha' });
      }

      const settings = {
        rate,
        masha,
        vol: payload.vol != null ? String(payload.vol) : DEFAULTS.vol,
        live: !!payload.live,
        spot: !!payload.spot,
        updatedAt: Date.now()
      };

      await store.setJSON(KEY, settings);

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
