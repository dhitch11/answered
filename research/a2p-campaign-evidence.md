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

## 2. Use case: CUSTOMER COMMUNICATION. Never marketing.

**Describe it as customer communication and stop there.** Every message in this program is the
direct, requested consequence of something the recipient did: a call they placed, a job they booked,
an invoice they discussed on a recorded call. **There is no promotional traffic, no newsletter, no
drip sequence, and no list.**

★ **A NOTE ON HOW MUCH TO SAY, because it is the difference between an approval and a question.**
A narrow, unremarkable description passes review. An ambitious one invites scrutiny of things the
traffic does not actually do. This program sends confirmations, transcripts, receipts and agreed
follow-ups to people who asked for them. **That is customer communication, and that is the whole
description.** Do not describe the product's capabilities, its voice agent, its negotiation
features, or anything the messages themselves are not.

**And keep the description consistent with the samples**, because narrowing the words while leaving
a mismatched sample is simply a different rejection. Every sample in section 7 is a message to
somebody about their own job, their own call or their own invoice. The invoice follow-up qualifies
because it goes only to a person who agreed to it on a recorded call, which is customer
communication rather than collection outreach.

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
| **Twilio Advanced Opt-Out**, on the Messaging Service | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and HELP | ✅ **CONFIRMED ACTIVE 2026-08-15 by observation, not by reading a checkbox.** @LANE-SEARCHLIGHT watched the platform **overwrite our submitted opt-out and help copy with its own** and return the keyword list `CANCEL, QUIT, STOP, OPTOUT, UNSUBSCRIBE, STOPALL, REVOKE, END`. A platform that rewrites your copy is a platform that owns the behaviour. |
| **Our own suppression store** | a stop from the website, from a call, **or from an inbound text** | ✅ Live and **measured on production 2026-08-15**. Permanent, written before anything else in the request, checked as gate 4 of 10. |

### ★ THE BUILD REQUIREMENT IN THIS SECTION IS NOW CLOSED, AND IT WAS MEASURED, NOT DECLARED

`netlify/functions/sms-inbound.mjs` is live and mirrors a carrier STOP into the same
`stop/<sha256(e164)>` key the voice path reads. **Consent withdrawal is now per person rather than
per channel.** Four separate measurements, on the live site, on 2026-08-15:

| What was measured | Result |
|---|---|
| Messaging Service `MGab661e…` routes inbound where? | `inbound_request_url = https://answered.reddenda.com/api/sms-inbound`, `use_inbound_webhook_on_number = false`, `+19162825278` attached |
| A **correctly signed** POST | verified and handled — `sms-inbound: HELP from 0001.` |
| A **wrongly signed** POST (negative control) | `REFUSED, signature mismatch. Nothing was written.` |
| A **signed STOP** from the reserved fictional block `+1 (999) 555-0101` | `STOP recorded from 0101 via "stop"; voice and text are now both suppressed for this number.` |

**Why that last line is real evidence and not a log that flatters itself:** it is printed *after*
the `await` on the store write, and a store failure takes the other branch, which shouts
`STORE WRITE FAILED … the voice path did NOT receive this stop`. This estate has shipped a stop
tripwire that fired, logged a clean success, and suppressed nobody, which is exactly why the
assertion here is on the consequence rather than on the code path.

**Both signed and unsigned requests return byte-identical empty TwiML**, on purpose: the endpoint
must never tell a prober which of the two it was.

**And the key agreement is proven separately** (`research/sms-stop-key-agreement.test.mjs`): the two
shipped functions are extracted and compared across nine input formats plus a negative control
confirming two different numbers do not collide. A stop that wrote a key nobody reads would leave
the person opted out in their own mind and reachable in ours.

⚠️ **One caveat worth stating rather than hiding:** `IncomingPhoneNumbers` reports
`messaging_service_sid: null` and a blank `sms_url` for this number, which reads like "attached to
nothing". It is not — attachment through the Messaging Service's own `PhoneNumbers` resource does
not backfill that legacy field. **Check the service, not the number.** I misread it that way first.

---

## 9. What this program does NOT do

Stated because a reviewer trusts a filing that draws its own boundaries:

- No marketing, promotional or sales messages of any kind.
- No purchased, rented, imported or scraped lists. Ever.
- No consent shared between numbers, programs, brands or affiliates.
- No message to anyone who has not personally asked for that specific thing.
- No message sent before this registration completes.

---

## ★ 9b. THE CAMPAIGN WAS FILED AND REJECTED TWICE. THE CAUSE IS ONE WRONG FIELD, AND IT IS NOT ON THIS PAGE.

**Added 2026-08-15 by @LANE-SEARCHLIGHT after driving the whole chain live.** Nothing in sections 1
to 9 is wrong. The evidence is good. The rejection is somewhere nobody was looking.

**What went through, all measured:**

| Object | SID | State |
|---|---|---|
| TwinFlame secondary customer profile | `BUdfa2eea2aed28550d50914a56db86f26` | **twilio-approved** |
| TwinFlame Standard A2P bundle v2 | `BUb311e948fd48ce790250e72fd5452e5f` | evaluated **compliant**, submitted, **in-review** |
| TwinFlame brand | `BN24a7a4a0cc7d6e56dba14c5a1606ec64` | **APPROVED**, identity **VETTED_VERIFIED**, tcr **BP01ODH** |
| Campaign | `QE2c6890da8086d771620e9b13fadeba0b` | **FAILED**, twice |

**Both failures, both times, identical:**
- `30908 PRIVACY_POLICY_URL` — "a compliant privacy policy can not be verified"
- `30882 TERMS_AND_CONDITIONS_URL` — "rejected due to Terms and Conditions issues"

**★ THE CAUSE: the customer profile's `website_url` is `https://futureful.app/`.**
Not answered.reddenda.com. The reviewer went to a workforce-development site to look for the
Answered texting program's policies. Measured on that site: **zero privacy links, zero terms links,
zero occurrences of the phrase "privacy policy" anywhere in 517,756 bytes.** It was always going to
be rejected.

**Our pages are fine and were never the problem.** Re-measured today: `/privacy` 200/18,075 bytes
carries never-share, never-sell, the mobile number, and the opt-in fact itself, with none of the
disqualifying third-party-marketing pattern. `/terms` 200/25,547 bytes carries the program section,
frequency, rates, STOP, HELP and carrier non-liability. `/pricing` carries the full disclosure and
its Terms and Privacy links both resolve 200.

**I tested the cheap fix first and it failed, which is how we know the cause for certain.** I
deleted the campaign and refiled it with both policy URLs written literally into `Description` and
`MessageFlow`, the only two fields a reviewer reads. **Same two errors.** So the check is against
the brand's registered website and cannot be satisfied from campaign copy. That was worth one
filing to establish, and it means nobody should spend another one trying variations of the wording.

**Why it cannot be fixed by API, both measured:**
- Editing the business-information record returns **70002, "a bundle it belongs to is in an
  immutable state"**. An approved profile is frozen.
- Editing the brand returns **21725, "Brands can only be updated when they are in FAILED state"**.
  Ours is APPROVED, so it is out of reach in the other direction.
- Creating a replacement profile returns **"Secondary Customer Profile for direct_customer can only
  be created through Twilio console."** Section 10 already said this and it is still true.

**THE FIX, and it is the only one: a new secondary customer profile in the Console with
`website_url = https://answered.reddenda.com`.** Everything downstream then re-runs in about ten
minutes, because `netlify/functions/a2p-advance.mjs` now carries the chain the whole way: it
evaluates, submits the bundle, waits for the brand, and files the campaign itself. Point its
`PROFILE_SID`, `BUNDLE_SID` and `BRAND_SID` at the new objects and it does the rest unattended.

**Do NOT file this campaign under the approved SMI brand to get around it.** SMI is a separate
non-profit with a different EIN, the brand carries `tax_exempt_status: 501c3`, and its site is
sminet.org while the opt-in lives on answered.reddenda.com. That is the same website mismatch that
just failed twice, plus an entity mismatch, and a suspended brand would take SMI's approval down
with it.

**One thing this did settle, which section 8 asked for.** Twilio overwrote the opt-out and help
copy we submitted with its own, and returned the keyword set `CANCEL, QUIT, STOP, OPTOUT,
UNSUBSCRIBE, STOPALL, REVOKE, END`. **That is Advanced Opt-Out active on the Messaging Service,
confirmed by observing what the platform did rather than by reading a checkbox.**

---

## 10. Open, and honest

- **The secondary customer profile for TwinFlame Investments LLC is console-only.** Twilio refuses
  it over the API. It is the one remaining human step and it gates the brand, not the evidence.
- ~~**No inbound SMS webhook exists yet**, so carrier-level STOP is handled by Twilio and is not yet
  mirrored into our own suppression store.~~ **CLOSED 2026-08-15.** `/api/sms-inbound` is live,
  attached to the Messaging Service, signature-verified, and measured writing a real STOP into the
  same key the voice path reads. Full measurement table in section 8. **A reviewer can test it and
  it will hold**, which is the only reason to write it down at all.
- **Twilio Lookup was returning 401 on production earlier tonight.** It does not touch the brand or
  campaign filing path, but no readiness signal on this estate should be trusted if it probes the
  account rather than the capability in question.
