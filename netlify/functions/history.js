const { getStore } = require('@netlify/blobs');

// Public, read-only: the last 7 days of the admin-set gold (24K tola) and silver rates.
// The change log itself is written by rate.js every time the admin saves a new rate.
const STORE_NAME = 'gc-admin-settings';
const SETTINGS_KEY = 'settings';
const LOG_KEY = 'rate-history';
const DAYS = 7;
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;   // days are counted in Pakistan time (UTC+5)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30'
    },
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

function dayKey(ts) {
  return new Date(ts + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

// last moment (ms) of a Pakistan-time day
function dayEnd(day) {
  return Date.parse(day + 'T00:00:00Z') + 86400000 - PKT_OFFSET_MS;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  try {
    const store = getBlobsStore();

    // ---------- Admin: back-fill / correct the rate of PAST days ----------
    if (event.httpMethod === 'POST') {
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];
      if (provided !== adminPass) {
        return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'Unauthorized' }) };
      }

      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return json(400, { error: 'Invalid JSON' });
      }
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      const today = dayKey(Date.now());
      const oldest = dayKey(Date.now() - 60 * 86400000);

      const clean = [];
      for (const e of entries) {
        const date = String(e && e.date || '');
        const rate = parseFloat(e && e.rate);
        const silver = e && e.silver !== undefined && e.silver !== null && e.silver !== '' ? parseFloat(e.silver) : 0;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today || date < oldest) {
          return json(400, { error: 'Only past days (last 60 days) can be edited: ' + date });
        }
        if (!isFinite(rate) || rate <= 0 || rate > 100000000) {
          return json(400, { error: 'Invalid rate for ' + date });
        }
        if (!isFinite(silver) || silver < 0) {
          return json(400, { error: 'Invalid silver rate for ' + date });
        }
        clean.push({ date, rate, silver });
      }
      if (clean.length === 0) {
        return json(400, { error: 'No rates to save' });
      }

      let log = null;
      try {
        log = await store.get(LOG_KEY, { type: 'json' });
      } catch (err) {
        log = null;
      }
      if (!Array.isArray(log)) log = [];

      // a day's value = the last entry of that day, so replace everything logged for the edited days
      const editedDays = new Set(clean.map((c) => c.date));
      log = log.filter((l) => !editedDays.has(dayKey(l.t)));
      clean.forEach((c) => {
        log.push({ t: dayEnd(c.date) - 3600000, rate: c.rate, silver: c.silver, manual: true });   // 23:00 PKT of that day
      });
      log.sort((a, b) => a.t - b.t);
      if (log.length > 500) log = log.slice(-500);
      await store.setJSON(LOG_KEY, log);
      return json(200, { ok: true, saved: clean.length });
    }

    let log = null;
    try {
      log = await store.get(LOG_KEY, { type: 'json' });
    } catch (err) {
      log = null;
    }
    if (!Array.isArray(log)) log = [];

    // First run: start the log from whatever rate is saved right now
    if (log.length === 0) {
      let settings = null;
      try {
        settings = await store.get(SETTINGS_KEY, { type: 'json' });
      } catch (err) {
        settings = null;
      }
      if (settings && isFinite(settings.rate) && settings.rate > 0) {
        log = [{
          t: settings.updatedAt > 0 ? settings.updatedAt : Date.now(),
          rate: settings.rate,
          silver: settings.silver > 0 ? settings.silver : 0
        }];
        try { await store.setJSON(LOG_KEY, log); } catch (err) { /* best effort */ }
      }
    }

    log.sort((a, b) => a.t - b.t);

    const now = Date.now();
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const day = dayKey(now - i * 86400000);
      const end = dayEnd(day);
      // value of the day = the last rate saved on or before the end of that day
      let entry = null;
      for (let j = 0; j < log.length; j++) {
        if (log[j].t <= end) entry = log[j]; else break;
      }
      days.push({
        date: day,
        label: WEEKDAYS[new Date(day + 'T00:00:00Z').getUTCDay()],
        rate: entry ? entry.rate : null,
        silver: entry ? (entry.silver || 0) : null
      });
    }

    return json(200, { days, today: dayKey(now) });
  } catch (err) {
    console.error('history function error:', err);
    return json(500, { error: 'Server error' });
  }
};
