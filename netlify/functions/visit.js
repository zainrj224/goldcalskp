const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// Counts DIFFERENT visitors by IP address.
// Raw IPs are never stored — only a salted one-way hash, which is enough to count unique IPs.
const STORE_NAME = 'gc-admin-settings';
const KEY = 'visitors';
const MAX_IPS = 20000;      // safety cap on the stored list
const KEEP_DAYS = 90;       // per-day history kept for the "today / 7 days" numbers
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;   // days are counted in Pakistan time (UTC+5)

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function getBlobsStore() {
  // Same fallback pattern as rate.js / leads.js
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

function getClientIp(headers) {
  const h = {};
  Object.keys(headers || {}).forEach((k) => { h[k.toLowerCase()] = headers[k]; });
  const direct = h['x-nf-client-connection-ip'] || h['client-ip'] || h['x-real-ip'];
  if (direct) return String(direct).trim();
  const xff = h['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return '';
}

function hashIp(ip) {
  const salt = process.env.VISITOR_SALT || 'rj-gold-visitors-v1';
  return crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 24);
}

function emptyDoc() {
  return { visits: 0, ips: {}, days: {} };
}

async function loadDoc(store) {
  let doc = null;
  try {
    doc = await store.get(KEY, { type: 'json' });
  } catch (err) {
    doc = null;
  }
  if (!doc || typeof doc !== 'object') doc = emptyDoc();
  if (!doc.ips || typeof doc.ips !== 'object') doc.ips = {};
  if (!doc.days || typeof doc.days !== 'object') doc.days = {};
  if (!isFinite(doc.visits)) doc.visits = 0;
  return doc;
}

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|monitor|uptime|curl|wget|python-requests|headless|lighthouse/i;

exports.handler = async (event) => {
  try {
    const store = getBlobsStore();

    // ---------- Admin: read the numbers ----------
    if (event.httpMethod === 'GET') {
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];
      if (provided !== adminPass) {
        return json(401, { error: 'Unauthorized' });
      }

      const doc = await loadDoc(store);
      const now = Date.now();
      const today = dayKey(now);

      function uniqueSince(nDays) {
        const set = new Set();
        for (let i = 0; i < nDays; i++) {
          const d = doc.days[dayKey(now - i * 86400000)];
          if (d && Array.isArray(d.u)) d.u.forEach((h) => set.add(h));
        }
        return set.size;
      }

      const todayDoc = doc.days[today];
      let lastVisit = 0;
      Object.keys(doc.ips).forEach((h) => {
        const l = doc.ips[h] && doc.ips[h][1];
        if (l > lastVisit) lastVisit = l;
      });

      return json(200, {
        uniqueTotal: Object.keys(doc.ips).length,
        uniqueToday: todayDoc && Array.isArray(todayDoc.u) ? todayDoc.u.length : 0,
        unique7: uniqueSince(7),
        unique30: uniqueSince(30),
        visitsTotal: doc.visits,
        visitsToday: todayDoc ? (todayDoc.v || 0) : 0,
        lastVisit: lastVisit || null
      });
    }

    // ---------- Public: record a visit ----------
    if (event.httpMethod === 'POST') {
      const ua = (event.headers['user-agent'] || event.headers['User-Agent'] || '').toString();
      if (BOT_RE.test(ua)) {
        return json(200, { ok: true, counted: false });
      }
      const ip = getClientIp(event.headers);
      if (!ip) {
        return json(200, { ok: true, counted: false });
      }

      const h = hashIp(ip);
      const now = Date.now();
      const today = dayKey(now);
      const doc = await loadDoc(store);

      doc.visits += 1;

      if (doc.ips[h]) {
        doc.ips[h][1] = now;     // last seen
        doc.ips[h][2] = (doc.ips[h][2] || 0) + 1;
      } else if (Object.keys(doc.ips).length < MAX_IPS) {
        doc.ips[h] = [now, now, 1];   // [first seen, last seen, visits]
      }

      if (!doc.days[today]) doc.days[today] = { u: [], v: 0 };
      const day = doc.days[today];
      day.v += 1;
      if (day.u.indexOf(h) === -1) day.u.push(h);

      // drop old per-day history
      const cutoff = dayKey(now - KEEP_DAYS * 86400000);
      Object.keys(doc.days).forEach((k) => { if (k < cutoff) delete doc.days[k]; });

      await store.setJSON(KEY, doc);
      return json(200, { ok: true, counted: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('visit function error:', err);
    return json(500, { error: 'Server error' });
  }
};
