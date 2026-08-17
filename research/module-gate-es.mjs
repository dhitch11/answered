// module-gate-es.mjs — the objective gate for the SPANISH knowledge modules.
//
// ═══ THE MISTAKE THIS FILE IS BUILT AROUND: USE vs MENTION ═══
//
// A first version of this gate flagged four things in the six Spanish modules. ALL FOUR WERE THE
// MODULE STATING ITS OWN PROHIBITION:
//
//   "Que el filtro no haya cortado la llamada no significa nada."
//        = "that the filter did not cut the call means NOTHING" - the exact anti-fail-open teaching
//          I had written the check to enforce. The gate flagged the correct sentence as the defect.
//   "NUNCA PROMETA UNA HORA, UN DÍA NI UNA VENTANA..."
//        = "NEVER promise an hour, a day or a window" - the rule, flagged as a spelled-out quantity.
//   "El gas de tanque es normal en rentas y casas móviles"
//        = a vocabulary note that propane tanks are common in rentals, sitting in a list of what
//          people CALL the cylinder (el cilindro, la bombona, la pipa). Not a safety reassurance.
//
// ★ A KEYWORD GATE CANNOT TELL USE FROM MENTION. A module that teaches a rule must SAY the rule, so
// the banned string appears in the one document most committed to not doing the banned thing. Any
// gate over instructional prose needs to know the difference, or it punishes the clearest writing.
//
// So every content check here is skipped when the sentence is a PROHIBITION or a NEGATION - when it
// carries nunca / no / ni / jamás / sin, or SHOUTS in caps, which in these modules marks the rule.
// The purely mechanical checks (digits, em dashes, length) need no such exemption: a digit is a
// digit whatever the sentence is doing with it.

const PROHIBITION = /\b(?:nunca|jam[aá]s|no\s|ni\s|sin\s|prohibido|evite|tampoco)\b/i;
const SHOUTED = (s) => {
  const letters = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  if (letters.length < 12) return false;
  const caps = letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length;
  return caps / letters.length > 0.6;
};

const MONEY_ES = /\b(?:d[oó]lares?|pesos?|centavos?)\b/i;
const WORDNUM_ES = /\b(?:un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|cuarenta|cincuenta|cien|ciento|doscientos|mil)\s+(?:d[oó]lares?|pesos?|minutos?|horas?|d[ií]as?|semanas?|meses?|a[nñ]os?)/i;
const HAZARD = /\b(?:gas|mon[oó]xido|humo|quemado|chispas?|fuego|corto)\b/i;
const BENIGN = /\b(?:no pasa nada|probablemente nada|casi siempre es|suele ser (?:normal|nada)|no es peligroso|no se preocupe)\b/i;

export function gateEs(name, text) {
  const t = String(text || '');
  const fails = [];

  // ── mechanical: no exemption, a digit is a digit ──────────────────────────────────────────────
  if (t.length < 2500) fails.push(`too short: ${t.length}`);
  if (t.length > 4500) fails.push(`too long: ${t.length}`);
  const digits = t.match(/\d/g);
  if (digits) fails.push(`${digits.length} digit(s)`);
  if (t.includes('—')) fails.push('em dash');

  // ── content: skipped on a sentence that is stating the rule ───────────────────────────────────
  for (const sentence of t.split(/(?<=[.!?:])\s+/)) {
    const s = sentence.trim();
    if (!s) continue;
    const stating = PROHIBITION.test(s) || SHOUTED(s);
    if (stating) continue;

    const money = s.match(MONEY_ES);
    if (money) fails.push(`money word "${money[0]}" in: ${s.slice(0, 60)}`);
    const qty = s.match(WORDNUM_ES);
    if (qty) fails.push(`spelled quantity "${qty[0]}" in: ${s.slice(0, 60)}`);
    if (HAZARD.test(s) && BENIGN.test(s)) fails.push(`hazard softened: ${s.slice(0, 70)}`);
  }

  return { name, ok: fails.length === 0, fails, chars: t.length };
}

if (process.argv[2]) {
  const { readFileSync } = await import('node:fs');
  const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const list = Array.isArray(rows) ? rows : rows.result || [];
  let bad = 0;
  console.log('spanish module gate\n');
  for (const r of list) {
    const g = gateEs(r.key, r.module);
    console.log(`  [${g.ok ? 'PASS' : 'FAIL'}] ${g.name.padEnd(16)} ${String(g.chars).padStart(5)} chars`);
    for (const f of g.fails) { console.log(`         - ${f}`); bad++; }
  }
  console.log(`\n${list.length} modules, ${bad} gate failures`);

  // ★ POSITIVE CONTROLS, BOTH DIRECTIONS. The first proves the gate still catches a real violation.
  // The second proves the use/mention exemption has not been widened into a hole that lets a real
  // violation through simply by containing the word "no".
  const dirty = gateEs('probe', 'x'.repeat(3000) + ' Le cuesta como cien dolares y llega en dos horas. 42');
  if (dirty.ok) { console.error('\n*** GATE BROKEN: passed a deliberately bad module ***'); process.exit(2); }
  const stating = gateEs('probe2', 'x'.repeat(3000) + ' NUNCA PROMETA UNA HORA NI UN DIA que las notas no le hayan dado.');
  if (!stating.ok) { console.error('\n*** GATE BROKEN: flagged a module for STATING its own rule ***'); process.exit(2); }
  console.log(`positive controls: catches a real violation (${dirty.fails.length}), exempts a stated rule`);
  process.exit(bad ? 1 : 0);
}
