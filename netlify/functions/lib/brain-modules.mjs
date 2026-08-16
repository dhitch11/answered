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

  // Recover: the money product. Triggers on the words of an unpaid invoice, from either side.
  ['recover', word([
    'invoices?', 'unpaid', 'past due', 'overdue', 'owes? me', 'owed',
    'collections?', 'chase payment', 'net thirty', 'net 30', 'outstanding balance',
    'never paid', 'has not paid', 'wont pay', 'receivables?',
  ]), 'recover.txt'],
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
export function modulesFor(said, loaded) {
  const text = String(said || '');
  if (!text.trim()) return [];
  const out = [];
  for (const [name, trigger, file] of MODULES) {
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
