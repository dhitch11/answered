// osm.mjs — real contractor businesses with real published phone numbers, from OpenStreetMap.
//
// Why OSM and not a lead vendor: it is free, it needs no key, the data is contributed publicly by
// the businesses and their neighbours, and every record carries the state we queried, which is
// what the calling-hours gate needs. The estate's Apollo key is payment-disabled (403).
//
// This pulls only what is already published: name, phone, address, website, trade. No emails, no
// personal names, no scraping behind a login, nothing inferred.
//
// Overpass is a shared free service. Be a good citizen: one state at a time, a real timeout, and
// a pause between requests. If you need volume, run it overnight, not in a loop.

// OSM's usage policy requires a descriptive User-Agent with a contact route. Sending none
// gets you a 406 from Apache, not a helpful error.
const UA = 'Answered-Research/1.0 (contact: info@reddenda.com) node-fetch';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// The trades Answered sells to. OSM tags them under craft=, shop= and office=.
export const TRADES = {
  plumber:     ['nwr["craft"="plumber"]'],
  hvac:        ['nwr["craft"="hvac"]', 'nwr["shop"="hvac"]'],
  electrician: ['nwr["craft"="electrician"]'],
  roofer:      ['nwr["craft"="roofer"]'],
  carpenter:   ['nwr["craft"="carpenter"]'],
  painter:     ['nwr["craft"="painter"]'],
  locksmith:   ['nwr["craft"="locksmith"]', 'nwr["shop"="locksmith"]'],
  garage_door: ['nwr["craft"="door_construction"]'],
  landscaper:  ['nwr["craft"="gardener"]'],
  flooring:    ['nwr["craft"="floorer"]'],
  pest:        ['nwr["craft"="pest_control"]'],
  general:     ['nwr["craft"="builder"]', 'nwr["office"="contractor"]'],
};

/** US phone strings in OSM are messy. Normalise to E.164 or return null. */
export function toE164(raw) {
  if (!raw) return null;
  // OSM sometimes packs several numbers into one tag.
  const first = String(raw).split(/[;,]/)[0];
  const digits = first.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

// MEASURED 2026-08-13: a 26-selector statewide union returns 200 with an EMPTY elements array,
// because it exceeds the server-side budget and Overpass gives up quietly rather than erroring.
// A 4-selector query over the same state returns 76 elements. So selectors are chunked, and a
// chunk that comes back empty is a real zero rather than a silent failure.
const SELECTORS_PER_QUERY = 4;

function buildQuery(state, selectors, limit) {
  const clauses = selectors
    .map((sel) => `  ${sel}["phone"](area.a);\n  ${sel}["contact:phone"](area.a);`)
    .join('\n');
  return `[out:json][timeout:90];
area["ISO3166-2"="US-${state}"]->.a;
(
${clauses}
);
out center ${limit};`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Overpass publishes its own rate limit and free-slot count at /api/status. Read it and wait for
 * a slot instead of firing and hoping. A 429 here is not a transient blip to retry through, it is
 * the service telling you that you are being rude.
 */
async function waitForSlot(endpoint, maxWaitMs = 180000) {
  const statusUrl = endpoint.replace('/api/interpreter', '/api/status');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;                                   // no status endpoint: just proceed
      const text = await res.text();
      const free = /(\d+) slots available now/.exec(text);
      if (free && Number(free[1]) > 0) return;
      if (/Rate limit: 0/.test(text)) return;                // unlimited endpoint
      const waits = [...text.matchAll(/in (\d+) seconds/g)].map((m) => Number(m[1]));
      const wait = waits.length ? Math.min(...waits) + 2 : 15;
      await sleep(Math.min(wait, 60) * 1000);
    } catch { return; }
  }
}

async function post(query, { attempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      await waitForSlot(endpoint);
      // MEASURED 2026-08-13: Overpass wants the query form-encoded as `data=`. Posting it as a
      // raw text/plain body returns 504 and 429 rather than a parse error, which reads exactly
      // like rate limiting and sent this lane chasing a throttle that was not there.
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // MEASURED 2026-08-13: without these two headers the endpoint returns 406 Not
          // Acceptable from Apache, and the retry loop reads it as throttling. Node's fetch
          // sends no descriptive User-Agent, and the OSM usage policy requires one. Every
          // "429" chased for an hour was this.
          'User-Agent': UA,
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(180000),
      });
      if (res.status === 429 || res.status === 504) throw new Error(`overpass ${res.status}`);
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(8000 * (attempt + 1), 45000));    // linear backoff, capped
    }
  }
  throw lastErr;
}

/**
 * Pull contractors for one state.
 * @returns [{ source, sourceId, name, phone, rawPhone, trade, state, city, street, website, lat, lon }]
 */
export async function pullState({ state, trades = Object.keys(TRADES), limit = 400, onProgress }) {
  const selectors = trades.flatMap((t) => TRADES[t] || []);
  const seen = new Set();
  const out = [];
  const batches = chunk(selectors, SELECTORS_PER_QUERY);

  for (let i = 0; i < batches.length; i += 1) {
    let data = null;
    try {
      data = await post(buildQuery(state, batches[i], limit));
    } catch (e) {
      // A big state (TX, FL, CA) can blow the server-side budget with several selectors in one
      // union and come back 504 or 429, which reads like throttling but is really query cost.
      // Fall back to one selector at a time before giving up on the batch.
      onProgress?.({ state, batch: i + 1, of: batches.length, error: `${e.message}; retrying one selector at a time` });
      const merged = { elements: [] };
      for (const sel of batches[i]) {
        try {
          const one = await post(buildQuery(state, [sel], limit));
          merged.elements.push(...(one.elements || []));
        } catch (e2) {
          onProgress?.({ state, batch: i + 1, of: batches.length, error: `${sel}: ${e2.message}` });
        }
        await sleep(2000);
      }
      data = merged;
    }

    let added = 0;
    for (const el of data.elements || []) {
      const t = el.tags || {};
      const phone = toE164(t.phone || t['contact:phone']);
      if (!phone) continue;
      if (seen.has(phone)) continue;               // one record per number, ever
      seen.add(phone);

      const trade = t.craft || t.shop || t.office || 'general';
      out.push({
        source: 'openstreetmap',
        sourceId: `${el.type}/${el.id}`,
        name: t.name || t.operator || null,
        phone,
        rawPhone: t.phone || t['contact:phone'],
        trade,
        state: state.toUpperCase(),                 // the fact the calling-hours gate needs
        city: t['addr:city'] || null,
        street: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
        website: t.website || t['contact:website'] || null,
        lat: el.lat ?? el.center?.lat ?? null,
        lon: el.lon ?? el.center?.lon ?? null,
      });
      added += 1;
    }
    onProgress?.({ state, batch: i + 1, of: batches.length, found: added });
    await sleep(2500);
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
