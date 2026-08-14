// twilio.mjs — the thinnest possible Twilio client, on API-key auth.
//
// Credentials are read from the environment and never written anywhere. Run any script in this
// module through `research/with-env.sh`, which pulls the values from the Netlify project at run
// time and passes them in as environment variables for the life of one process. No key is ever
// pasted into a file, a log, or a commit.

const BASE = 'https://api.twilio.com/2010-04-01';
const LOOKUP = 'https://lookups.twilio.com/v2';

function creds() {
  const sid = process.env.TWILIO_API_SID;
  const secret = process.env.TWILIO_API_SECRET;
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !secret || !account) {
    throw new Error(
      'Missing TWILIO_API_SID / TWILIO_API_SECRET / TWILIO_ACCOUNT_SID.\n'
      + 'Run this through research/with-env.sh so the values come from the Netlify project.',
    );
  }
  return { account, auth: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}` };
}

async function call(url, init = {}) {
  const { auth } = creds();
  const res = await fetch(url, { ...init, headers: { Authorization: auth, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status}: ${body.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.code = body.code;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Line Type Intelligence. Returns { phone, lookupOk, lineType, carrier, valid, error }.
 * A failure is returned, never thrown, because an unclassifiable number is a real and expected
 * result that the gate must see rather than a crash that ends the sweep.
 */
export async function lineType(phone) {
  try {
    const body = await call(`${LOOKUP}/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`);
    const lti = body.line_type_intelligence || {};
    return {
      phone,
      lookupOk: !lti.error_code,
      valid: body.valid !== false,
      lineType: lti.type || null,
      carrier: lti.carrier_name || null,
      mobileCountryCode: lti.mobile_country_code || null,
      errorCode: lti.error_code || null,
    };
  } catch (e) {
    return { phone, lookupOk: false, valid: null, lineType: null, carrier: null, error: e.message, status: e.status };
  }
}

/** Place a call. Returns the Twilio call resource. */
export async function placeCall({ to, from, twiml, url, statusCallback, machineDetection = 'DetectMessageEnd', timeout = 30, record = false }) {
  const { account } = creds();
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);
  if (twiml) form.set('Twiml', twiml);
  if (url) form.set('Url', url);
  form.set('Timeout', String(timeout));
  form.set('MachineDetection', machineDetection);
  form.set('AsyncAmd', 'false');
  if (record) form.set('Record', 'true');
  if (statusCallback) {
    form.set('StatusCallback', statusCallback);
    form.set('StatusCallbackEvent', 'initiated');
    form.append('StatusCallbackEvent', 'ringing');
    form.append('StatusCallbackEvent', 'answered');
    form.append('StatusCallbackEvent', 'completed');
  }
  return call(`${BASE}/Accounts/${account}/Calls.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
}

export async function getCall(sid) {
  const { account } = creds();
  return call(`${BASE}/Accounts/${account}/Calls/${sid}.json`);
}

/** Search for a number to buy. areaCode optional. */
export async function availableNumbers({ areaCode, limit = 5 }) {
  const { account } = creds();
  const q = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: String(limit) });
  if (areaCode) q.set('AreaCode', String(areaCode));
  const body = await call(`${BASE}/Accounts/${account}/AvailablePhoneNumbers/US/Local.json?${q}`);
  return body.available_phone_numbers || [];
}

export async function buyNumber({ phoneNumber, friendlyName, voiceUrl }) {
  const { account } = creds();
  const form = new URLSearchParams({ PhoneNumber: phoneNumber });
  if (friendlyName) form.set('FriendlyName', friendlyName);
  if (voiceUrl) form.set('VoiceUrl', voiceUrl);
  return call(`${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
}

export async function ownedNumbers() {
  const { account } = creds();
  const body = await call(`${BASE}/Accounts/${account}/IncomingPhoneNumbers.json?PageSize=100`);
  return body.incoming_phone_numbers || [];
}

export async function accountBalance() {
  const { account } = creds();
  return call(`${BASE}/Accounts/${account}/Balance.json`);
}
