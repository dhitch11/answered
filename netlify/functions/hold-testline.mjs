// hold-testline.mjs — a queue you are allowed to call.
//
// ★ THIS IS A MEASUREMENT RIG, NOT A PRODUCT SURFACE, AND IT IS NOT WIRED TO ANY NUMBER.
// It exists because the detector in lib/hold-detect.mjs makes a claim ("this is what a hold
// sounds like and this is what a person sounds like") and the only honest way to check a claim
// like that is to call something that behaves exactly like a government queue and see what the
// detector does. Testing it against a real agency line would mean tying up a public servant to
// find out whether our regex works, which is not a thing we get to do.
//
// It answers like the real thing, in the real order, with the real vocabulary:
//   1. a greeting and a menu, and it waits for a keypress
//   2. an acknowledgement, then a queue announcement
//   3. silence, for as long as you asked for, which is what hold music transcribes to
//   4. a person, opening the way people actually open: "thanks for holding, this is..."
//   5. and it answers back when spoken to, so the confirmation step has something to confirm
//
// HOW TO POINT A NUMBER AT IT, WHEN YOU WANT TO RUN A REAL SESSION:
//   Set the Voice webhook of a Twilio number WE OWN to
//       https://answered.reddenda.com/api/hold/testline
//   Record whatever the number's Voice URL was first, and put it back afterwards. Never point a
//   customer line at this, and never leave it pointed here.
//
// KNOBS, all on the query string, so one number can play every shape of line:
//   ?menu=1        offer a phone tree first          (default 1)
//   ?hold=45       seconds of silent queue           (default 45)
//   ?human=1       a person eventually picks up      (default 1)
//   ?voicemail=1   answer as a voicemail box instead
//   ?closed=1      answer as an out-of-hours message
//
// The behaviour is DECLARED IN THE URL and nothing here is random, because a rig whose output
// changes between runs cannot tell you whether your detector improved.

import { authenticate, esc } from './lib/twilio-webhook.mjs';
import * as rt from './lib/hold-runtime.mjs';

const SAY = (t) => `<Say voice="Polly.Joanna-Neural">${esc(t)}</Say>`;
const AGENT = (t) => `<Say voice="Polly.Matthew-Neural">${esc(t)}</Say>`;
const XML = rt.XML;

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const self = (q, step) => {
  const p = new URLSearchParams(q);
  p.set('step', step);
  return esc(`${rt.site()}/api/hold/testline?${p.toString()}`);
};

export default async (req) => {
  const url = new URL(req.url);
  const event = await rt.asLambda(req);
  const gate = authenticate(event, '/api/hold/testline');
  if (!gate.ok) return new Response(gate.reject.body || 'refused', { status: gate.reject.statusCode });

  const p = gate.params;
  const q = Object.fromEntries(url.searchParams.entries());
  const step = String(q.step || 'greeting');
  const holdSeconds = num(q.hold, 45, 0, 1800);
  const wantsMenu = q.menu !== '0';
  const wantsHuman = q.human !== '0';

  if (q.voicemail === '1') {
    return XML(`<Response>${SAY('You have reached the claims office. Nobody is available to take your call right now. Please leave a message after the tone.')}<Pause length="2"/><Hangup/></Response>`);
  }
  if (q.closed === '1') {
    return XML(`<Response>${SAY('Thank you for calling. Our offices are now closed. Please call back during normal business hours, Monday through Friday, eight to five.')}<Hangup/></Response>`);
  }

  // 1. the greeting and the tree
  if (step === 'greeting') {
    if (!wantsMenu) return XML(`<Response>${SAY('Thank you for calling. Please hold for the next available representative.')}<Redirect method="POST">${self(q, 'queue')}</Redirect></Response>`);
    return XML(
      `<Response><Gather input="dtmf" numDigits="1" timeout="15" actionOnEmptyResult="true" method="POST" action="${self(q, 'chose')}">`
      + SAY('Thank you for calling the Department of Family Benefits. Please listen carefully as our menu options have changed. '
        + 'For a new claim, press one. For an existing claim, press two. To speak with billing, press three. '
        + 'To repeat these options, press nine.')
      + `</Gather><Redirect method="POST">${self(q, 'chose')}</Redirect></Response>`,
    );
  }

  // 2. what they pressed, then the queue
  if (step === 'chose') {
    const d = String(p.Digits || '').trim();
    if (d === '9') return XML(`<Response><Redirect method="POST">${self(q, 'greeting')}</Redirect></Response>`);
    const said = d
      ? `Thank you. You pressed ${d}. One moment while I connect you to that department.`
      : 'I did not get that. Let me put you through to the general queue.';
    return XML(`<Response>${SAY(said)}<Redirect method="POST">${self({ ...q, pressed: d || 'none' }, 'queue')}</Redirect></Response>`);
  }

  // 3. the queue, and then the silence that is the whole point of the rig
  if (step === 'queue') {
    return XML(
      `<Response>`
      + SAY('All of our representatives are currently assisting other callers. Your call is important to us. '
        + 'Please stay on the line and your call will be answered in the order it was received.')
      + `<Pause length="${holdSeconds}"/>`
      + `<Redirect method="POST">${self(q, wantsHuman ? 'human' : 'still')}</Redirect>`
      + `</Response>`,
    );
  }

  // A queue that never produces anybody, so the no-human path has something to end on.
  if (step === 'still') {
    return XML(
      `<Response>${SAY('Thank you for your patience. All of our representatives are still busy.')}`
      + `<Pause length="${holdSeconds}"/><Redirect method="POST">${self(q, 'still')}</Redirect></Response>`,
    );
  }

  // 4. a person, opening the way people actually open
  if (step === 'human') {
    return XML(
      `<Response><Gather input="speech" speechTimeout="auto" timeout="12" actionOnEmptyResult="true" method="POST" language="en-US" action="${self(q, 'talking')}">`
      + AGENT('Thanks for holding, this is Denise in claims. How can I help you?')
      + `</Gather><Redirect method="POST">${self(q, 'talking')}</Redirect></Response>`,
    );
  }

  // 5. and it answers back, so the confirmation step is confirming something real
  if (step === 'talking') {
    const heard = String(p.SpeechResult || '').trim();
    return XML(
      `<Response><Gather input="speech" speechTimeout="auto" timeout="20" actionOnEmptyResult="true" method="POST" language="en-US" action="${self(q, 'talking')}">`
      + AGENT(heard ? 'Okay, I hear you. Go ahead, I have the file open.' : 'Hello? Are you still there? Go ahead.')
      + `</Gather><Hangup/></Response>`,
    );
  }

  return XML(`<Response>${SAY('Goodbye.')}<Hangup/></Response>`);
};

export const config = { path: ['/api/hold/testline'] };
