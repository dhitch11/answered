#!/usr/bin/env node
// twiml.test.mjs — assert the SHAPE of what the line says, not just that a script exists.
//
//   node research/twiml.test.mjs
//
// This file exists because of one measured incident. On the first real end-to-end call the AI
// disclosure and the recording notice were never spoken: they were nested inside a <Gather>, and
// a nested <Say> is cut off the moment the other party makes a sound. The callee answered with
// their company name, barged over it, and our entire spoken output was the word "Hi."
//
// Every check that existed at the time passed. The script file contained the disclosure. The
// obligations list was complete. The gate attached all four obligations. scriptSatisfies()
// returned ok. A grep for the disclosure text found it. The only thing that would have caught it
// is an assertion about WHERE in the document the words sit, which is what this file is.

import assert from 'node:assert/strict';
import { SCRIPTS, opening, isStop, askedIfAI } from '../netlify/functions/lib/scripts.mjs';

let pass = 0; let fail = 0;
const test = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

process.env.ANSWERED_DEMO_NUMBER = process.env.ANSWERED_DEMO_NUMBER || '+19163504869';

/** Rebuild the documents the way call-voice.mjs does, without needing a live Twilio request. */
function buildMeasure() {
  const s = SCRIPTS.measure;
  return `<Response><Start><Transcription/></Start><Say>${s.disclosure()}</Say>`
    + `<Gather input="speech"><Say>${s.ask()}</Say></Gather></Response>`;
}
function buildDiscovery() {
  const s = SCRIPTS.discovery;
  return `<Response><Start><Transcription/></Start><Say>${s.disclosure()}</Say>`
    + `<Gather input="speech"><Say>${s.ask()}</Say></Gather></Response>`;
}

/** Everything spoken before the first <Gather> opens. That is the uninterruptible region. */
function uninterruptible(twiml) {
  const g = twiml.indexOf('<Gather');
  const head = g === -1 ? twiml : twiml.slice(0, g);
  return [...head.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1]).join(' ');
}

console.log('\nTHE DISCLOSURE IS UNINTERRUPTIBLE');
for (const [name, build] of [['measure', buildMeasure], ['discovery', buildDiscovery]]) {
  const twiml = build();
  const safe = uninterruptible(twiml);

  test(`${name}: identifies who is calling before any <Gather>`, () => {
    assert.match(safe, /this is Answered/i, '47 CFR 64.1200(b)(1)');
  });
  test(`${name}: discloses the AI before any <Gather>`, () => {
    assert.match(safe, /\bA ?I\b/, 'Cal. AB 2905 / FCC 24-17');
  });
  test(`${name}: announces recording before any <Gather>`, () => {
    assert.match(safe, /recorded/i);
  });
  test(`${name}: gives a callback number before any <Gather>`, () => {
    assert.match(safe, /\d\s\d\s\d/, '47 CFR 64.1200(b)(2): spoken digits');
  });
  test(`${name}: the disclosure is NOT inside a <Gather>`, () => {
    const inside = [...twiml.matchAll(/<Gather[^>]*>([\s\S]*?)<\/Gather>/g)].map((m) => m[1]).join(' ');
    assert.doesNotMatch(inside, /this is Answered/i,
      'the disclosure is nested in a <Gather> and will be cut off the moment the callee speaks');
    assert.doesNotMatch(inside, /recorded/i,
      'the recording notice is nested in a <Gather> and will be cut off the moment the callee speaks');
  });
  test(`${name}: something is said before the <Gather> at all`, () => {
    assert.ok(safe.trim().length > 40, 'nothing uninterruptible is spoken');
  });
}

console.log('\nSCRIPT SHAPE');
test('every dialable script exposes a disclosure and an ask', () => {
  for (const key of ['measure', 'discovery', 'conference']) {
    assert.equal(typeof SCRIPTS[key].disclosure, 'function', `${key} has no disclosure()`);
    assert.equal(typeof SCRIPTS[key].ask, 'function', `${key} has no ask()`);
  }
});
test('no script still exposes the old combined open()', () => {
  for (const [key, s] of Object.entries(SCRIPTS)) {
    assert.equal(s.open, undefined, `${key} still has open(); a caller may use it and lose the disclosure`);
  }
});
test('the voicemail message carries the disclosure too', () => {
  const v = SCRIPTS.voicemail.text();
  assert.match(v, /this is Answered/i);
  assert.match(v, /\bA ?I\b/);
  assert.match(v, /recorded/i);
});
test('the callback number is spoken as digits, not as a quantity', () => {
  assert.match(opening(), /\d\s\d\s\d/);
  assert.doesNotMatch(opening(), /9163504869/);
});

console.log('\nSTOP DETECTION');
for (const phrase of [
  'stop calling me', 'stop', 'stop it', 'please stop', 'quit calling', 'take me off your list',
  'how did you get my number', 'no more calls', 'please remove me', 'do not call this number again',
  "don't call here", 'not interested', 'no thanks', 'lose my number', 'leave me alone',
  "I'm going to call my lawyer",
]) {
  test(`heard as stop: "${phrase}"`, () => assert.equal(isStop(phrase), true));
}
// The discovery question invites exactly these sentences. Suppressing on them would destroy the
// data we rang to collect and permanently block a prospect for answering the question.
for (const phrase of [
  'we stop taking calls at six', 'I can never get them to answer', 'yeah that happens a lot',
  'sure, go ahead', 'it goes to voicemail and I call them back', 'my wife stops answering after dinner',
  'we never stop, we run twenty four seven', 'the phone stops ringing about eight',
]) {
  test(`NOT a stop: "${phrase}"`, () => assert.equal(isStop(phrase), false));
}

console.log('\nDIRECT QUESTION ABOUT WHAT THEY ARE TALKING TO');
for (const phrase of ['are you a robot', 'is this a recording', 'am I talking to a real person', 'are you an AI']) {
  test(`answered honestly: "${phrase}"`, () => assert.equal(askedIfAI(phrase), true));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
