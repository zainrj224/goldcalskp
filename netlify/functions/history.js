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
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  try {
    const store = getBlobsStore();

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

    return json(200, { days });
  } catch (err) {
    console.error('history function error:', err);
    return json(500, { error: 'Server error' });
  }
};
