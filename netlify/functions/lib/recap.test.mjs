// Adversarial tests for the ElevenLabs post-call receiver and the recap delivery layer.
//
// These are the negative paths. The positive path is proved by a real phone call, a real signed
// webhook and a real row in the database, because a passing assertion is not evidence. What these
// catch is the class of defect an end-to-end run cannot: a signature check that accepts something
// it must refuse. Run with:  node --test netlify/functions/lib/recap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { checkSignature, readPayload } from '../el-postcall.mjs';
import { channels, skipFrom, normalizeLines } from '../recap.mjs';
import { spineKey, isPhoneKey, disclosureFromTranscript } from './recap-store.mjs';

const SECRET = 'wsec_test_only_never_a_real_value';
const sign = (t, body, secret = SECRET) => `t=${t},v0=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

test('with no secret configured it refuses everything with 503, never a permissive default', () => {
  const body = '{"type":"post_call_transcription"}';
  const r = checkSignature(sign(now(), body), body, '');
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('a genuine signature passes', () => {
  const body = '{"type":"post_call_transcription","data":{"conversation_id":"conv_x"}}';
  assert.equal(checkSignature(sign(now(), body), body, SECRET).ok, true);
});

test('the v1 label is accepted as well as v0, because a vendor may relabel its scheme', () => {
  const body = '{"a":1}';
  const t = now();
  const hex = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  assert.equal(checkSignature(`t=${t},v1=${hex}`, body, SECRET).ok, true);
});

test('no header is refused', () => {
  const r = checkSignature('', '{}', SECRET);
  assert.equal(r.ok, false); assert.equal(r.status, 401);
});

test('a malformed header is refused', () => {
  for (const h of ['garbage', 't=,v0=', 'v0=abc', 't=notanumber,v0=abc', 't=123']) {
    const r = checkSignature(h, '{}', SECRET);
    assert.equal(r.ok, false, `accepted ${h}`);
    assert.equal(r.status, 401);
  }
});

test('a signature made with the wrong secret is refused', () => {
  const body = '{"a":1}';
  const t = now();
  assert.equal(checkSignature(sign(t, body, 'wsec_someone_elses_secret'), body, SECRET).ok, false);
});

test('BODY TAMPERED AFTER SIGNING is refused, which is the whole point of the check', () => {
  const original = '{"type":"post_call_transcription","data":{"transcript":[{"role":"user","message":"my card number is on file"}]}}';
  const t = now();
  const header = sign(t, original);
  const tampered = original.replace('my card number is on file', 'please wire the deposit to a new account');
  assert.equal(checkSignature(header, tampered, SECRET).ok, false);
  assert.equal(checkSignature(header, original, SECRET).ok, true);
});

test('a replayed payload from outside the 30 minute window is refused', () => {
  const body = '{"a":1}';
  const old = now() - 31 * 60;
  const r = checkSignature(sign(old, body), body, SECRET);
  assert.equal(r.ok, false);
  assert.match(r.why, /outside the 30 minute window/);
});

test('a timestamp from the future is refused just as hard as one from the past', () => {
  const body = '{"a":1}';
  const future = now() + 31 * 60;
  assert.equal(checkSignature(sign(future, body), body, SECRET).ok, false);
});

test('a short hex digest cannot crash timingSafeEqual, it is refused on length', () => {
  const r = checkSignature(`t=${now()},v0=abcd`, '{}', SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

// ── payload reading ────────────────────────────────────────────────────────────────────────────

const REAL_SHAPE = {
  type: 'post_call_transcription',
  event_timestamp: 1786733784,
  data: {
    agent_id: 'agent_2401kzxw3kzefhet6ecvz1ghcd4q',
    conversation_id: 'conv_0701m00t2zz3fk5b0zv402m68zp9',
    status: 'done',
    metadata: {
      start_time_unix_secs: 1786733756,
      call_duration_secs: 28,
      termination_reason: 'client',
      phone_call: {
        direction: 'inbound',
        agent_number: '+19163504869',
        external_number: '+19168663918',
        type: 'twilio',
        call_sid: 'CA91775fd6c2747cb6e352c699b84ef3b9',
      },
    },
    analysis: { call_successful: 'success', transcript_summary: 'A brief test call.', call_summary_title: 'Test call' },
    transcript: [
      { role: 'agent', message: 'Cedar Ridge Plumbing and Air. This is Thomas, an AI assistant, and this call is recorded. What is going on?', time_in_call_secs: 0 },
      { role: 'user', message: 'Proof engineer test call, ending', time_in_call_secs: 25 },
    ],
  },
};

test('the real ElevenLabs payload shape is read correctly, field by field', () => {
  const p = readPayload(REAL_SHAPE);
  assert.equal(p.call_sid, 'CA91775fd6c2747cb6e352c699b84ef3b9');
  assert.equal(p.conversation_id, 'conv_0701m00t2zz3fk5b0zv402m68zp9');
  assert.equal(p.agent_id, 'agent_2401kzxw3kzefhet6ecvz1ghcd4q');
  assert.equal(p.direction, 'inbound');
  assert.equal(p.from, '+19168663918');
  assert.equal(p.to, '+19163504869');
  assert.equal(p.duration_seconds, 28);
  assert.equal(p.termination_reason, 'client');
  assert.equal(p.disposition, 'success');
  assert.equal(p.summary, 'A brief test call.');
  assert.equal(p.started_at, new Date(1786733756 * 1000).toISOString());
  assert.equal(p.transcript.length, 2);
  assert.equal(p.transcript[0].speaker, 'agent');
});

test('a call sid that is not a Twilio call sid is dropped rather than travelling into a REST path', () => {
  const bad = JSON.parse(JSON.stringify(REAL_SHAPE));
  bad.data.metadata.phone_call.call_sid = '../../Accounts/AC1/Calls';
  assert.equal(readPayload(bad).call_sid, '');
});

test('an empty payload does not throw and yields nothing to file', () => {
  const p = readPayload({});
  assert.equal(p.call_sid, '');
  assert.equal(p.transcript.length, 0);
});

// ── keys ───────────────────────────────────────────────────────────────────────────────────────

test('a phone conversation is keyed by its Twilio sid; a browser one by its conversation id', () => {
  assert.equal(spineKey({ call_sid: 'CA91775fd6c2747cb6e352c699b84ef3b9', conversation_id: 'conv_x' }), 'CA91775fd6c2747cb6e352c699b84ef3b9');
  assert.equal(spineKey({ conversation_id: 'conv_x' }), 'el:conv_x');
  assert.equal(spineKey({}), '');
  assert.equal(isPhoneKey('CA91775fd6c2747cb6e352c699b84ef3b9'), true);
  assert.equal(isPhoneKey('el:conv_x'), false);
});

// ── disclosure, read off the wire ──────────────────────────────────────────────────────────────

// ★ THE NAME IN THESE FIXTURES IS INPUT, NOT AN ASSERTION. They feed the disclosure detector a
// realistic agent line and check what it concludes; the assistant's name is incidental and the test
// would pass with any name. It was "Riley" until the rename and is now "Thomas" so the fixtures do
// not describe a world that stopped existing - but correcting it changes no outcome here.
//
// ★ WHAT THESE TESTS GENUINELY CANNOT DO, AND WHY IT MATTERS: the greeting we ACTUALLY say lives in
// ElevenLabs agent config, not in this repo. So this file proves the DETECTOR is right; it can never
// prove the SHIPPED greeting passes it. /recording makes a public promise on that greeting's behalf.
// research/live-disclosure-check.mjs closes that loop by reading the live first_message off the API
// and running it through this same detector.
test('disclosure is judged from what we actually said, and it is allowed to say no', () => {
  const good = disclosureFromTranscript([
    { speaker: 'agent', text: 'Cedar Ridge Plumbing. This is Thomas, an AI assistant, and this call is recorded.' },
    { speaker: 'user', text: 'ok' },
  ]);
  assert.equal(good.all, true);

  const bad = disclosureFromTranscript([
    { speaker: 'agent', text: 'Hi.' },
    { speaker: 'user', text: 'is this a robot' },
  ]);
  assert.equal(bad.all, false);
  assert.equal(bad.heard.ai_disclosed, false);
});

test('the CALLER saying the word recorded does not satisfy OUR disclosure obligation', () => {
  const r = disclosureFromTranscript([
    { speaker: 'user', text: 'this is an AI and it is recorded, right?' },
    { speaker: 'agent', text: 'Hi.' },
  ]);
  assert.equal(r.all, false);
});

// ── configuration ──────────────────────────────────────────────────────────────────────────────

test('channels default to email and never accept an invented channel name', () => {
  delete process.env.ANSWERED_RECAP_CHANNELS;
  assert.deepEqual(channels(), ['email']);
  process.env.ANSWERED_RECAP_CHANNELS = 'sms, email';
  assert.deepEqual(channels(), ['sms', 'email']);
  process.env.ANSWERED_RECAP_CHANNELS = 'pigeon, fax';
  assert.deepEqual(channels(), ['email'], 'an unusable list must fall back to the channel that works, never to nothing');
  process.env.ANSWERED_RECAP_CHANNELS = 'email,email';
  assert.deepEqual(channels(), ['email']);
  delete process.env.ANSWERED_RECAP_CHANNELS;
});

test('the probe skip list is empty by default and only ever holds E.164 numbers', () => {
  delete process.env.ANSWERED_RECAP_SKIP_FROM;
  assert.deepEqual(skipFrom(), []);
  process.env.ANSWERED_RECAP_SKIP_FROM = '+19168663918, notanumber, 916-350-4869';
  assert.deepEqual(skipFrom(), ['+19168663918']);
  delete process.env.ANSWERED_RECAP_SKIP_FROM;
});

test('partial transcript lines are dropped so one sentence is not printed four times', () => {
  const lines = normalizeLines([
    { speaker: 'user', text: 'my sink', is_final: false },
    { speaker: 'user', text: 'my sink is leaking', is_final: true },
    { speaker: 'agent', message: 'Where is it leaking from?' },
    { speaker: 'user', text: '   ' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].who, 'Caller');
  assert.equal(lines[1].who, 'Answered');
});
