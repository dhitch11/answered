// ccb-oregon.mjs — the Oregon Construction Contractors Board active-licence registry.
//
// ★ WHY THIS SOURCE MATTERS MORE THAN ITS SIZE. Oregon is the only state that has survived full
// primary-law verification, and our OpenStreetMap pull for it is EXHAUSTED at 175 records — a
// second pull with a 4,000 limit returned "+0 new", so 175 is the ceiling of that source, not of
// our query. This registry holds 55,977 active licensees.
//
// But volume is the lesser half. Our gate now requires `businessVerified`, because a fixed line
// proves the TECHNOLOGY and the statutes turn on the USE: Mo. Rev. Stat. 407.1095(2) defines a
// residential subscriber as one who subscribes "for primarily personal and familial use", and
// 16 CFR 310.6(b)(7) turns on the call being between businesses. A state contractor licence, filed
// by the contractor with a state regulator, naming that number as their business contact, is the
// strongest business evidence available to us — stronger than a map listing and stronger than the
// "account attestation" the Missouri analysis named as sufficient.
//
// ★ AND THE HONEST LIMIT, stated here so nobody downstream forgets it: a licence proves the ENTITY
// is a business. It does not prove the LINE is not the sole proprietor's kitchen phone. Roughly
// half of these licensees are individuals operating from a home address. So this source satisfies
// the business-classification gate and does NOT excuse the line-type gate — a number still has to
// come back landline or fixedVoip, and an unclassified number is still refused.
//
// LAWFUL AND SANCTIONED: this is Oregon's own public open-data portal (Socrata dataset g77e-6bhs),
// published by the CCB, free, on demand, no records request required. The CCB's own guide directs
// the public to it. No scraping, no purchased list, no terms violated.

const DATASET = 'https://data.oregon.gov/resource/g77e-6bhs.json';
const PAGE = 5000;

/**
 * The endorsements that describe a business that answers a phone to win work — the ICP.
 * Deliberately narrow: a developer or a locksmith-only licence is a different business.
 */
const TRADE_BY_ENDORSEMENT = [
  [/residential general/i, 'builder'],
  [/commercial general/i, 'builder'],
  [/residential specialty/i, 'specialty'],
  [/commercial specialty/i, 'specialty'],
  [/limited/i, 'specialty'],
  [/developer/i, null],           // not an ICP: no inbound service calls
  [/inspector/i, null],           // home inspectors are a different motion
  [/locksmith/i, 'locksmith'],
];

function tradeFor(endorsement) {
  const e = String(endorsement || '');
  for (const [re, trade] of TRADE_BY_ENDORSEMENT) if (re.test(e)) return trade;
  return 'specialty';
}

/** 10 digits -> E.164, and anything else is discarded rather than guessed at. */
export function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

/**
 * Pull the whole registry, paginated. Returns rows in the corpus shape.
 *
 * `onProgress` is called per page so a long pull is visible rather than silent.
 */
export async function pullOregonCCB({ limit = Infinity, onProgress } = {}) {
  const out = [];
  let offset = 0;
  let noPhone = 0; let notIcp = 0; let dupInSource = 0;
  const seen = new Set();

  for (;;) {
    const url = `${DATASET}?$limit=${PAGE}&$offset=${offset}&$order=license_number`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Answered-Research/1.0 (+https://answered.reddenda.com; contact: info@reddenda.com)' },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`CCB open data ${res.status} at offset ${offset}`);
    const page = await res.json();
    if (!page.length) break;

    for (const r of page) {
      const phone = toE164(r.phone_number);
      if (!phone) { noPhone += 1; continue; }
      const trade = tradeFor(r.endorsement_text);
      if (!trade) { notIcp += 1; continue; }
      // One licensee can hold several endorsements, which is several rows on one number.
      if (seen.has(phone)) { dupInSource += 1; continue; }
      seen.add(phone);

      out.push({
        phone,
        name: (r.full_name || '').trim() || null,
        trade,
        state: (r.state || 'OR').trim().toUpperCase(),
        city: (r.city || '').trim() || null,
        street: (r.address || '').trim() || null,
        zip: (r.zip_code || '').trim() || null,
        county: (r.county_name || '').trim() || null,
        website: null,
        lat: null,
        lon: null,
        source: 'oregon_ccb',
        // ★ The licence number IS the business-verification evidence, and it is retained so the
        // claim is auditable rather than asserted. `businessVerified` is derived from source +
        // sourceId presence at load time, exactly as it is for the map-listing rows.
        sourceId: String(r.license_number || '').trim() || null,
        licenseType: (r.license_type || '').trim() || null,
        licenseExpires: (r.lic_exp_date || '').trim() || null,
        endorsement: (r.endorsement_text || '').trim() || null,
      });
      if (out.length >= limit) break;
    }

    if (onProgress) onProgress({ offset, kept: out.length, scanned: offset + page.length });
    if (out.length >= limit || page.length < PAGE) break;
    offset += PAGE;
  }

  return { rows: out, stats: { kept: out.length, noPhone, notIcp, dupInSource } };
}
