// /api/account-voice : the inbound webhook a CUSTOMER's number points at.
//
// This is the whole point of the accounts lane. The demo line at /api/answered-voice bridges every
// caller to one agent with one hardcoded persona. This one asks the database who owns the number
// that was dialled, renders that business's rules into instructions, and hands them to the agent
// for this call only. One agent, many businesses, rules that change on the next ring with nothing
// to redeploy.
//
// ★ THE REFUSAL THAT MATTERS: if the dialled number resolves to nothing, this hangs up politely
// and says so. It does NOT fall back to a default persona. An agent that answers as SOMEBODY when
// it does not know who it is answering as would put our voice on a stranger's line under a name
// we made up, which is the exact failure the honesty law exists to prevent.
//
// The demo line is untouched by this file. Nothing here imports it and nothing here changes it.
//
// Env, by NAME only, all fail closed:
//   TWILIO_ACCOUNT_SID          cross-checked against the posted AccountSid
//   TWILIO_AUTH_TOKEN           signature validation key (see lib/twilio-webhook.mjs on its absence)
//   ELEVENLABS_API_KEY          subscription gate plus register-call
//   ANSWERED_CUSTOMER_AGENT_ID  the shared agent that customer lines bridge to, with per-call
//                               prompt overrides. Deliberately NOT the demo agent: the demo agent
//                               carries the Riley persona, and a customer's caller must never hear
//                               it if an override is ever dropped.
//   ANSWERED_DB_*               the account spine

import { accountForNumber, renderSpec, renderGreeting, dbConfigured } from './lib/accounts.mjs';
import { validSignature, parseForm, esc } from './lib/twilio-webhook.mjs';

const PUBLIC_PATH = '/api/account-voice';

const xml = (body) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
  status: 200,
  headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
});

const sayAndHang = (text) =>
  xml(`<Response><Say voice="Polly.Matthew-Neural">${esc(text)}</Say><Hangup/></Response>`);

const UNKNOWN_NUMBER =
  'This number is not set up to answer calls yet. Nobody is on the line. Please try the business another way.';

const CANNOT_ANSWER = (says) =>
  `Thanks for calling ${says}. The assistant on this line cannot pick up right now, so nothing is being recorded and nobody is taking a message. Please try again shortly.`;

/** Netlify v2 gives a Request. lib/twilio-webhook.mjs measures signatures against a v1 event. */
function toEvent(req, rawBody) {
  const headers = {};
  for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
  const u = new URL(req.url);
  return { headers, body: rawBody, isBase64Encoded: false, rawUrl: req.url, rawQuery: u.search.replace(/^\?/, '') };
}

async function elHealthy(key) {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.status === 'past_due') return false;
    if (typeof j.character_count === 'number' && typeof j.character_limit === 'number'
        && j.character_count >= j.character_limit) return false;
    return true;
  } catch { return false; }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  const raw = await req.text();
  const p = parseForm(raw, false);

  if (!validSignature(toEvent(req, raw), p, PUBLIC_PATH)) {
    return new Response('invalid signature', { status: 403 });
  }
  const ACC = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  if (!ACC) {
    console.error('account-voice DOWN: TWILIO_ACCOUNT_SID not set; refusing.');
    return new Response('not configured', { status: 403 });
  }
  if (p.AccountSid !== ACC) return new Response('wrong account', { status: 403 });

  const to = String(p.To || '').trim();
  if (!dbConfigured()) {
    console.error('account-voice: account database not configured; cannot resolve a line.');
    return sayAndHang(UNKNOWN_NUMBER);
  }

  let account = null;
  try {
    account = await accountForNumber(to);
  } catch (e) {
    console.error(`account-voice: resolve failed for ${to}: ${String(e.message).slice(0, 160)}`);
    return sayAndHang(UNKNOWN_NUMBER);
  }

  // No owner, no voice. There is no default business here on purpose.
  if (!account) {
    console.error(`account-voice: no live account owns ${to}; hanging up honestly.`);
    return sayAndHang(UNKNOWN_NUMBER);
  }

  const says = (account.config && account.config.business_says) || account.business_name;
  const spec = renderSpec(account);
  const greeting = renderGreeting(account);
  if (!spec || !greeting) {
    console.error(`account-voice: ${account.id} is live with rules that will not render; refusing to improvise.`);
    return sayAndHang(CANNOT_ANSWER(says));
  }

  const ELKEY = (process.env.ELEVENLABS_API_KEY || '').trim();
  const AGENT = (process.env.ANSWERED_CUSTOMER_AGENT_ID || '').trim();
  if (!ELKEY || !AGENT) {
    console.error(`account-voice: ${!ELKEY ? 'ELEVENLABS_API_KEY' : 'ANSWERED_CUSTOMER_AGENT_ID'} not set; serving the honest fallback.`);
    return sayAndHang(CANNOT_ANSWER(says));
  }
  if (!(await elHealthy(ELKEY))) {
    console.error('account-voice: ElevenLabs account unhealthy or unreachable; serving the honest fallback.');
    return sayAndHang(CANNOT_ANSWER(says));
  }

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: { 'xi-api-key': ELKEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        agent_id: AGENT,
        from_number: p.From || '',
        to_number: to,
        direction: 'inbound',
        // The per-call identity. Everything here is rendered from stored fields; nothing is
        // invented at call time, so the console can print the same text an owner's line is using.
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: { prompt: { prompt: spec }, first_message: greeting, language: 'en' },
          },
          dynamic_variables: {
            account_id: account.id,
            business_name: account.business_name,
            business_says: says,
            config_version: String((account.config && account.config.version) || 1),
          },
        },
      }),
    });
    const twiml = await r.text();
    if (!r.ok || !/</.test(twiml)) throw new Error(`register-call ${r.status} ${twiml.slice(0, 160)}`);
    return xml(twiml.replace(/^<\?xml[^>]*\?>/, ''));
  } catch (e) {
    console.error(`account-voice bridge failed for ${account.id}: ${String((e && e.message) || e).slice(0, 200)}`);
    return sayAndHang(CANNOT_ANSWER(says));
  }
};

export const config = { path: '/api/account-voice' };
