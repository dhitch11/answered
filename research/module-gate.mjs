// module-gate.mjs — the objective stopping rule for knowledge modules.
//
// Three review rounds produced diminishing returns: round 1 found ~40 issues, round 2 found 24 of
// which 21 were NEW, introduced by the fixing itself. Prose of this length does not converge by
// iteration, because every edit perturbs the text around it. So the decision to ship is not "a
// reviewer is finally happy" — it is this gate, which checks the things that are actually checkable
// and does not have an opinion about anything else.
//
// ★ THE CALLBACK CHECK IMPORTS THE SHIPPED REGEX rather than re-declaring one. A gate that
// re-implements the rule it is checking can pass a module the runtime will then cut off mid-sentence.

import { readFileSync } from 'node:fs';
import { PERSONAS } from '../netlify/functions/lib/personas.mjs';

const CALLBACK_RE = (PERSONAS.customer.outFloors || []).find((f) => f.by === 'callback-promise').re;

// Spelled-out money and durations evade a digit scan, and are worse than a numeral because they
// model the voice SAYING a figure out loud. This list is the one that actually showed up in drafts.
const WORD_NUM = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred|thousand)\b/i;
const MONEY_WORD = /\b(?:dollars?|bucks|cents)\b/i;

// A module may hand a hazard off. It may not diagnose one as benign, which is the failure that puts
// a reassuring sentence in front of a caller standing in a house that is filling with gas.
const HAZARD_BENIGN = /\b(?:startup smell|burn(?:ing|s) off|normal(?:ly)? (?:for|when)|probably (?:just|nothing|fine)|usually (?:harmless|nothing|fine)|common (?:in|when)|nothing to worry)\b/i;
const HAZARD_WORDS = /\b(?:gas|carbon monoxide|smoke|sparking|burning smell)\b/i;

export function gate(name, text) {
  const t = String(text || '');
  const fails = [];

  if (t.length < 2500) fails.push(`too short: ${t.length} chars`);
  if (t.length > 4500) fails.push(`too long: ${t.length} chars`);

  const digits = t.match(/\d/g);
  if (digits) fails.push(`contains ${digits.length} digit(s): ${[...new Set(digits)].join('')}`);

  if (MONEY_WORD.test(t)) fails.push(`money word: "${t.match(MONEY_WORD)[0]}"`);

  // Word-numbers are only a problem next to money or a duration. "one question at a time" is fine.
  for (const m of t.matchAll(new RegExp(WORD_NUM.source + '\\s+(?:dollars?|bucks|years?|months?|weeks?|days?|hours?|minutes?)', 'gi'))) {
    fails.push(`spelled-out quantity: "${m[0]}"`);
  }

  if (t.includes('—')) fails.push('em dash present');

  // The callback floor, using the SHIPPED pattern.
  for (const line of t.split(/(?<=[.!?])\s+/)) {
    if (!CALLBACK_RE.test(line)) continue;
    // A promise is allowed only when the same sentence carries the notes condition.
    if (!/\b(?:if|when|unless|only)\b[^.]*\bnotes?\b/i.test(line) && !/\bnotes?\b[^.]*\b(?:say|carry|give|authorize)/i.test(line)) {
      fails.push(`unconditioned callback promise: "${line.trim().slice(0, 90)}"`);
    }
  }

  // Hazard softening: a benign-cause phrase in the same sentence as a hazard word.
  for (const line of t.split(/(?<=[.!?])\s+/)) {
    if (HAZARD_WORDS.test(line) && HAZARD_BENIGN.test(line)) {
      fails.push(`hazard softened: "${line.trim().slice(0, 90)}"`);
    }
  }

  return { name, ok: fails.length === 0, fails, chars: t.length };
}

// ── run against a JSON file of {key, module} ─────────────────────────────────────────────────────
if (process.argv[2]) {
  const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const list = Array.isArray(rows) ? rows : rows.result || [];
  let bad = 0;
  console.log('module gate\n');
  for (const r of list) {
    const g = gate(r.key, r.module);
    console.log(`  [${g.ok ? 'PASS' : 'FAIL'}] ${g.name.padEnd(12)} ${String(g.chars).padStart(5)} chars`);
    for (const f of g.fails) { console.log(`         - ${f}`); bad++; }
  }
  console.log(`\n${list.length} modules, ${bad} gate failures`);

  // POSITIVE CONTROL: the gate must be able to fail.
  const probe = gate('probe', 'x'.repeat(3000) + ' I will have them call you back. It costs about a hundred dollars. 42');
  if (probe.ok) { console.error('\n*** GATE IS BROKEN: it passed a deliberately bad module ***'); process.exit(2); }
  console.log(`positive control: gate correctly rejected a bad module (${probe.fails.length} reasons)`);
  process.exit(bad ? 1 : 0);
}
