const {
  getBlobsStore, todayKey, loadDays, seedIfEmpty, lastDays, loadPoints, appendPoint, windowPoints, RANGES, valueOn
} = require('./lib/rate-days');

// Public, read-only: price history for the graph.
//   ?range=7d | 3d | 24h | 1h   -> timestamped points inside that window (starts with the price already live at the window start)
//   days                        -> the last 7 dates (one row per date)
// Prices are recorded by rate.js (manual saves, auto fetches) and daily-rate.js.
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=5'
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
    const q = event.queryStringParameters || {};
    const range = RANGES[q.range] ? q.range : '7d';
    const now = Date.now();

    let days = await loadDays(store);
    days = await seedIfEmpty(store, days);

    let points = await loadPoints(store);
    if (points.length === 0) {
      // first run: start the point log from the latest recorded rate
      const v = valueOn(days, todayKey());
      if (v && v.rate > 0) {
        try { await appendPoint(store, v.rate, v.silver || 0, now); } catch (err) { /* best effort */ }
        points = await loadPoints(store);
      }
    }

    return json(200, {
      range,
      now,
      today: todayKey(),
      points: windowPoints(points, days, range, now, 300),
      days: lastDays(days, 7)
    });
  } catch (err) {
    console.error('history function error:', err);
    return json(500, { error: 'Server error' });
  }
};
