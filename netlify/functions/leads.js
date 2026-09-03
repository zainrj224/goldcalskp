const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'gc-admin-settings';
const KEY = 'leads';
const MAX_LEADS = 500;

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
  // Same fallback pattern as rate.js — see that file for why this exists.
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
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];

      if (provided !== adminPass) {
        return json(401, { error: 'Unauthorized' });
      }

      let leads;
      try {
        leads = await store.get(KEY, { type: 'json' });
      } catch (err) {
        leads = null;
      }
      return json(200, { leads: leads || [] });
    }

    if (event.httpMethod === 'POST') {
      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return json(400, { error: 'Invalid JSON body' });
      }

      const name = (payload.name || '').toString().trim().slice(0, 100);
      const phone = (payload.phone || '').toString().trim().slice(0, 30);

      if (!name || !phone) {
        return json(400, { error: 'Name and phone are required' });
      }

      let leads;
      try {
        leads = await store.get(KEY, { type: 'json' });
      } catch (err) {
        leads = null;
      }
      if (!Array.isArray(leads)) leads = [];

      leads.unshift({
        name,
        phone,
        page: (payload.page || '').toString().slice(0, 200),
        createdAt: Date.now()
      });

      if (leads.length > MAX_LEADS) leads = leads.slice(0, MAX_LEADS);

      await store.setJSON(KEY, leads);

      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const adminPass = process.env.ADMIN_PASS || 'admin123';
      const provided = event.headers['x-admin-pass'] || event.headers['X-Admin-Pass'];

      if (provided !== adminPass) {
        return json(401, { error: 'Unauthorized' });
      }

      await store.setJSON(KEY, []);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST, DELETE' });
  } catch (err) {
    return json(500, {
      error: 'Function crashed',
      message: err && err.message ? err.message : String(err)
    });
  }
};
