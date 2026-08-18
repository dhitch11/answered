// npa.mjs — which jurisdiction a phone number's area code actually belongs to.
//
// ═══ WHY THIS FILE EXISTS ═══
//
// The gate answers two different questions from two different fields and never compared them.
// State law is chosen by `contact.state`, which comes from the published business listing. The
// do-not-call subscription fence is chosen by `phone.slice(2,5)`, the area code. Nothing checked
// that those two agree, and in the live corpus they disagree on 2,513 rows:
//
//   368 rows labelled OR carrying 360 (Washington)      126 in 509 (Washington)
//   133 in 208 (Idaho)                                   42 toll-free
//    22 CANADIAN NPAs (514 Montreal, 581 Quebec, 548 Ontario) — they satisfy /^\+1\d{10}$/
//       perfectly, and the TCPA is not even the governing statute for them
//     1 NPA "154", which is not a valid area code at all
//
// Today every one of those is refused by accident: `subscribedAreaCodes` is null, so the fence
// rejects everything. The day a real subscription is loaded, that accident ends, and a 360 number
// gets OREGON'S analysis applied to a WASHINGTON number — a state that requires a telephone-
// solicitor registration and bond, where RCW 19.158.050 also bars an unregistered solicitor from
// maintaining or defending a lawsuit in state.
//
// ★ THIS DOES NOT TREAT THE AREA CODE AS AUTHORITATIVE, AND THAT DISTINCTION IS THE WHOLE DESIGN.
//
// Local number portability means an area code has not proven a location since 2003. A contractor
// in Portland can keep a 360 number from a Vancouver shop; a business can port a 503 number and
// move to Boise. So a disagreement does NOT mean the listing is wrong. It means we have two
// independent signals pointing at two different bodies of law and no basis to choose.
//
// This gate's doctrine for that is already written, everywhere else in lane.mjs: an unanswerable
// question is a refusal. So disagreement refuses. It does not silently pick the area code, and it
// does not silently keep the listing. It says the jurisdiction is unresolved and stops.
//
// Data: NANPA's own NPA database. It lives in ./nanpa-data.mjs as a MODULE, not as a JSON file
// read at runtime — see the header there for why that distinction decides whether the deployed
// function works.

import { NANPA, NANPA_META } from './nanpa-data.mjs';

const DB = { npa: NANPA, file_date: NANPA_META.fileDate };

export const NPA_SOURCE = NANPA_META;

/**
 * What NANPA says about one area code.
 *
 * `known:false` is returned for anything absent from the database, which includes both nonsense
 * ("154") and any NPA assigned after the stored file date. Both are treated the same way by the
 * caller, deliberately: a code we cannot describe is a code we cannot reason about.
 */
export function npaFacts(npa) {
  const key = String(npa || '').trim();
  const row = DB.npa[key];
  if (!row) return { npa: key, known: false, geographic: false, inService: false, state: null, country: null };
  return {
    npa: key,
    known: true,
    // `g` is NANPA's USE == 'G', general purpose. Everything else is an Easily Recognizable Code
    // (800/888/877/866/855/844/833 toll-free, 900 premium) or a service code (211, 411, 911).
    // None of those is assigned to a state, so none of them can be checked for coherence.
    geographic: row.g === true,
    inService: row.live === true,
    state: row.s || null,
    country: row.c || null,
  };
}

export const npaOf = (phone) => String(phone || '').replace(/\D/g, '').replace(/^1/, '').slice(0, 3);

/**
 * Compare the area code's home jurisdiction against the state we were going to apply law from.
 *
 * Returns `{ ok, why, reason, npa, npaState, claimedState }`. `ok:false` is always a refusal.
 * `reason` is prose written for whoever audits the refused row, not for a developer.
 *
 * ★ `why` IS A CODE, NOT A STRING TO MATCH ON. A first version of the caller distinguished the two
 * classes of failure by testing whether the reason began with "area code", which would have gone
 * silently permissive the first time somebody improved the wording. The two classes are:
 *   'npa'   the area code itself cannot support ANY jurisdiction analysis — unknown, dead,
 *           non-geographic, or not in the United States. True regardless of consent, because
 *           consent to be called is not a choice of law.
 *   'state' the area code is a fine US geographic code and simply disagrees with the listing.
 *           Only meaningful where state law is being selected, so only on the non-consented path.
 */
export function jurisdictionAgrees(phone, claimedState) {
  const npa = npaOf(phone);
  const f = npaFacts(npa);
  const claimed = String(claimedState || '').trim().toUpperCase();
  const out = { npa, npaState: f.state, claimedState: claimed || null };

  const npaFail = (reason) => ({ ...out, ok: false, why: 'npa', reason });
  const stateFail = (reason) => ({ ...out, ok: false, why: 'state', reason });

  if (!f.known) return npaFail(`area code ${npa || '(none)'} is not in the NANPA database (file date ${DB.file_date}), so there is no way to say which jurisdiction's law governs this call`);
  if (!f.inService) return npaFail(`area code ${npa} is not in service`);
  if (!f.geographic) return npaFail(`area code ${npa} is not assigned to a geography (toll-free, premium or a service code), so no state's law can be selected for it and, on a toll-free number, the called party pays for the call`);
  if (f.country !== 'US') return npaFail(`area code ${npa} is ${f.country || 'outside the US'} (${f.state || 'unknown'}); it satisfies the +1 format but the TCPA is not the governing statute there and nobody has read that jurisdiction's law`);
  if (!claimed) return stateFail('no state on the record to compare the area code against');
  if (f.state !== claimed) return stateFail(`the listing says ${claimed} and area code ${npa} belongs to ${f.state}. Portability means neither is proof, so this is not a wrong address, it is two signals pointing at two different bodies of law with no basis to choose between them`);
  return { ...out, ok: true, why: null, reason: `area code ${npa} and the listing both say ${claimed}` };
}

/** Every in-service, general-purpose, US area code for a state. Used to size a DNC subscription. */
export function npasForState(state) {
  const st = String(state || '').trim().toUpperCase();
  return Object.entries(NANPA)
    .filter(([, v]) => v.g && v.live && v.c === 'US' && v.s === st)
    .map(([k]) => k)
    .sort();
}
