// brain-modules.mjs — the knowledge Thomas loads only when the caller reaches for it.
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT ONE BIG PROMPT ────────────────────────────────────────
//
// David: "There are multiple brains built out for him... create more brains that are relevant to
// answering in every way regarding every different type of contractor, the trends, and the different
// type of work they do. Even if it's a hundred brains."
//
// A hundred brains cannot be one prompt. The Futureful line solved this already and this is the same
// mechanism in this codebase's idiom: a small always-on core, plus modules that append ONCE, mid-call,
// the moment the caller says something that makes them relevant. A roofing caller gets the roofing
// knowledge; a caller talking about their kid's schedule gets the human range; nobody pays the token
// cost of knowledge they never needed.
//
// ★ APPEND ONCE, NEVER TWICE. A module that re-appends every turn burns the context window and makes
// the model repeat itself, which is the single most machine-like thing a voice can do. `loaded` is the
// whole state.
//
// ★ THE TRIGGERS ARE WORD-BOUNDED ON PURPOSE. An unbounded /heat/ matches "heather" and "wheat", and a
// module that loads on the wrong word is worse than one that never loads: it puts roofing knowledge in
// front of a plumbing call and the model will use it.
//
// ★ WHAT THIS FILE IS NOT. It is not the voice wiring. It changes what Thomas KNOWS, never how he
// sounds, how fast he speaks, or when he takes a turn. David was explicit that the wiring is not to be
// touched, and nothing here reaches it.

// ★ IMPORTED, NOT READ FROM DISK. These were .txt files read with fs, and a real phone call proved
// the bundler cannot see a runtime file read: the live function logged ENOENT and shipped with no
// knowledge in it. An imported string cannot go missing — if it did, the bundle would not build.
import { TEXT } from './brain-text.mjs';

/**
 * name → [trigger, filename]
 *
 * Order is not significance: every module whose trigger matches on a turn is appended on that turn.
 * Keep triggers narrow. The cost of a false positive is real and the cost of a false negative is a
 * caller who did not get knowledge that existed, which is recoverable on the next turn.
 */
// ★ BUILT FROM ARRAYS, NOT WRITTEN AS ONE LONG LITERAL. A JS regex literal cannot span lines the way
// Python's verbose mode can, and a 400-character single-line alternation is unreviewable — which is
// how a wrong word gets into a trigger and nobody sees it. One term per line, joined at load.
const word = (terms) => new RegExp(`\\b(?:${terms.join('|')})\\b`, 'i');

export const MODULES = [
  // ★ SAFETY IS FIRST IN THIS LIST ON PURPOSE. Modules append in array order, so when a caller says
  // something that is both a hazard and a job ("I smell gas near the furnace" hits safety AND trades),
  // the hazard knowledge lands in the prompt ahead of the scheduling knowledge. Do not reorder.
  //
  // ★ NOTE WHAT IS *NOT* IN THIS TRIGGER: the bare word "gas". A trades line takes gas furnace, gas
  // line, gas water heater and gas fireplace calls all day, and every one of them is routine work. An
  // unqualified /gas/ would load hazard knowledge into hundreds of ordinary bookings and teach the
  // model to treat a furnace tune-up as an evacuation. Gas only counts here WITH a smell or leak word
  // attached, which is how a person in actual danger says it.
  ['safety', word([
    // gas, only ever in a smell/leak context
    'smells? (?:like )?gas', 'smell(?:ing|ed)? gas', 'gas leak\\w*', 'leaking gas', 'smell of gas',
    'gas smell', 'rotten eggs?', 'sulfur smell', 'smells? like sulfur',
    // carbon monoxide — the alarm IS the evidence
    'carbon monoxide', 'co detector', 'co alarm', 'monoxide',
    // fire and electrical
    'on fire', 'fire', 'smoke', 'smoking', 'burning smell', 'smells? (?:like )?burning',
    'shocked me', 'electrocut\\w*',
  ]), 'safety.txt'],

  // The trades. THE module for this product: it fires on the words a homeowner actually uses when
  // something has gone wrong, which are rarely the words a tradesman would use.
  ['trades', word([
    'plumb\\w*', 'water heater', 'tankless', 'hot water', 'leak\\w*', 'burst', 'pipes?', 'drains?',
    'sewer', 'backing up', 'backed up', 'toilet', 'faucet', 'sump',
    'hvac', 'furnace', 'heat pump', 'air condition\\w*', 'ac unit', 'a/c', 'cooling', 'no heat',
    'thermostat', 'duct\\w*', 'condenser', 'coil',
    'electric\\w*', 'breaker', 'panel', 'outlet', 'wiring', 'sparking', 'burning smell',
    'roof\\w*', 'shingles?', 'gutters?', 'flashing', 'storm damage',
    'garage door', 'opener',
  ]), 'trades.txt'],

  // The human range. Ordinary life — and on this line the weather is not ordinary, it is the job.
  ['human_range', word([
    'weather', 'rain\\w*', 'storm', 'snow', 'freez\\w*', 'frozen', 'heat wave', 'hot out', 'cold out',
    'wind\\w*',
    'kids?', 'son', 'daughter', 'wife', 'husband', 'partner', 'family', 'mom', 'mother', 'dad', 'father',
    'dinner', 'lunch', 'coffee', 'food', 'eat', 'eating',
    'game', 'team', 'playoffs', 'music', 'shift',
    // 'season' was here and my own test caught it firing on "wheat season" — the exact false
    // positive this file's header warns about, committed in the same file. Dropped: 'game',
    // 'team' and 'playoffs' already carry the sports read without it.
  ]), 'human_range.txt'],

  // Hold: the consumer product. Triggers on the institutions people dread ringing and on the
  // language of being stuck in a queue.
  ['hold', word([
    'on hold', 'hold for me', 'queue', 'call cent(?:er|re)', 'customer service',
    'dmv', 'irs', 'social security', 'medicaid', 'medicare', 'unemployment', 'passport',
    'airline', 'insurance company', 'the bank', 'utility company', 'cable company',
    'transferred', 'been on the phone', 'wait time', 'hung up on me',
  ]), 'hold.txt'],

  // ── ADDED 2026-08-16 ────────────────────────────────────────────────────────────────────────
  // Six modules, drafted and put through two adversarial review rounds and an objective gate
  // (research/module-gate.mjs). Their triggers were proposed by the reviewers and then attacked by
  // them for false positives, which is where most of these exclusions come from.

  // The price question. THE commonest opening sentence on a trades line, and the one where the
  // voice most wants to invent a number.
  ['money', word([
    'how much', 'what do you charge', 'whats? the (?:rate|charge|cost|price)', 'price', 'pricing',
    'cost', 'quote', 'estimate', 'ballpark', 'service charge', 'trip charge', 'call ?out fee',
    'diagnostic fee', 'free estimate', 'covered by (?:insurance|warranty)', 'home warranty',
    'deductible', 'too expensive', 'cheaper',
  ]), 'money.txt'],

  // What makes a booking usable by the tech who has to drive to it.
  // NOT triggered on a bare 'address' or 'name': those appear in almost every call.
  ['scheduling', word([
    'book', 'booking', 'schedule', 'appointment', 'come out', 'send someone', 'send somebody',
    'available', 'availability', 'what time', 'today', 'tomorrow', 'this week', 'gate code',
    'buzzer', 'apartment number', 'unit number', 'nobody(?:s| is)? home', 'i(?:ll| will) be home',
  ]), 'scheduling.txt'],

  // The caller who is already angry. Not a new job: a callback about one that went wrong.
  ['upset', word([
    'complain\\w*', 'unacceptable', 'ridiculous', 'furious', 'angry', 'upset',
    'never showed', 'didnt show', 'did not show', 'no ?show', 'still not fixed', 'came back',
    'overcharged', 'rip ?off', 'refund', 'money back', 'lawyer', 'attorney', 'bbb',
    'leave a review', 'bad review', 'third time', 'speak to the owner', 'talk to the owner',
  ]), 'upset.txt'],

  // What breaks when. The seasonal shape of a trades line, which is what David meant by the trends.
  // ★ 'season' is NOT in this list. My own test caught it firing on "wheat season" in the
  // human_range module, and the same trap applies here.
  ['seasonal', word([
    'first (?:cold|freeze|frost)', 'hard freeze', 'freeze warning', 'cold snap', 'heat ?wave',
    'busy season', 'this time of year', 'every (?:winter|summer|spring|fall)',
    'holiday', 'thanksgiving', 'christmas', 'new years?',
    'storm damage', 'after the storm', 'since the rain', 'when it rains',
  ]), 'seasonal.txt'],

  // The caller who is not the homeowner. A different register and a different authorization question.
  ['property', word([
    'tenant', 'renter', 'i rent', 'my landlord', 'the landlord', 'property manag\\w*',
    'management company', 'realtor', 'real estate agent', 'closing', 'inspection report',
    'general contractor', '\\bgc\\b', 'work order', 'the owner of the (?:building|property)',
    // ★ PLURALS. 'rental property' as a bare phrase does not match "rental properties", because the
    // trailing \b in the built pattern requires a word boundary right after "property". A landlord
    // with more than one is the commonest kind of landlord, so the plural was the likelier phrasing
    // and it was the one that missed. Caught by a test, not on a call.
    'one of (?:my|our) (?:\\w+ )?(?:properties|property|units|buildings)',
    // ★ AND 'my property' IS NOT HERE, though it looks like the obvious sibling. A homeowner says
    // "my property line", "the back of my property", "on my property" constantly. Adding it put
    // landlord knowledge in front of a homeowner with a broken sprinkler on the first test run.
    // "rental" is the word that actually carries the meaning; "property" alone does not.
    'rental propert(?:y|ies)',
  ]), 'property.txt'],

  // The trades the first module does not cover.
  ['trades_two', word([
    'fridge', 'refrigerator', 'freezer', 'washer', 'dryer', 'dishwasher', 'oven', 'stove', 'range',
    'appliance',
    'septic', 'leach field', 'drain ?field', 'well pump', 'well water',
    'pool', 'spa', 'hot tub', 'chlorine',
    'locked out', 'lock ?smith', 'rekey', 'lost my key',
    'pest', 'exterminat\\w*', 'termites?', 'roaches?', 'rodents?', 'bed bugs?',
    'tree', 'stump', 'landscap\\w*', 'irrigation', 'sprinkler',
    'concrete', 'masonry', 'driveway', 'foundation crack',
    'drywall', 'flooring', 'water damage',
  ]), 'trades_two.txt'],

  // Recover: the money product. Triggers on the words of an unpaid invoice, from either side.
  ['recover', word([
    'invoices?', 'unpaid', 'past due', 'overdue', 'owes? me', 'owed',
    'collections?', 'chase payment', 'net thirty', 'net 30', 'outstanding balance',
    'never paid', 'has not paid', 'wont pay', 'receivables?',
  ]), 'recover.txt'],

  // ── SPANISH ────────────────────────────────────────────────────────────────────────────────────
  // Every entry carries the 'es' tag, which is what keeps it off an English call and keeps the
  // English modules off a Spanish one.
  //
  // ★ NOTE WHAT IS ABSENT FROM THE SAFETY TRIGGER: the clearest hazard phrasings are handled by
  // lib/crisis-es.mjs BEFORE the model runs, and that floor ENDS the call. This module is the narrow
  // band the floor cannot catch - somebody describing something worrying in words the floor does not
  // know, or minimising it - so it fires on the MINIMISER, not on the hazard.
  ['safety_es', word([
    'no creo que sea nada', 'ha de ser nada', 'es poquito', 'poquito nada m[aá]s', 'siempre lo hace',
    'ya lleva d[ií]as as[ií]', 'no es para tanto', 'de seguro no es nada', 'me da pena molestar',
    'huele raro', 'huele feo', 'algo raro', 'ruido raro', 'me preocupa',
  ]), 'safety_es.txt', 'es'],

  ['trades_es', word([
    'se tap[oó]', 'tapado', 'no baja', 'destapar', 'drenaje', 'ca[ñn]o', 'fregadero', 'lavabo',
    'lavamanos', 'inodoro', 'escusado', 'excusado', 'regadera', 'ducha', 'tina', 'ba[ñn]era',
    'calentador', 'calent[oó]n', 'b[oó]iler', 'agua caliente', 'gotea', 'llave', 'grifo', 'pluma',
    'tuber[ií]a', 'tubo', 'fuga',
    'no enfr[ií]a', 'no calienta', 'el aire', 'clima', 'aire acondicionado', 'minisplit',
    'calefacci[oó]n', 'termostato',
    'breaker', 'pastilla', 'se bot[oó]', 'se brinc[oó]', 'contacto', 'enchufe', 'tomacorriente',
    'apagador', 'foco', 'bombillo', 'se fue la luz', 'parpadean',
    'techo', 'tejas', 'gotera', 'se meti[oó] el agua', 'filtrando',
    'lavadora', 'secadora', 'refri', 'nevera', 'refrigerador', 'estufa', 'horno', 'lavaplatos',
  ]), 'trades_es.txt', 'es'],

  ['human_range_es', word([
    'llov(?:i[oó]|iendo)', 'lluvia', 'fr[ií]o', 'calor', 'helada', 'chispea\\w*', 'granizo',
    'tormenta', 'viento', 'clima',
    'mi esposa', 'mi esposo', 'mi mam[aá]', 'mi pap[aá]', 'los ni[ñn]os', 'mi hijo', 'mi hija',
    'la familia', 'el trabajo', 'ando ocupado', 'ando manejando', 'en la obra',
  ]), 'human_range_es.txt', 'es'],

  ['money_es', word([
    'cu[aá]nto', 'cu[aá]nto cobran', 'cu[aá]nto cuesta', 'precio', 'costo', 'cotizaci[oó]n',
    'presupuesto', 'aproximado', 'la visita', 'el viaje', 'cobran por venir', 'muy caro',
    'm[aá]s barato', 'seguro lo cubre', 'garant[ií]a', 'el due[ñn]o paga', 'el landlord',
  ]), 'money_es.txt', 'es'],

  ['scheduling_es', word([
    'cita', 'agendar', 'programar', 'cu[aá]ndo pueden', 'cu[aá]ndo viene', 'a qu[eé] hora',
    'hoy', 'ma[ñn]ana', 'esta semana', 'puede venir', 'mandar a alguien', 'mi direcci[oó]n',
    'el port[oó]n', 'el c[oó]digo', 'el perro', 'el timbre', 'no hay nadie', 'voy a estar',
  ]), 'scheduling_es.txt', 'es'],

  ['upset_es', word([
    'queja', 'me quejo', 'inaceptable', 'es el colmo', 'estoy molesto', 'estoy enojad[oa]',
    'nunca vinieron', 'no lleg[oó] nadie', 'no vino nadie', 'ya van (?:dos|tres) veces',
    'sigue igual', 'me cobraron de m[aá]s', 'reembolso', 'mi dinero', 'abogado', 'una rese[ñn]a',
    'quiero hablar con el due[ñn]o',
  ]), 'upset_es.txt', 'es'],
];

// Read once per process. These files are small and immutable at runtime; re-reading them per turn
// would put disk latency inside a conversation, which is exactly where it must never be.
function read(file) {
  const key = String(file).replace(/\.txt$/, '');
  const text = TEXT[key];
  if (typeof text === 'string' && text.length) return text;
  {
    const e = new Error(`no exported module named "${key}" in brain-text.mjs`);
    // ★ A MISSING MODULE IS A LOGGED ABSENCE, NEVER A CRASH AND NEVER A SILENT EMPTY STRING.
    // Silent-empty is how a brain gets deployed with no knowledge in it and nobody notices for a
    // week, which is this estate's dominant failure. The call continues without the module.
    console.error(`brain-modules: ${file} could not be read, so that knowledge is NOT in this call: ${String(e && e.message).slice(0, 120)}`);
  }
  return '';
}

/**
 * Watches what the caller says and returns the modules that should be appended THIS turn.
 *
 * @param {string} said        the caller's turn
 * @param {Set<string>} loaded module names already appended in this call, mutated here
 * @returns {{name:string, text:string}[]}
 */
/**
 * @param {string} said        the caller's turn
 * @param {Set<string>} loaded modules already appended in this call, mutated here
 * @param {string} [lang]      'en' or 'es'. Defaults to 'en'.
 *
 * ★ LANGUAGE SCOPING IS NOT COSMETIC. Several trigger words are shared across the two languages -
 * "gas", "breaker", "AC", "no heat" all appear in US Spanish speech - so without scoping an ENGLISH
 * module loads on a Spanish call and the voice gets four thousand characters of English knowledge
 * mid-sentence. The reverse is rarer but no better. A module declares its language and only its
 * language's calls can load it.
 */
export function modulesFor(said, loaded, lang = 'en') {
  const text = String(said || '');
  if (!text.trim()) return [];
  const out = [];
  for (const [name, trigger, file, moduleLang = 'en'] of MODULES) {
    if (moduleLang !== lang) continue;
    if (loaded.has(name)) continue;
    if (!trigger.test(text)) continue;
    const body = read(file);
    if (!body) continue;              // an unreadable module is not "loaded"; it may succeed later
    loaded.add(name);
    out.push({ name, text: body });
  }
  return out;
}

/** Every module name, for a health page that wants to prove the knowledge is actually on disk. */
export function moduleHealth() {
  return MODULES.map(([name, , file]) => {
    const body = read(file);
    return { name, file, bytes: body.length, ok: body.length > 0 };
  });
}
