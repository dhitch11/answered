// crisis-es.mjs — the Spanish caller-side hazard floor.
//
// ═══ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══
//
// This is the Spanish counterpart of CRISIS_RE: it runs on the CALLER's words before the model, and
// when it matches, the call ends with one fixed line. It covers GAS, CARBON MONOXIDE and FIRE/SMOKE.
//
// ★ IT DOES NOT COVER WATER, AND THAT IS A DECISION, NOT AN OMISSION. Eight agents built and then
// attacked a full Spanish port on 2026-08-17. The water floor measured **34 of 50 ordinary paying
// sentences ENDING THE CALL** — a clogged kitchen sink, low shower pressure, a running toilet. On a
// plumbing line the hazard vocabulary IS the routine vocabulary (agua, saliendo, lleno, no para),
// and no pattern separates them without a parser. Shipping it would hang up on a third of callers.
// The English water rules stay English-only until something better than a regex exists.
//
// ★ AND IT DOES NOT COVER THE OUTPUT FLOORS. Those are speech-act detection - is this a promise? an
// instruction? - which English lets a regex approximate only because its word order is rigid.
// Measured on the same day: 42 of 46 ordinary Spanish trade sentences fired an output floor while
// 42 of 45 real Spanish promises escaped every one. Wrong in both directions at once.
//
// So Spanish ships with NARROWER coverage than English, stated plainly, rather than a wide net that
// hangs up on customers. A guard architecture is a claim about the language it guards.
//
// ═══ THE FAULTS THIS FILE EXISTS TO AVOID, all found by adversarial review of a first attempt ═══
//
// 1. ★ "chispeando" MEANS DRIZZLING. In Mexican and Central American Spanish `chispear` is light
//    rain. A first draft matched the stem `chisp\w*`, so a caller saying "está chispeando" (it is
//    drizzling) would have been told to evacuate. Sparks are matched only as `chispa(s)` the noun,
//    or `echando/haciendo chispas`, never the verb.
// 2. NEGATION FLIPS THE MEANING WITHOUT CHANGING THE WORDS. "no agarró fuego el calentador" is an
//    appliance that WOULD NOT light - a service call - and contains "agarró fuego". Every pattern
//    here is checked against a negation guard applied to the clause, not to a character window.
// 3. ACCENTS ARRIVE BOTH WAYS. ASR may emit precomposed (NFC) "monóxido" or decomposed (NFD) "o" +
//    U+0301. Input is normalised to NFC before matching, so `[oó]` classes actually work.
// 4. WHITESPACE IS NOT ONE SPACE. Literal " " in a pattern fails on a double space or a newline.
//    Every gap here is `\s+`.
// 5. ROTTEN EGGS NEXT TO WATER IS A WATER HEATER, NOT A GAS LEAK. "el agua huele a azufre" is an
//    anode rod or a sulfur well - routine, common, and the exact call this must not kill.
//    Sulfur/egg smells fire ONLY when no water word is present.
//
//    ★ AND ONE CASE WHERE I DELIBERATELY DISAGREE WITH THE REVIEW. It listed
//    "el calentador huele a huevo podrido" as a false positive. I have kept it FIRING, and the
//    dividing line is whether the caller says "de agua":
//
//        el agua huele a huevo podrido              -> routine   (the water is what smells)
//        el calentador DE AGUA huele a huevo podrido -> routine   (they named the water heater)
//        el calentador huele a huevo podrido         -> ENDS CALL (ambiguous)
//
//    Rotten egg IS the odorant deliberately added to natural gas, and a bare "calentador" in US
//    Spanish is as often a gas appliance as a water tank. The two errors are not symmetric: a false
//    hang-up costs one job and the caller rings back, a miss costs a house. When the caller has told
//    us it is the water, we believe them; when they have not, we do not guess in the direction that
//    only fails silently. This is the one place in the file where I chose lower precision on
//    purpose, and it is one case, not the thirty-four that made the water floor unshippable.
// 6. A DEAD DETECTOR IS A SERVICE CALL. "el detector de gas no está encendido" is somebody asking us
//    to fix a detector. A *gas* detector needs an alarm-sounding word; `monóxido` fires bare,
//    because a CO alarm IS the evidence and never needs confirming.

/** NFC-normalise and collapse whitespace, so the patterns below can assume one shape. */
export function normalise(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Words that, present in the same clause, mean the smell is plumbing rather than gas.
const WATER_CONTEXT = /\b(?:agua|drenaje|drena|tuber[ií]a|ca[ñn]er[ií]a|regadera|ducha|ba[ñn]o|ba[ñn]era|fregadero|lavabo|lavamanos|inodoro|escusado|excusado|taza|pozo|calent[oa]dor\s+de\s+agua|boiler|tinaco|cisterna|sumidero|tanque\s+s[eé]ptico|septico|s[eé]ptico)\b/i;

// A negation sitting in front of the hazard verb, which inverts it.
const NEGATED = /\b(?:no|nunca|jam[aá]s|tampoco|ya\s+no|sin)\b/i;

const SMELL = '(?:huel(?:e|es|o|en|a)|oliendo|ol[ií]a|oli[oó]|apesta|apestaba|hiede|olor(?:es)?)';

/** Each rule is a named pattern plus, optionally, a context that disqualifies it. */
const RULES = [
  // ── GAS ────────────────────────────────────────────────────────────────────────────────────────
  { by: 'gas-smell',   re: new RegExp(`${SMELL}(?:[^.!?]{0,20}?)\\ba?\\s*gas\\b`, 'i') },
  { by: 'gas-smell',   re: /\bolor(?:es)?\s+(?:a|de|del)\s+gas\b/i },
  { by: 'gas-smell',   re: /\bgas\b[^.!?]{0,12}?\b(?:apesta|hiede)\b/i },
  { by: 'gas-leak',    re: /\b(?:fugas?|escapes?)\s+(?:de|del)\s+gas\b/i },
  { by: 'gas-leak',    re: /\bse\s+(?:me\s+|nos\s+|le\s+)?(?:est[aá]\s+)?(?:saliendo|fugando|escapando|sale|sali[oó]|fuga|fug[oó]|escapa|escap[oó])\s+(?:el\s+)?gas\b/i },
  // Rotten eggs / sulfur: the pre-conclusion description. Disqualified by any water word.
  { by: 'gas-smell',   re: new RegExp(`${SMELL}[^.!?]{0,20}?\\bhuevos?\\s+(?:podridos?|descompuestos?)\\b`, 'i'), not: WATER_CONTEXT },
  { by: 'gas-smell',   re: new RegExp(`${SMELL}[^.!?]{0,20}?\\bazufre\\b`, 'i'), not: WATER_CONTEXT },

  // ── CARBON MONOXIDE. Fires bare: the alarm IS the evidence. ────────────────────────────────────
  { by: 'co',          re: /\bmon[oó]xidos?\b/i },
  { by: 'co',          re: /\bcarbon\s+monoxide\b/i },
  { by: 'co',          re: /\b(?:detector(?:es)?|alarmas?|sensor(?:es)?)\s+de\s+co\b/i },

  // ── A GAS DETECTOR needs an alarm word, or "quote me a gas detector" ends the call. ────────────
  { by: 'gas-alarm',   re: /\b(?:detector(?:es)?|alarmas?|sensor(?:es)?)\s+de\s+gas\b[^.!?]{0,24}?\b(?:sonando|suena|son[oó]|pitando|pita|pit[oó]|chillando|se\s+activ[oó]|no\s+para)\b/i },
  { by: 'gas-alarm',   re: /\b(?:sonando|suena|son[oó]|pitando|pita|pit[oó]|chillando|se\s+activ[oó])\b[^.!?]{0,24}?\b(?:detector(?:es)?|alarmas?|sensor(?:es)?)\s+de\s+gas\b/i },

  // ── FIRE ───────────────────────────────────────────────────────────────────────────────────────
  { by: 'fire',        re: /\bhay\s+(?:un\s+)?(?:fuego|incendio)\b/i },
  { by: 'fire',        re: /\bse\s+(?:me\s+|nos\s+|le\s+)?(?:est[aá]\s+)?(?:quemando|incendiando)\b/i },
  { by: 'fire',        re: /\bse\s+(?:me\s+|nos\s+|le\s+)?(?:prendi[oó]|agarr[oó])\s+fuego\b/i },
  { by: 'fire',        re: /\bagarr[oó]\s+fuego\b/i },
  // Burning smell. Disqualified by cooking words, which are the common false positive.
  { by: 'burning',     re: new RegExp(`${SMELL}\\s+a\\s+quemado\\b`, 'i'),
    not: /\b(?:comida|cocinando|cocin[eé]|quem[eé]|sart[eé]n|horno|estufa|carne|pan|tostada|asador|parrilla|carbon|le[ñn]a|chimenea|vela)\b/i },

  // ── SMOKE. Never bare: a smoke detector install and a backyard grill are routine. ──────────────
  { by: 'smoke',       re: /\b(?:sale|saliendo|sali[oó]|hay)\s+humo\b/i,
    not: /\b(?:chimenea|asador|parrilla|carbon|le[ñn]a|vela|incienso|cocinando|comida|cigarro|vecino)\b/i },
  { by: 'smoke',       re: /\bhumo\s+(?:por\s+todos\s+lados|en\s+toda\s+la\s+casa)\b/i },

  // ── ELECTRICAL. Sparks as a NOUN only; the verb means drizzling. ───────────────────────────────
  { by: 'electrical',  re: /\b(?:echando|haciendo|sacando|aventando)\s+chispas?\b/i },
  { by: 'electrical',  re: /\bchispas?\b[^.!?]{0,24}?\b(?:contacto|enchufe|apagador|interruptor|panel|breaker|cable|cables|caja\s+de\s+fusibles|toma\s?corriente)\b/i },
  { by: 'electrical',  re: /\b(?:contacto|enchufe|apagador|interruptor|panel|breaker|cable|cables|toma\s?corriente)\b[^.!?]{0,24}?\bchispas?\b/i },
  { by: 'electrical',  re: /\bme\s+(?:dio|di[oó])\s+(?:un\s+)?(?:toque|toques|choque|corrientazo)\b/i },
  { by: 'electrical',  re: /\bcorto\s?circuito\b/i },
];

/**
 * Does this caller turn report a hazard?
 * @returns {{hit:true, by:string}|{hit:false}}
 */
export function crisisEs(text) {
  const t = normalise(text);
  if (!t) return { hit: false };
  // Split on clause boundaries so a negation in one clause cannot excuse a hazard in another,
  // and so `not` contexts are judged on the clause that actually contains the match.
  const clauses = t.split(/(?:[.!?;]|\b(?:pero|aunque|y luego)\b)/i);
  for (const raw of clauses) {
    const c = raw.trim();
    if (!c) continue;
    for (const r of RULES) {
      if (!r.re.test(c)) continue;
      if (r.not && r.not.test(c)) continue;
      // ★ NEGATION IS CHECKED ON THE CLAUSE, NOT A CHARACTER WINDOW. "no agarró fuego el
      // calentador" is an appliance that would not light, which is a service call.
      if (NEGATED.test(c)) continue;
      return { hit: true, by: r.by };
    }
  }
  return { hit: false };
}

/** Every rule name, so a test can assert coverage without reading the array. */
export const CRISIS_ES_KINDS = [...new Set(RULES.map((r) => r.by))];
