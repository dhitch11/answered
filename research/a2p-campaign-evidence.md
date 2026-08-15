# A2P 10DLC campaign evidence — Answered

Prepared 2026-08-15 by @ANSWERED-INTEL for @LANE-SEARCHLIGHT to paste into the campaign filing.

**Every URL below was fetched from live production and every claim was read out of running code.
Nothing here is aspirational.** Where the program is not yet doing something, it says so, because a
reviewer who catches one overstatement re-reads everything else.

---

## 1. The registered sending number

**`+1 (916) 282-5278`**

Pinned as `A2P_REGISTERED_E164` in `_build.py`. The site build now **stops** if its environment
disagrees with that literal, so the page cannot silently publish a different number than the
campaign registers. That mismatch is the documented cause of the three previous rejections
(error 30909), and it is now a build failure rather than a one-line diff among asset stamps.

**Verified across the whole evidence set: exactly one phone number appears anywhere in it.**
`/terms` and `/privacy` publish none at all.

---

## 2. Use case: transactional / customer care. Never marketing.

Answered is an AI phone line for trade contractors. Every message in this program is the direct,
requested consequence of something the recipient did: a call they placed, a job they booked, an
invoice they discussed on a recorded call. **There is no promotional traffic, no newsletter, no
drip sequence, and no list.**

---

## 3. Message flow (the `message_flow` field)

> A person opts in one of two ways, both of which require an action from them.
>
> **On the website:** at https://answered.reddenda.com/pricing they type their mobile number into
> the contact form. Directly beside that field, before they submit, the page prints: *"Adding your
> number opts you into Answered texts from (916) 282-5278: the transcript, booking link, or receipt
> you asked for. Fewer than five a month, and it varies by what you ask for. Message and data rates
> may apply. Reply STOP to stop, HELP for help."* with links to the Terms and Privacy pages. The
> page is publicly reachable with no login and no paywall.
>
> **On a call they placed to us:** the caller asks for the transcript, the booking link or the
> receipt to be texted to them, and the request is recorded on the call.
>
> There is no third way in. We never add a number ourselves, we never buy or import a list, and
> consent is never transferred between numbers or programs. Every message is the direct result of
> something that person asked for.

---

## 4. Opt-in evidence URL (for 30909)

**https://answered.reddenda.com/pricing**

Publicly reachable, no login. Carries, in this order, beside the phone field:

| Required element | Present as |
|---|---|
| Program and sender identified | "Answered texts from (916) 282-5278" |
| What the messages are | "the transcript, booking link, or receipt you asked for" |
| Message frequency | "Fewer than five a month, and it varies by what you ask for" |
| Cost disclosure | "Message and data rates may apply" |
| Opt-out instruction | "Reply STOP to stop" |
| Help instruction | "HELP for help" |
| Terms link | present |
| Privacy link | present |

The frequency line states a **specific ceiling** rather than the boilerplate "message frequency
varies", which is a stronger disclosure, not a weaker one.

---

## 5. Privacy policy URL (for 30908)

**https://answered.reddenda.com/privacy**

Contains, verbatim:

> *"We never share your mobile phone number, or the fact that you opted in to texting, with anyone
> else, and we never sell either one. Not to third parties, not to affiliates, not for their
> marketing, not for their promotions. Not for any price."*

That covers the number, **the consent data itself**, third parties, affiliates, marketing and
promotional purposes. The page was searched specifically for the contradicting pattern Twilio
publishes as its rejected example ("we may share your personal information with third-party
partners for marketing purposes"). **It does not appear anywhere on the page, and there is no
second conflicting policy elsewhere on the site.**

---

## 6. Terms URL (for 30882)

**https://answered.reddenda.com/terms**

A section headed *"What you agree to when you ask us to text you"*, specific to this program and
this brand, covering: what the program is, how you join, how often, what it costs, how you leave,
that the number is never shared or sold, and carrier non-liability. It contains no language about
sharing, selling or buying consumer data or opt-in information.

The page states plainly that **carrier registration is in progress and no message has ever been
sent under this program.** That is true, it is the compliant order of operations, and it is written
so that it stays true after approval rather than needing to be swapped at filing time.

---

## 7. Sample messages

All transactional. All the direct result of a request. `{}` marks a substituted value.

**1. Booking confirmation, to the caller who booked**
> Answered here. You are booked with {Business} for {Day} between {Window}. Address {Address}. Reply
> STOP to stop these texts, HELP for help.

**2. Call transcript, to the business owner who asked for it**
> Answered: your line took a call from {Caller} at {Time}. {Outcome}. Full transcript: {Link}.
> Reply STOP to stop these texts, HELP for help.

**3. Receipt for a billed outcome, to the account holder**
> Answered: {Outcome} on {Date}, {Amount}. The recording and the line-by-line reason are on your
> statement: {Link}. Reply STOP to stop these texts, HELP for help.

**4. Invoice follow-up, only to a debtor who agreed to it on a recorded call**
> {Business} here via Answered, following up on invoice {Ref} for {Amount} as agreed on our call.
> Pay or dispute: {Link}. Reply STOP to stop these texts, HELP for help.

**Every sample carries the opt-out in the message body**, and none contains an offer, a discount, a
promotion or a call to action to buy anything.

---

## 8. Opt-out handling, as implemented

Not described. Implemented, in `netlify/functions/call-me.mjs`:

- A stop is written to permanent suppression keyed by a hash of the number, **before** anything
  else in the request is processed.
- Suppression is checked as **gate 4 of 10** on every future contact attempt, ahead of any vendor
  call, so a suppressed number cannot be reached even by a later code path that forgets to ask.
- It is **permanent**, not a pause and not a reduction. It clears only if that person asks for it
  back themselves.
- The same store backs the voice path, so a stop given **through the website or on a call** also
  stops calls. **A stop given by TEXT is not yet captured here** — see the table below, and the
  build requirement it names. Consent withdrawal must be per person rather than per channel, and
  today that holds for every channel except inbound text, because inbound text does not exist yet.

### ★ Where each part of the opt-out actually lives, stated precisely

**I wrote a false sentence here on the first pass and caught it before handing this over.** It said
our code honors STOP, STOPALL, UNSUBSCRIBE, OPTOUT, CANCEL, END and QUIT. **It does not, because
there is no inbound SMS webhook in this codebase at all** — no message has ever been received, so
nothing was ever built to receive one. Filing that sentence would have been an overstatement a
reviewer could disprove in one test, and it would have put every other claim here in doubt.

What is true, split by who does what:

| Layer | Handles | State |
|---|---|---|
| **Twilio Advanced Opt-Out**, on the Messaging Service | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, and HELP | Platform default. **@LANE-SEARCHLIGHT must confirm it is enabled on the service before filing** — it is a checkbox, and asserting it without looking is the same mistake in a different place. |
| **Our own suppression store** | a stop recorded from the website or from a call | Live now. Permanent, written before anything else in the request, checked as gate 4 of 10. |

**BUILD REQUIREMENT WHEN TEXTING GOES LIVE, and it is not optional:** an inbound message webhook of
ours must write a carrier-level STOP into the same suppression store. Until that exists, a person
who texts STOP is opted out at the carrier for messaging but would still be reachable by our voice
path, because the two would be recorded in different places. **Consent withdrawal must be per
person, not per channel**, and today that is only true for a stop given through the website.

---

## 9. What this program does NOT do

Stated because a reviewer trusts a filing that draws its own boundaries:

- No marketing, promotional or sales messages of any kind.
- No purchased, rented, imported or scraped lists. Ever.
- No consent shared between numbers, programs, brands or affiliates.
- No message to anyone who has not personally asked for that specific thing.
- No message sent before this registration completes.

---

## 10. Open, and honest

- **The secondary customer profile for TwinFlame Investments LLC is console-only.** Twilio refuses
  it over the API. It is the one remaining human step and it gates the brand, not the evidence.
- **No inbound SMS webhook exists yet**, so carrier-level STOP is handled by Twilio and is not yet
  mirrored into our own suppression store. Named in section 8 as a build requirement rather than
  left for a reviewer to discover.
- **Twilio Lookup was returning 401 on production earlier tonight.** It does not touch the brand or
  campaign filing path, but no readiness signal on this estate should be trusted if it probes the
  account rather than the capability in question.
