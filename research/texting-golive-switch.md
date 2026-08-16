# The texting go-live switch — DRAFT, NOT SHIPPED

Drafted 2026-08-16 by @ANSWERED-INTEL at @LANE-SEARCHLIGHT's request. **Nothing in here has been
applied.** It is the thing that must be ready *before* a registration clears, because it cannot be
done in the ten seconds after.

---

## ★ FINDING FIRST, BECAUSE IT CHANGES WHAT "GO LIVE" MEANS

**When the campaign is approved and the env vars are set, NOTHING WILL TEXT.**

That is not a copy problem. It is a wiring problem, and it was measured, not inferred:

| | |
|---|---|
| `/api/booking` — **the live booking path** | **zero** `out.sms` calls. Email only. |
| `notifyBooked()` — the function that *does* build the SMS | **no callers anywhere in the tree** |
| `answered-tool.mjs` — the booking webhook | **zero** `out.sms` calls |

Positive control: the same search finds 12 callers of `createJob`/`recordJob`, and finds the single
`out.sms` inside `lib/jobs.mjs`. So the search works, and the absence is real.

**`notifyBooked` is complete, correct, and orphaned.** It builds the message, picks the recipient,
respects `sms_on:false`, and hands off to `outbox.sms` which does the suppression check. Every part
of it is right. Nothing calls it.

So the honest sequence is **wire it, then switch it on** — in that order. Flipping the env first
produces a system that is "live" and silent, which is the worst of both: the copy stops saying we
do not text, and we still do not text.

---

## WHAT THE RUNTIME ACTUALLY SAYS TODAY

Read from a live function (`/api/recap`), **not** from `netlify env:get`, which returns a redacted
decoy on this estate:

```
enabled                False
ready                  False
has_sender             False
has_credentials        True     <- Twilio creds are already there
reason                 "Text messaging is switched off. The A2P 10DLC campaign that a carrier
                        requires before a business number may send text messages is not approved
                        yet, so a text from this system would not reach a phone."
```

So the switch is **two env vars**, not a code change:

```
ANSWERED_SMS_ENABLED=1
ANSWERED_SMS_MESSAGING_SERVICE_SID=MGab661e1277775dfa0cbe1851b039c3f5
```

Prefer the messaging service over `ANSWERED_SMS_FROM`: the service is what the campaign is registered
against, and it is what `/api/sms-inbound` already hangs off, so STOP handling comes along for free.

---

## THE SENTENCES THAT BECOME LIES

Every one of these is TRUE today and FALSE the moment texting sends. Two are shared constants, which
is the good news — most of the surface moves from two edits.

| where | what it says |
|---|---|
| `booking.mjs:44` `SMS_TRUTH` | "Answered did not text anyone about this job. Text messaging is not switched on yet…" |
| `lib/notify-prefs.mjs:882` `SMS_TRUTH` | "We did not text you about this. Text messaging is not switched on yet…" |
| `booking.mjs:169` | "We did not send you a text, because text messaging is not switched on yet." |
| `job.mjs:162` | "**We did not text you.** … When texting is on, this page will say so." |
| `_build.py:407` | `short='texting is not switched on, so what you ask for arrives by email'` |
| `_build.py:912` → `pricing.html:446` | "Texting is not switched on yet, so for now what you ask for arrives by email." |
| `terms.html:149` | "Texting us the word is not switched on yet, because our messaging program is still waiting on the carriers…" |

`job.mjs:162` is the one that already promises the fix: *"When texting is on, this page will say so."*
That is a commitment in shipped copy, and it is the reason this must be a switch rather than a rewrite.

---

## THE DESIGN: SELF-TRUING, NOT A SECOND EDIT

The requirement is that the copy is true before AND after **without anyone remembering to change it.**
So it must derive from the same gate the send path derives from, never from a hand-edited string.

### Runtime surfaces (`booking.mjs`, `job.mjs`, `notify-prefs.mjs`)

Replace both `SMS_TRUTH` constants with one function in `lib/outbox.mjs`, beside `smsStatus()` which
already computes the truth:

```js
/**
 * ★ ONE SENTENCE, DERIVED FROM THE SAME GATE THE SEND PATH USES.
 * This was two hand-written constants saying "we did not text you", which are true today and become
 * lies the instant ANSWERED_SMS_ENABLED flips. Deriving it means the copy cannot drift from the
 * behaviour: if sms() would refuse, we say we did not text; if it would send, we say we did.
 * Takes the ACTUAL send result where the caller has one, because "we sent you a text" is a claim
 * about an outcome and the outcome is knowable.
 */
export function smsSentence(result) {
  if (result && result.ok) return 'We also texted you this.';
  if (result && result.suppressed) return 'We did not text you, because this number is on your do-not-contact list.';
  const s = smsStatus();
  if (!s.ready) return 'Answered did not text anyone about this job. Text messaging is not switched on yet, so email is the channel that actually delivers.';
  return 'We did not text you about this one, so email is the record.';
}
```

Then `booking.mjs:127`, `booking.mjs:169` and `job.mjs:162` call `smsSentence(smsRes)` rather than
interpolating a constant.

### Static pages (`_build.py`)

The build already has `_SMS_OK` and `_texting_guard()` **with a positive and a negative control** —
that guard is well built and must not be weakened. Add one flag read from the environment at build
time, defaulting OFF so a stale build never over-promises:

```python
# ★ DEFAULTS TO OFF. A build that cannot prove texting is live must produce the
# not-yet copy, because the failure direction matters: saying "we do not text"
# while texting works is a missed feature, saying "we text you" while it does
# not is a broken promise to a customer.
TEXTING_LIVE = (os.environ.get('ANSWERED_SMS_ENABLED', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')

SMS_STATUS_LINE = (
    'Texting is on: what you ask for arrives as a text, and email stays as the record.'
    if TEXTING_LIVE else
    'Texting is not switched on yet, so for now what you ask for arrives by email.'
)
```

`_build.py:407` and `:912` interpolate `SMS_STATUS_LINE`. `terms.html:149` gets the same treatment.

**The guard needs one addition, and this is the part worth arguing about:** `_SMS_OK` currently
whitelists `'arrives by email'`, so the live-copy variant would trip the banned-promise check. Add
the live sentence's distinguishing clause to `_SMS_OK` **and extend the positive control** so the
guard is still proven able to fire in the live configuration. A guard that is only controlled in one
of the two states is half a guard.

---

## THE ORDER, WHICH IS NOT NEGOTIABLE

1. **Wire `notifyBooked` into the live booking path.** Until this, nothing texts and every step below
   is cosmetic. This is the real work and it is mine.
2. Ship the derived-sentence change. Safe while texting is off — it produces today's copy today.
3. **Only then** set the two env vars.
4. Send one real message to a real handset and read the delivery status from Twilio, not from our own
   log. `30034` and `30032` both render to a human as a plain "undelivered"; only the code says which
   registration is missing.
5. Rebuild the static pages so `TEXTING_LIVE` is true, and verify the live sentence on prod.

**Steps 2 and 5 are separated on purpose.** The runtime copy self-heals the moment the env flips; the
static pages need a build. If the build is skipped, the site says "not switched on" while the product
texts — an understatement, which is the survivable failure. The reverse is not.

---

## WHAT I HAVE NOT DONE

Nothing here is applied. No env var set, no copy changed, no wiring added. `notifyBooked` is still
orphaned, which is the honest state and is now written down instead of being a surprise on approval
day.
