# Twilio AI Startup Searchlight — blocks 3, 4, 5

Drafted 2026-08-15 by @ANSWERED-INTEL for @LANE-SEARCHLIGHT. **Track A, Breakthrough Builders.**

**Every technical claim below was read out of the running codebase or measured against production
today.** Where the war room found v1 asserting something false, the replacement is marked ★ with
what was actually verified. `github.com/dhitch11/answered` is a public repository, so a judge can
check any of this with a browser, which is the standard these are written to.

---

## BLOCK 3 — How we use Twilio

> Answered is an AI phone line for trade contractors. The interesting part of our Twilio usage is
> not that we place and receive calls. It is that **we use TwiML as a compliance control plane over
> a voice agent we do not own.**
>
> The conversational agent is a third-party vendor. Their platform returns a TwiML document
> containing their `<Connect>`. We do not accept that document as final. Before it reaches the
> caller we splice our own instructions in immediately after the opening `<Response>`, ahead of
> anything the vendor wrote:
>
> - **A bare `<Say>` carrying the legally required disclosure.** It is injected at the only
>   position where a vendor cannot skip it and where barge-in cannot cut it. We learned that
>   position the hard way: a disclosure placed inside a `<Gather>` is never spoken at all if the
>   caller speaks first, and our entire spoken output on those calls was the word "Hi" while every
>   file-level check said the disclosure was present.
> - **`<Start><Transcription>` with `partialResults="true"` and `track="both_tracks"`**, labelled
>   inbound and outbound. This gives us a live transcript of a conversation being conducted by
>   somebody else's agent, which is what makes the next control possible.
>
> On top of that transcript runs a **mid-utterance stop-word tripwire**. Partial results mean we do
> not wait for a caller to finish a sentence before honouring "stop". The pattern behind it is
> deliberately narrow, and narrowing it was a measured correction rather than a design instinct: a
> bare `\bstop\b` permanently suppressed a business owner who answered our own question with "we
> stop taking calls at six."
>
> The rest of the stack is used as a legal instrument rather than a feature set:
>
> - **Lookup v2 line-type intelligence is a precondition, not an optimisation.** A number's line
>   type decides which rules apply, so a lookup that fails is a refusal to dial rather than a
>   fallback to trying anyway.
> - **`AnsweredBy` answering-machine detection** branches the call: a machine and a human are
>   different legal situations, not different user experiences.
> - **`<Dial><Conference>`** for human takeover, carrying an explicit `disclosed=1` so a supervisor
>   joining a call that has already heard the disclosure does not repeat it, and one that has not
>   does.
> - **Webhook signature validation on `X-Twilio-Signature`.** ★ Stated as something we tested rather
>   than something we intended: this control was previously written so that a missing auth token
>   returned `true`, and the token was unset in production, so the check did not execute. It is
>   fixed, and re-probed since: an unsigned POST carrying a genuine AccountSid is now rejected with
>   `invalid signature`.
>
> ★ **On the shape of our dial paths, precisely.** There are three `createCall` implementations
> across eight call sites. We do not claim a single funnel, because that is not what we built and it
> is not what we would build: **each origination site carries a gate shaped to its own legal
> regime.** Cold outbound answers to TCPA and the do-not-call rules. Invoice recovery answers to the
> FDCPA, including 12 CFR 1006.14(b)(2) frequency ceilings and calling windows computed in the
> debtor's own timezone. A single uniform gate would have to be the loosest of them. One narrow gap
> remains and we are not going to pretend otherwise: a redial in the hold flow inherits a stored
> verdict rather than re-consulting the gate.

---

## BLOCK 4 — The hardest problem we solved

> **A compliance control that logged a clean success and suppressed nothing.**
>
> Our stop tripwire watches the live transcript and permanently suppresses any number whose owner
> says stop. It read the caller's number from the transcription callback body, as `To` and `From`.
>
> Twilio's transcription-content callback does not carry `To` or `From`. It carries `AccountSid`,
> `CallSid`, `TranscriptionSid`, `Timestamp`, `SequenceId`, `TranscriptionEvent`, `LanguageCode`,
> `Track`, `TranscriptionData`, `Stability` and `Final`. So both fields were `undefined` on every
> single call.
>
> **The tripwire fired. It wrote a log line saying a stop had been honoured. It suppressed nobody.**
> Every test passed, because the tests asserted that the tripwire ran. Nothing asserted that a
> number came out the other side.
>
> The fix is one line: the number travels on the callback URL as a query parameter, because it is
> not in the body and never was. The lesson is the part we kept. **A control that reports success is
> not a control that acted**, and the way to tell the difference is to assert on the consequence, in
> the store, rather than on the code path. We now have a rule from it that we apply everywhere: ask
> whether the check could have read differently if the thing it tests were broken. If not, it is
> not a test.
>
> That single defect is why our other controls are written the way they are. Consent is recorded
> before a dial rather than after, so a crash between the two cannot produce a call with no record.
> Delivery intent is written inside the same database transaction as the business fact it belongs
> to, so no ordering of failures leaves a job that exists for the customer and never existed for the
> connector. Quiet hours are computed in the local time of the number's area code, not the server's.
> None of that is caution. It is the same lesson applied in four places.

---

## BLOCK 5 — The measured insight

> **A person who says stop has said stop. The channel they happened to say it on is not a
> qualifier on their answer.**
>
> Carriers honour STOP for messaging at the platform level, which means a person who texts STOP
> stops receiving texts. That is where most implementations end, and it leaves a hole big enough to
> put a human being in: **the same person, having opted out in the clearest possible terms, remains
> reachable by voice**, because the two facts live in different systems and neither asks the other.
>
> So an inbound STOP now mirrors into the same permanent suppression key our voice path checks
> before it dials, as the fourth of ten ordered gates and ahead of any vendor call. One word shuts
> every door.
>
> Proving it mattered more than building it, because the failure mode is silent: if the two systems
> compute the key differently, the stop writes a record nobody reads and the person stays reachable
> while believing they opted out. **We extracted both shipped functions and compared them across
> nine input formats, plus a negative control to confirm two different numbers do not collide.**
>
> A related measurement, stated with its denominator because the denominator is the honest part:
> **of the 4,372 contractor numbers we have actually checked with Lookup, 27.7% are fixed business
> lines. That is 9% of a 48,111-record corpus; the rest have not been checked and we do not count
> them.** The figure matters because line type is a legal precondition in this business, not a
> deliverability statistic, and because the population is still growing, so it is recomputed rather
> than quoted.
>
> The insight underneath both: in telephony the expensive failures are not outages. They are
> controls that appear to work. Every one we have found reported success while doing nothing, and
> every one was caught by asking what the system would have to do for the check to fail.

---

## Handback notes for @LANE-SEARCHLIGHT

- **Register:** engineering-credible, specific, no bracing for a traction question. Past Track A
  honorees include companies with no disclosed funding, so stage is not the gate.
- **No competitor is named anywhere.** The Avoca and Sameday measurements are real and usable, but a
  panel reads a teardown as insecurity. Block 5 wins on what we do.
- **Nothing here claims a pilot**, and nothing says ConversationRelay is scoped. If it appears
  elsewhere in the application, the honest word is "evaluating".
- **Recompute the line-type figures on submission day.** The corpus grows; the denominator moves.
- **Do not paste from `TWILIO-SEARCHLIGHT-2026-APPLICATION-DRAFT.md`.** It describes a live security
  gap in the applicant's own words.
- **Nothing goes to the portal without David.**
