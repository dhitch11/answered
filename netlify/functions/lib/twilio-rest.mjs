// twilio-rest.mjs — Twilio REST for the functions runtime. API-key auth, no SDK dependency.

const BASE = 'https://api.twilio.com/2010-04-01';
const LOOKUP = 'https://lookups.twilio.com/v2';

function auth() {
  const sid = process.env.TWILIO_API_SID;
  const secret = process.env.TWILIO_API_SECRET;
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !secret || !account) throw new Error('twilio credentials not configured');
  return { account, header: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}` };
}

async function req(url, init = {}) {
  const { header } = auth();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: header, ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeoutMs || 10000),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const e = new Error(`twilio ${res.status}: ${body.message || text.slice(0, 200)}`);
    e.status = res.status; e.code = body.code; throw e;
  }
  return body;
}

const form = (obj) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => f.append(k, String(x)));
    else f.set(k, String(v));
  }
  return f;
};

export async function createCall(params) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Calls.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
}

export async function updateCall(sid, params) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Calls/${sid}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
}

export async function getCall(sid) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Calls/${sid}.json`);
}

/** Add a participant to a conference. This is how monitor, whisper and barge all work. */
export async function addParticipant(conferenceName, params) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Conferences/${encodeURIComponent(conferenceName)}/Participants.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
}

export async function updateParticipant(conferenceName, callSid, params) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Conferences/${encodeURIComponent(conferenceName)}/Participants/${callSid}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
}

export async function listConferences(status = 'in-progress') {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Conferences.json?Status=${status}&PageSize=50`);
}

export async function sendMessage(params) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/Messages.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
}

export async function lineType(phone) {
  try {
    const body = await req(`${LOOKUP}/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`);
    const lti = body.line_type_intelligence || {};
    return {
      phone, lookupOk: !lti.error_code, valid: body.valid !== false,
      lineType: lti.type || null, carrier: lti.carrier_name || null,
    };
  } catch (e) {
    return { phone, lookupOk: false, valid: null, lineType: null, carrier: null, error: e.message };
  }
}

export async function availableNumbers({ areaCode, contains, limit = 10 }) {
  const { account } = auth();
  const q = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: String(limit) });
  if (areaCode) q.set('AreaCode', String(areaCode));
  if (contains) q.set('Contains', String(contains));
  const body = await req(`${BASE}/Accounts/${account}/AvailablePhoneNumbers/US/Local.json?${q}`);
  return body.available_phone_numbers || [];
}

export async function buyNumber({ phoneNumber, friendlyName, voiceUrl, statusCallback }) {
  const { account } = auth();
  return req(`${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ PhoneNumber: phoneNumber, FriendlyName: friendlyName, VoiceUrl: voiceUrl, StatusCallback: statusCallback }),
  });
}

export async function releaseNumber(sid) {
  const { account } = auth();
  const { header } = auth();
  const res = await fetch(`${BASE}/Accounts/${account}/IncomingPhoneNumbers/${sid}.json`, {
    method: 'DELETE', headers: { Authorization: header },
  });
  if (!res.ok && res.status !== 204) throw new Error(`twilio release ${res.status}`);
  return { released: true };
}

export async function ownedNumbers() {
  const { account } = auth();
  const body = await req(`${BASE}/Accounts/${account}/IncomingPhoneNumbers.json?PageSize=200`);
  return body.incoming_phone_numbers || [];
}

export async function recordingUrl(sid) {
  const { account } = auth();
  return `${BASE}/Accounts/${account}/Recordings/${sid}.mp3`;
}

/** A short-lived signed URL for a recording, so the cockpit can play it without leaking creds. */
export async function fetchRecording(sid) {
  const { account, header } = auth();
  const res = await fetch(`${BASE}/Accounts/${account}/Recordings/${sid}.mp3`, { headers: { Authorization: header } });
  if (!res.ok) throw new Error(`recording ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
