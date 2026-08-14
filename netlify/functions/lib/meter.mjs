// meter.mjs — the price book and the rating engine. Pure: no network, no clock, no database.
//
// ★ THE SOURCE OF TRUTH FOR THIS FILE IS /terms, NOT THIS FILE.
// The terms page says, in the customer's own words:
//
//     "That is the entire list. If an event is not on it, it cannot appear on your bill."
//     "If your bill and this page ever disagree, this page wins."
//
// So this module is a transcription, and it is deliberately closed: an unknown kind is REFUSED,
// never rated at a guessed price and never passed through at zero. A billing engine that shrugs at
// an event it does not recognise is how a customer gets a line item nobody can explain.
//
// Every price below is quoted from the published table. Nothing here is derived, estimated, or
// averaged. Where the terms state a CONDITION on a price (the four pieces of a booked job, the
// meaning of "recovered", the notice before a quiet line), the condition is code, not a comment,
// because a condition that lives only in prose is a condition nobody enforces.
//
// This file never charges anything. It answers one question: given what happened, what does the
// published price book say this costs, and why. The ledger records the answer; Stripe moves money.

/* ── the closed list, transcribed from /terms ─────────────────────────────────────────────────
 *
 *   What happened                                                    What it costs
 *   ---------------------------------------------------------------------------------
 *   Having Answered on your line, any month, any call volume         $0
 *   A job booked in standard hours                                   $19
 *   A job booked after hours, nights and weekends                    $49
 *   Hold reaches a human on a government line                        $20
 *   Hold reaches a human on a commercial line                        $10
 *   Hold reaches nobody, however long it waited                      $0
 *   Your first hold, ever                                            $0
 *   Recover lands your money                                         15% of it
 *   Autopilot, per invoice that gets paid                            $19
 *   A quiet line, defined below, per month                           $39
 *   A settled Parley                                                 $29
 */

export const CATALOG = Object.freeze({
  line_month:            { cents: 0,    product: 'answered', label: 'Answered on your line',        capped: false },
  booked_job:            { cents: 1900, product: 'answered', label: 'Job booked, standard hours',   capped: true  },
  booked_job_after_hours:{ cents: 4900, product: 'answered', label: 'Job booked, after hours',      capped: true  },
  hold_gov:              { cents: 2000, product: 'hold',     label: 'Human reached, government line', capped: false },
  hold_commercial:       { cents: 1000, product: 'hold',     label: 'Human reached, commercial line', capped: false },
  hold_no_human:         { cents: 0,    product: 'hold',     label: 'Hold reached nobody',          capped: false },
  recover_landed:        { cents: null, product: 'recover',  label: 'Recover landed your money',    capped: false },
  autopilot_invoice_paid:{ cents: 1900, product: 'recover',  label: 'Autopilot, invoice paid',      capped: false },
  quiet_line_month:      { cents: 3900, product: 'answered', label: 'Quiet line, one month',        capped: false },
  parley_settled:        { cents: 2900, product: 'parley',   label: 'Parley settled',               capped: false },
});

/** The cap. /terms: "Every account starts with a monthly cap of $549." */
export const DEFAULT_CAP_CENTS = 54900;

/**
 * The three Recover bands, standard and Answered-subscriber, exactly as /terms publishes them.
 *
 * ★ THE DAY THRESHOLDS FOR "newer / most / oldest" ARE NOT PUBLISHED ANYWHERE ON THIS SITE, so
 * this module does not invent them. The terms make the band an INPUT rather than a derivation:
 * "You see which band every invoice sits in before we place the first call." A band that the
 * customer was shown before the first call is a recorded fact; a band this engine computed from a
 * cutoff we never published would be a number we made up. So `band` must arrive on the event, with
 * the timestamp it was shown, and an event without one is refused rather than defaulted to 15%.
 */
export const RECOVER_BANDS = Object.freeze({
  newer:  { standard: 0.10, subscriber: 0.08 },
  most:   { standard: 0.15, subscriber: 0.13 },
  oldest: { standard: 0.20, subscriber: 0.18 },
});

/** /terms: "Recovered means the payment lands within 30 days of our last contact on that invoice." */
export const RECOVERED_WINDOW_DAYS = 30;

/** The four pieces. /terms: "Anything less is free. That is the whole definition." */
export const BOOKED_JOB_PIECES = Object.freeze(['name', 'address', 'callback', 'window']);

/**
 * Shapes this company refuses to sell. These are not unknown kinds, they are kinds we have
 * publicly promised never to bill, so they get their own refusal with the promise quoted back.
 * /terms: "There is no subscription. There is no per minute price. There is no per call price."
 */
const REFUSED_SHAPES = Object.freeze({
  per_minute:   'Answered does not sell minutes. The terms say there is no per minute price.',
  per_call:     'Answered does not sell calls. The terms say there is no per call price.',
  subscription: 'Answered has no subscription. The base price of the line is $0 and stays $0.',
  setup_fee:    'There is no setup fee on the published list, so it cannot appear on a bill.',
});

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const day = 24 * 60 * 60 * 1000;
const ts = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * A refusal is a first-class result, not an exception. It is what the statement prints.
 *
 * ★ THE SPREAD ORDER IS THE WHOLE SAFETY OF THIS FUNCTION, and it was wrong first. The context
 * object callers pass in carries `ok: true`, because it describes a known catalog row. Spreading
 * it AFTER the refusal fields overwrote `ok: false` with `ok: true`, so nine different refusals
 * came back reading as successful ratings that happened to cost $0: a recover fee with no band, an
 * autopilot charge with no payment, a quiet line with no notice. Every amount was still correct,
 * which is exactly why nothing downstream would have noticed. Context goes FIRST and the verdict
 * goes LAST, always, in both of these.
 */
const refuse = (reason, extra = {}) => ({
  ...extra, ok: false, billable: false, cents: 0, gross_cents: 0, reason,
});

/** A zero is also a first-class result. "Free" is an outcome the customer paid attention to. */
const free = (kind, reason, extra = {}) => ({
  ...extra, ok: true, billable: false, cents: 0, gross_cents: 0, kind, reason,
});

/**
 * Rate one event against the published price book.
 *
 * @param {object} event
 *   kind          one of CATALOG, or one of REFUSED_SHAPES, or anything else (refused)
 *   evidence      {name,address,callback,window} for a booking; the hold line type; the invoice
 *   recovered_cents, band, band_shown_at, first_call_at, last_contact_at, landed_at, promised_by
 * @param {object} account
 *   plan                     'standard' | 'subscriber'
 *   cap_cents                the monthly cap in force for THIS cycle (never changed mid-cycle)
 *   month_charged_cents      what capped events have already charged this cycle
 *   first_hold_used          whether the one free hold has been spent
 *   quiet_credit_cents       unspent quiet-line credit, which /terms says comes back against bookings
 *   quiet_notice_at          when the customer was told in writing, before any $39 exists
 *   bookings_last_90d        month-by-month booking counts, for the quiet-line definition
 * @returns {object} a rating: what it costs, and the sentence that explains it.
 */
export function rate(event = {}, account = {}) {
  const kind = String(event.kind || '');

  if (REFUSED_SHAPES[kind]) return refuse(REFUSED_SHAPES[kind], { kind, refused_shape: true });

  const item = CATALOG[kind];
  if (!item) {
    return refuse(
      `"${kind || '(none)'}" is not on the published list of billing events, so it cannot appear on a bill.`,
      { kind },
    );
  }

  const plan = account.plan === 'subscriber' ? 'subscriber' : 'standard';
  const capCents = isNum(account.cap_cents) ? account.cap_cents : DEFAULT_CAP_CENTS;
  const already = isNum(account.month_charged_cents) ? Math.max(0, account.month_charged_cents) : 0;
  const base = { ok: true, kind, product: item.product, label: item.label, plan };

  // ── the events that are free by definition ───────────────────────────────────────────────────
  if (kind === 'line_month') {
    return { ...free(kind, 'Having Answered on your line is $0, any month, any call volume.'), ...base, billable: false };
  }
  if (kind === 'hold_no_human') {
    return { ...free(kind, 'Hold reached nobody, so the price is $0 however long it waited.'), ...base, billable: false };
  }

  // ── the booked job, and the definition everything hangs on ───────────────────────────────────
  if (kind === 'booked_job' || kind === 'booked_job_after_hours') {
    const ev = event.evidence || {};
    const missing = BOOKED_JOB_PIECES.filter((p) => {
      const v = ev[p];
      return v === undefined || v === null || String(v).trim() === '';
    });
    if (missing.length) {
      return {
        ...free(kind, `A job is booked when it has a name, an address, a callback number and a confirmed window. This one is missing ${missing.join(', ')}, so it is free.`),
        ...base, billable: false, missing_pieces: missing,
      };
    }

    // After hours is a higher price, so it carries the higher burden of proof. An event that
    // claims $49 without saying WHEN it happened is rated at the standard price, never the
    // premium one: an unproved upgrade must fall toward the customer, not toward us.
    let effective = kind;
    let downgraded = null;
    if (kind === 'booked_job_after_hours' && !event.booked_at) {
      effective = 'booked_job';
      downgraded = 'This booking claimed after hours without recording when it happened, so it is billed at the standard price.';
    }
    const gross = CATALOG[effective].cents;

    // The cap. /terms h2: "Your bill stops at $549." and "Once your bookings reach the cap,
    // every booking after it that month is free."
    //
    // Those two sentences disagree at the boundary: a $19 booking arriving at $540 charged would
    // satisfy the second sentence and break the first, landing the bill at $559. This engine
    // resolves it the only way that keeps BOTH sentences literally true, which is also the way
    // that favours the customer: the charge is clamped so the cycle can never exceed the cap.
    const room = Math.max(0, capCents - already);
    const afterCap = Math.min(gross, room);
    const capApplied = gross - afterCap;

    // The quiet-line credit. /terms: "every dollar of it comes back as credit against your
    // bookings." Credit is money the customer already paid, so it is spent before new money is
    // taken, and it is spent on the amount that survived the cap.
    const credit = isNum(account.quiet_credit_cents) ? Math.max(0, account.quiet_credit_cents) : 0;
    const creditUsed = Math.min(credit, afterCap);
    const cents = afterCap - creditUsed;

    const why = [];
    if (downgraded) why.push(downgraded);
    if (capApplied > 0 && afterCap === 0) why.push(`Your bookings reached the $${(capCents / 100).toFixed(0)} cap this cycle, so this booking is free.`);
    else if (capApplied > 0) why.push(`Your $${(capCents / 100).toFixed(0)} cap stopped this booking at $${(afterCap / 100).toFixed(2)}.`);
    if (creditUsed > 0) why.push(`$${(creditUsed / 100).toFixed(2)} of quiet line credit came back against this booking.`);
    if (!why.length) why.push(effective === 'booked_job_after_hours'
      ? 'A job booked after hours, with all four pieces recorded.'
      : 'A job booked in standard hours, with all four pieces recorded.');

    return {
      ...base,
      kind: effective,
      label: CATALOG[effective].label,
      billable: cents > 0,
      gross_cents: gross,
      cap_applied_cents: capApplied,
      credit_applied_cents: creditUsed,
      cents,
      reason: why.join(' '),
      counts_toward_cap: true,
    };
  }

  // ── Hold ─────────────────────────────────────────────────────────────────────────────────────
  if (kind === 'hold_gov' || kind === 'hold_commercial') {
    const gross = item.cents;
    if (!account.first_hold_used) {
      return {
        ...base, billable: false, gross_cents: gross, cents: 0, first_hold: true,
        reason: 'Your first hold is free, so you can see a real hold receipt before you ever pay for one.',
      };
    }
    return {
      ...base, billable: true, gross_cents: gross, cents: gross,
      reason: kind === 'hold_gov'
        ? 'A live person was reached on a government line. One price, the whole errand.'
        : 'A live person was reached on a commercial line. One price, the whole errand.',
    };
  }

  // ── Recover ──────────────────────────────────────────────────────────────────────────────────
  if (kind === 'recover_landed') {
    const amount = event.recovered_cents;
    if (!isNum(amount) || amount <= 0) {
      return refuse('A Recover fee needs the number of dollars that actually landed. Nothing landed, nothing owed.', base);
    }
    const band = String(event.band || '');
    if (!RECOVER_BANDS[band]) {
      return refuse(
        `A Recover fee needs the band the invoice sat in, one of ${Object.keys(RECOVER_BANDS).join(', ')}. The terms promise you see the band before the first call, so this engine will not pick one for you.`,
        base,
      );
    }
    const shown = ts(event.band_shown_at);
    const firstCall = ts(event.first_call_at);
    if (!shown) {
      return refuse('The terms promise the band is shown before the first call. Nothing recorded when it was shown, so this fee is refused.', { ...base, band });
    }
    if (firstCall && shown > firstCall) {
      return refuse('The band was shown after the first call, which is not what the terms promise, so this fee is refused.', { ...base, band });
    }

    // "Recovered means the payment lands within 30 days of our last contact on that invoice, or by
    // a date the payer promised in writing. Money that arrives outside that window is yours alone."
    const landed = ts(event.landed_at);
    const lastContact = ts(event.last_contact_at);
    const promised = ts(event.promised_by);
    if (landed && lastContact) {
      const inWindow = landed <= lastContact + RECOVERED_WINDOW_DAYS * day;
      const byPromise = promised ? landed <= promised : false;
      if (!inWindow && !byPromise) {
        return {
          ...base, billable: false, gross_cents: 0, cents: 0, band,
          reason: `That payment landed outside the ${RECOVERED_WINDOW_DAYS} day window after our last contact, and no written promise covered the date. That money is yours alone.`,
        };
      }
    }

    const share = RECOVER_BANDS[band][plan];
    const cents = Math.round(amount * share);
    return {
      ...base, billable: cents > 0, gross_cents: cents, cents, band, share,
      recovered_cents: amount,
      reason: `${(share * 100).toFixed(0)}% of the $${(amount / 100).toFixed(2)} that landed in your account${plan === 'subscriber' ? ', at the Answered subscriber rate' : ''}.`,
    };
  }

  if (kind === 'autopilot_invoice_paid') {
    if (!event.paid_at) {
      return refuse('Autopilot charges only when the invoice it chased actually gets paid. Nothing recorded a payment, so this is refused.', base);
    }
    return {
      ...base, billable: true, gross_cents: item.cents, cents: item.cents,
      reason: 'A flat $19 for an invoice that got paid. No share, never per call, never per invoice placed.',
    };
  }

  // ── the quiet line ───────────────────────────────────────────────────────────────────────────
  if (kind === 'quiet_line_month') {
    // "A quiet line is a line that has booked fewer than three jobs a month for 90 straight days."
    const months = Array.isArray(account.bookings_last_90d) ? account.bookings_last_90d : null;
    if (!months || months.length < 3) {
      return refuse('A quiet line is defined by 90 straight days of fewer than three bookings a month. Without that record this rate does not exist.', base);
    }
    const loud = months.find((n) => !isNum(n) || n >= 3);
    if (loud !== undefined) {
      return {
        ...base, billable: false, gross_cents: 0, cents: 0,
        reason: 'This line booked three or more jobs in a month inside the last 90 days, so it is not a quiet line and the $39 does not exist.',
      };
    }
    // "it announces itself before it ever starts: you get told in writing before the first $39."
    const notice = ts(account.quiet_notice_at);
    const at = ts(event.occurred_at);
    if (!notice || (at && notice > at)) {
      return refuse('The terms promise you are told in writing before the first $39 is billed. No notice is on record before this date, so it is refused.', base);
    }
    return {
      ...base, billable: true, gross_cents: item.cents, cents: item.cents,
      creates_credit_cents: item.cents,
      reason: 'A quiet line, one month. Every dollar of this comes back as credit against your bookings.',
    };
  }

  // ── Parley ───────────────────────────────────────────────────────────────────────────────────
  if (kind === 'parley_settled') {
    if (!event.settled_at) {
      return refuse('Parley charges when it settles. Nothing recorded a settlement, so this is refused.', base);
    }
    // "$29 when it settles", split between the two sides. The split is on the deal, not the rating.
    return {
      ...base, billable: true, gross_cents: item.cents, cents: item.cents,
      reason: 'A settled Parley. Nothing is owed on a deal that does not settle.',
    };
  }

  return refuse(`"${kind}" is on the catalog but this engine has no rule for it, which is a defect, not a price.`, base);
}

/** Every kind this engine will accept, for a caller that wants to validate before it records. */
export const KINDS = Object.freeze(Object.keys(CATALOG));

/** Money, one way, everywhere. Never re-derived in a template. */
export const usd = (cents) => `$${(Math.round(cents) / 100).toFixed(2)}`;
