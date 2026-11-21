const { getBlobsStore, todayKey, loadDays, seedIfEmpty, lastDays } = require('./lib/rate-days');

// Public, read-only: the last 7 days of the shop's rate, one row per date.
// Rates are written by rate.js (admin) and daily-rate.js (salesman page).
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  try {
    const store = getBlobsStore();
    let days = await loadDays(store);
    days = await seedIfEmpty(store, days);
    return json(200, { days: lastDays(days, 7), today: todayKey() });
  } catch (err) {
    console.error('history function error:', err);
    return json(500, { error: 'Server error' });
  }
};
