const {
  DEFAULT_SETTINGS, SETTINGS_KEY, getBlobsStore, dayKey, todayKey, isDateKey,
  loadSettings, loadDays, saveDays, seedIfEmpty, latestDate, valueOn, lastDays
} = require('./lib/rate-days');

// Simple "daily rate" endpoint used by the salesman page (update.html).
// One rate per DATE: saving a date replaces that date only. The live board always shows
// the rate of the most recent date.
const MAX_BACKDATE_DAYS = 60;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function isAuthorized(event) {
  const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];
  if (!provided) return false;
  const adminPass = process.env.ADMIN_PASS || 'admin123';
  const salesmanPass = process.env.SALESMAN_PASS || '';   // optional separate passcode for the salesman
  return provided === adminPass || (salesmanPass !== '' && provided === salesmanPass);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }
    if (!isAuthorized(event)) {
      return json(401, { error: 'Unauthorized' });
    }

    const store = getBlobsStore();
    let days = await loadDays(store);
    days = await seedIfEmpty(store, days);
    const today = todayKey();

    // ---------- read: last 7 days + the value for one date ----------
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const date = isDateKey(q.date) ? q.date : today;
      const v = valueOn(days, date);
      return json(200, {
        today,
        selected: { date, rate: v ? v.rate : null, silver: v ? (v.silver || 0) : null, recorded: !!days[date] },
        days: lastDays(days, 7)
      });
    }

    // ---------- save a rate for a date ----------
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (err) {
      return json(400, { error: 'Invalid JSON' });
    }

    const date = payload.date ? String(payload.date) : today;
    const oldest = dayKey(Date.now() - MAX_BACKDATE_DAYS * 86400000);
    if (!isDateKey(date) || date > today || date < oldest) {
      return json(400, { error: 'Date sahi nahi hai (aaj ya pichle 60 din ke andar honi chahiye).' });
    }
    const rate = parseFloat(payload.rate);
    if (!isFinite(rate) || rate <= 0 || rate > 100000000) {
      return json(400, { error: 'Sahi 24K tola rate daalein.' });
    }

    const settings = (await loadSettings(store)) || Object.assign({}, DEFAULT_SETTINGS);

    // silver: blank = keep what that date (or the day before) already had
    let silver;
    if (payload.silver === undefined || payload.silver === null || payload.silver === '') {
      const existing = valueOn(days, date);
      silver = existing && existing.silver > 0 ? existing.silver : (date >= (latestDate(days) || date) && settings.silver > 0 ? settings.silver : 0);
    } else {
      silver = parseFloat(payload.silver);
      if (!isFinite(silver) || silver < 0) {
        return json(400, { error: 'Sahi silver rate daalein (ya khali chhor dein).' });
      }
    }

    // replace this date's row (a second change on the same date overwrites the first)
    days[date] = { rate, silver };
    await saveDays(store, days);

    // the live board shows the rate of the most recent date
    let live = false;
    if (date === latestDate(days)) {
      const next = Object.assign({}, settings, { rate, silver, updatedAt: Date.now() });
      await store.setJSON(SETTINGS_KEY, next);
      live = true;
    }

    return json(200, {
      ok: true,
      date,
      rate,
      silver,
      live,
      today,
      days: lastDays(days, 7)
    });
  } catch (err) {
    console.error('daily-rate function error:', err);
    return json(500, { error: 'Server error' });
  }
};
