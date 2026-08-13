// /api/event. The first-party collector for the measured demo funnel.
//
// The 08-12 redesign verdict needs this site to produce two of the four
// measurements that move the company verdict from 87 to 90-92. This is where
// those measurements land. It is deliberately tiny and deliberately strict:
//
//   - POST only, JSON only, and only event names on the explicit allowlist
//     below. Anything else is a 400. An open collector fills with garbage
//     and garbage cannot move a verdict.
//   - No cookies, no third-party pixels, no fingerprinting. The only visitor
//     signals kept are the user agent string and a sha256 hash of the
//     connecting IP. The raw IP is never stored.
//   - Storage is Netlify Blobs, store "events", one small JSON value per
//     event. Keys are ISO date, a slash, then timestamp-random, so one day's
//     events list under one prefix.
//   - It fails LOUD. If the blob store cannot be loaded or written, the
//     caller gets a 500 and console.error says why. A collector that fails
//     silently reads later as "zero events", and a zero that was never
//     measured is a lie (see: a column never written reads as a measured zero).
'use strict';

const crypto = require('crypto');

const ALLOWED = new Set([
  'page_view',
  'track_flip',
  'aud_choice',
  'interest_submitted',
  'calc_used',
  'audio_play',
  'demo_health_state',
  'demo_button_rendered',
  'ring_test_requested',
  'ring_test_connected',
  'ring_test_completed',
  'ring_test_failed',
  'turn_on_clicked',
  'carrier_selected',
  'activation_started',
  'forwarding_verified',
  'test_call_passed',
]);

const META_CAP_BYTES = 2048; // serialized meta over 2KB is a client bug; reject it

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' };
  }

  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Body must be JSON.' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { statusCode: 400, body: 'Body must be a JSON object.' };
  }

  const name = typeof payload.event === 'string' ? payload.event : '';
  if (!ALLOWED.has(name)) {
    return { statusCode: 400, body: 'Unknown event name.' };
  }

  const page = String(payload.page == null ? '' : payload.page).slice(0, 300);

  let metaJson;
  try {
    metaJson = JSON.stringify(payload.meta == null ? {} : payload.meta);
  } catch (e) {
    return { statusCode: 400, body: 'meta must be plain JSON.' };
  }
  if (metaJson === undefined) metaJson = '{}';
  if (Buffer.byteLength(metaJson, 'utf8') > META_CAP_BYTES) {
    return { statusCode: 400, body: 'meta is over the 2KB cap.' };
  }

  // headers arrive with unpredictable casing; normalize once
  const headers = {};
  for (const k in (event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
  const ua = String(headers['user-agent'] || '').slice(0, 400);
  const ip = String(headers['x-nf-client-connection-ip'] || headers['client-ip'] || '');
  const ipSha256 = ip ? crypto.createHash('sha256').update(ip).digest('hex') : '';

  const now = new Date();
  const record = {
    event: name,
    page: page,
    meta: JSON.parse(metaJson),
    ua: ua,
    ip_sha256: ipSha256, // hash only, never the raw IP
    at: now.toISOString(),
  };
  const key =
    now.toISOString().slice(0, 10) + '/' +
    Date.now() + '-' + crypto.randomBytes(4).toString('hex');

  // dynamic import so this CJS handler works however @netlify/blobs is packaged
  let blobs;
  try {
    blobs = await import('@netlify/blobs');
  } catch (e) {
    console.error('EVENT COLLECTOR DOWN: @netlify/blobs failed to load:', e && e.message);
    return { statusCode: 500, body: 'Event store unavailable.' };
  }

  try {
    if (typeof blobs.connectLambda === 'function') {
      // Lambda-compat functions carry their blobs context on the event itself.
      // If this throws, the automatic env may still be configured, so the real
      // verdict comes from the write below, which fails loud on its own.
      try { blobs.connectLambda(event); } catch (e) { /* verdict comes from the write */ }
    }
    const store = blobs.getStore('events');
    await store.setJSON(key, record);
  } catch (e) {
    console.error('EVENT COLLECTOR DOWN: blob write failed:', e && e.message);
    return { statusCode: 500, body: 'Event not stored.' };
  }

  return { statusCode: 204, body: '' };
};
