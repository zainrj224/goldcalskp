// Shared helpers: the shop's rate is stored ONE ROW PER DATE (Pakistan time).
// Saving a rate for a date replaces that date's row; other dates are never touched.
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'gc-admin-settings';
const SETTINGS_KEY = 'settings';
const DAYS_KEY = 'rate-days';          // { 'YYYY-MM-DD': { rate, silver } }
const OLD_LOG_KEY = 'rate-history';    // older change-log format, converted on first read
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;   // UTC+5
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_DAYS_KEPT = 400;

const DEFAULT_SETTINGS = {
  rate: 450000,
  silver: 0,
  masha: 2,
  vol: '200',
  live: true,
  spot: false,
  autoRate: false,
  updatedAt: 0
};

function getBlobsStore() {
  // Same fallback as the other functions (see rate.js)
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

function todayKey() {
  return dayKey(Date.now());
}

function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
}

async function loadSettings(store) {
  let settings = null;
  try {
    settings = await store.get(SETTINGS_KEY, { type: 'json' });
  } catch (err) {
    settings = null;
  }
  return settings || null;
}

async function loadDays(store) {
  let days = null;
  try {
    days = await store.get(DAYS_KEY, { type: 'json' });
  } catch (err) {
    days = null;
  }
  if (days && typeof days === 'object' && !Array.isArray(days)) return days;

  // convert the older change-log (the last change of each day wins)
  const out = {};
  let log = null;
  try {
    log = await store.get(OLD_LOG_KEY, { type: 'json' });
  } catch (err) {
    log = null;
  }
  if (Array.isArray(log)) {
    log.slice().sort((a, b) => a.t - b.t).forEach((l) => {
      if (l && l.rate > 0) out[dayKey(l.t)] = { rate: l.rate, silver: l.silver > 0 ? l.silver : 0 };
    });
  }
  return out;
}

async function saveDays(store, days) {
  const keys = Object.keys(days).sort();
  if (keys.length > MAX_DAYS_KEPT) {
    keys.slice(0, keys.length - MAX_DAYS_KEPT).forEach((k) => { delete days[k]; });
  }
  await store.setJSON(DAYS_KEY, days);
}

// first run: start the table from the rate that is saved right now
async function seedIfEmpty(store, days) {
  if (Object.keys(days).length > 0) return days;
  const settings = await loadSettings(store);
  if (settings && isFinite(settings.rate) && settings.rate > 0) {
    days[dayKey(settings.updatedAt > 0 ? settings.updatedAt : Date.now())] = {
      rate: settings.rate,
      silver: settings.silver > 0 ? settings.silver : 0
    };
    try { await saveDays(store, days); } catch (err) { /* best effort */ }
  }
  return days;
}

function latestDate(days) {
  const keys = Object.keys(days).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

// the rate that applies on a date: that date's own row, else the most recent earlier row
function valueOn(days, date) {
  if (days[date]) return days[date];
  let best = null;
  Object.keys(days).forEach((k) => {
    if (k < date && (best === null || k > best)) best = k;
  });
  return best ? days[best] : null;
}

function lastDays(days, n) {
  const now = Date.now();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dayKey(now - i * 86400000);
    const v = valueOn(days, date);
    out.push({
      date,
      label: WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()],
      rate: v ? v.rate : null,
      silver: v ? (v.silver || 0) : null,
      recorded: !!days[date]
    });
  }
  return out;
}

module.exports = {
  DEFAULT_SETTINGS, SETTINGS_KEY, getBlobsStore, dayKey, todayKey, isDateKey,
  loadSettings, loadDays, saveDays, seedIfEmpty, latestDate, valueOn, lastDays
};
