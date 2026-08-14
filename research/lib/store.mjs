// store.mjs — append-only JSONL ledgers. Nothing here ever overwrites a prior record.
//
// Four ledgers, deliberately separate files so a bug in one cannot corrupt another:
//   corpus.jsonl      businesses pulled from a public source, one per line
//   lookups.jsonl     every Twilio Lookup result, including the failures
//   calls.jsonl       every call attempt and its outcome, including the ones the gate refused
//   suppression.txt   one E.164 per line. Read by the gate. Nothing removes a line from it.
//
// The suppression list is the only file in this system a human is expected to edit by hand, and
// the only edit that makes sense is adding a line.

import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');

const paths = {
  corpus: join(DATA, 'corpus.jsonl'),
  lookups: join(DATA, 'lookups.jsonl'),
  calls: join(DATA, 'calls.jsonl'),
  suppression: join(DATA, 'suppression.txt'),
};

async function ensure() {
  if (!existsSync(DATA)) await mkdir(DATA, { recursive: true });
  if (!existsSync(paths.suppression)) {
    await writeFile(
      paths.suppression,
      '# One E.164 number per line. Nothing is ever removed from this file.\n'
      + '# Anyone who says stop, in any channel, in any wording, lands here within the minute.\n',
      'utf8',
    );
  }
}

export async function append(ledger, row) {
  await ensure();
  const line = JSON.stringify({ ...row, at: row.at || new Date().toISOString() });
  await appendFile(paths[ledger], `${line}\n`, 'utf8');
}

export async function read(ledger) {
  await ensure();
  if (!existsSync(paths[ledger])) return [];
  const text = await readFile(paths[ledger], 'utf8');
  return text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * ★ The writer appends "+15125550142  # caller said stop on call CA123 <timestamp>", and this
 * reader used to put the WHOLE annotated line into the Set. So `suppress.has('+15125550142')`
 * was false for every number ever suppressed: the file recorded the opt-out perfectly and the
 * gate could never match it. Strip the comment, keep only the number.
 */
export async function suppression() {
  await ensure();
  const text = await readFile(paths.suppression, 'utf8');
  return new Set(
    text.split('\n')
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean),
  );
}

export async function suppress(phone, why) {
  await ensure();
  await appendFile(paths.suppression, `${phone}  # ${why} ${new Date().toISOString()}\n`, 'utf8');
}

/** Latest lookup per number, so a re-run does not re-bill Twilio for numbers already classified. */
export async function lookupIndex() {
  const rows = await read('lookups');
  const idx = new Map();
  for (const r of rows) idx.set(r.phone, r);
  return idx;
}

/** How many times each number has been called in the trailing 30 days. */
export async function callCounts(at = new Date()) {
  const rows = await read('calls');
  const cutoff = at.getTime() - 30 * 24 * 60 * 60 * 1000;
  const counts = new Map();
  for (const r of rows) {
    if (!r.placed) continue;                       // refusals do not count against the cap
    if (new Date(r.at).getTime() < cutoff) continue;
    counts.set(r.phone, (counts.get(r.phone) || 0) + 1);
  }
  return counts;
}

export { paths };
