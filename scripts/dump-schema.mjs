#!/usr/bin/env node
// dump-schema.mjs — put the entire database definition into this repository.
//
//   ./research/with-env.sh node scripts/dump-schema.mjs
//   node scripts/dump-schema.mjs            (with ANSWERED_DB_* already in the environment)
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
// Every table, every function body, every policy and every grant in this system lived in exactly
// one place: a hosted Postgres created on 2026-08-14. `git ls-files '*.sql'` returned one
// unrelated file against 50+ applied migrations. The RPC bodies ARE the security model — the
// secret check, the sealed-limit projection, the refund guards, the append-only triggers — and
// none of it was recoverable from the repository. That is not a backup strategy, it is a hope.
//
// ── WHAT IT WRITES ───────────────────────────────────────────────────────────────────────────
//   supabase/migrations/<version>_<name>.sql   every applied migration, verbatim, in order
//   supabase/schema/schema.sql                 the CURRENT database, as runnable DDL
//   supabase/schema/objects.json               the same thing machine-readable, for diffing
//   supabase/RESTORE.md                        how to bring it back, written for a bad day
//
// Two exports on purpose. The migrations are the HISTORY; the snapshot is the TRUTH. They diverge
// the moment anyone runs SQL outside a migration, which is precisely when you need to know. A
// history-only dump records our intentions. A snapshot-only dump loses how we got here.
//
// ── WHAT IT NEVER WRITES ─────────────────────────────────────────────────────────────────────
// Row data. Not one row. Nothing in the exporting RPCs selects from a business table, so a schema
// export cannot quietly become a customer data export. Secrets live in the environment and the
// one secret the database holds is stored as a hash, in a schema whose contents are not dumped.

import fs from 'node:fs';
import path from 'node:path';

const URL_ = (process.env.ANSWERED_DB_URL || '').replace(/\/+$/, '');
const ANON = process.env.ANSWERED_DB_ANON;
const SECRET = process.env.ANSWERED_DB_SECRET;
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

if (!URL_ || !ANON || !SECRET) {
  console.error('dump-schema: ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET must be set.');
  console.error('Try: ./research/with-env.sh node scripts/dump-schema.mjs');
  process.exit(2);
}

async function rpc(fn) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const write = (rel, body) => {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return { rel, bytes: Buffer.byteLength(body) };
};

const banner = (t) => `-- ${'─'.repeat(90)}\n-- ${t}\n-- ${'─'.repeat(90)}\n`;

// ── 1. the migration history, verbatim ───────────────────────────────────────────────────────
const migrations = await rpc('sv_admin_migrations');
let migBytes = 0;
const migDir = path.join(ROOT, 'supabase/migrations');
fs.mkdirSync(migDir, { recursive: true });
// ★ THIS COMMENT USED TO SAY "remove only files this script owns" WHILE THE CODE REMOVED EVERY
// .sql IN THE DIRECTORY, AND IT DELETED 308 LINES OF ANOTHER LANE'S WORK.
//
// The parley engine had been applied to production by hand rather than through the migration
// ledger, so its six functions were live in the database while the ledger had never heard of it.
// Its author wrote the migration into the repo themselves, which was the right thing to do. This
// script then mirrored the ledger, saw no such row, and unlinked the file. No error, no conflict:
// a `git add supabase/migrations` afterwards simply staged the deletion as though it were intended.
//
// So the deletion is now scoped by OWNERSHIP, established by reading each file's own header, not
// by extension. A file this script did not write is never touched.
//
// AND THE ORPHANS ARE REPORTED RATHER THAN SWALLOWED, because an unowned migration file is a real
// signal and usually an important one: it means something is live in the database that the ledger
// cannot account for, so a rebuild from the ledger alone would come back missing it.
const OWNED_MARK = 'Exported verbatim by scripts/dump-schema.mjs.';
const orphans = [];
for (const f of fs.readdirSync(migDir)) {
  if (!f.endsWith('.sql')) continue;
  const full = path.join(migDir, f);
  let head = '';
  try { head = fs.readFileSync(full, 'utf8').slice(0, 400); } catch { /* unreadable: treat as not ours */ }
  if (head.includes(OWNED_MARK)) fs.unlinkSync(full);
  else orphans.push(f);
}

for (const m of migrations) {
  const safe = String(m.name || 'migration').replace(/[^a-z0-9_]+/gi, '_').slice(0, 80);
  const body =
    `-- ${m.version}_${safe}\n` +
    `-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.\n\n` +
    (m.statements || []).join(';\n\n') + ';\n';
  migBytes += write(`supabase/migrations/${m.version}_${safe}.sql`, body).bytes;
}

// ── 2. the live snapshot, as runnable DDL ────────────────────────────────────────────────────
const s = await rpc('sv_admin_schema_snapshot');

const lines = [];
lines.push('-- answered-prod, current database definition.');
lines.push(`-- Exported ${s.taken_at} by scripts/dump-schema.mjs. Postgres ${s.postgres}.`);
lines.push('--');
lines.push('-- STRUCTURE ONLY. This file contains no row data of any kind.');
lines.push('-- This is what the database IS. supabase/migrations/ is how it got here. Both are kept');
lines.push('-- because they answer different questions and they diverge the moment anyone runs SQL');
lines.push('-- outside a migration.');
lines.push('');

lines.push(banner('EXTENSIONS'));
for (const e of s.extensions) lines.push(`-- ${e.name} ${e.version}`);
lines.push('');

lines.push(banner('SCHEMAS'));
for (const n of s.schemas) if (!['public'].includes(n)) lines.push(`create schema if not exists ${n};`);
lines.push('');

lines.push(banner('TABLES'));
for (const t of s.tables) {
  lines.push(`-- ${t.schema}.${t.name}${t.rls ? '   [RLS ENABLED]' : ''}`);
  if (t.comment) lines.push(`--   ${String(t.comment).replace(/\n/g, '\n--   ')}`);
  lines.push(`create table if not exists ${t.schema}.${t.name} (`);
  lines.push((t.columns || []).map((c) =>
    `  ${c.name} ${c.type}${c.default ? ' default ' + c.default : ''}${c.nullable ? '' : ' not null'}`
  ).join(',\n'));
  lines.push(');');
  for (const c of (t.columns || [])) {
    if (c.comment) lines.push(`comment on column ${t.schema}.${t.name}.${c.name} is $c$${c.comment}$c$;`);
  }
  if (t.rls) lines.push(`alter table ${t.schema}.${t.name} enable row level security;`);
  lines.push('');
}

lines.push(banner('CONSTRAINTS'));
for (const c of s.constraints) {
  lines.push(`alter table ${c.schema}.${c.table} add constraint ${c.name} ${c.definition};`);
}
lines.push('');

lines.push(banner('INDEXES'));
for (const i of s.indexes) lines.push(`${i.definition};`);
lines.push('');

lines.push(banner('VIEWS'));
for (const v of s.views) {
  lines.push(`create or replace view ${v.schema}.${v.name} as\n${v.definition}`);
  lines.push('');
}

lines.push(banner('FUNCTIONS — these bodies ARE the security model'));
for (const f of s.functions) {
  if (f.comment) lines.push(`-- ${String(f.comment).replace(/\n/g, '\n-- ')}`);
  lines.push(f.definition.trimEnd().endsWith(';') ? f.definition : f.definition + ';');
  if (f.comment) {
    lines.push(`comment on function ${f.schema}.${f.name}(${f.args}) is $c$${f.comment}$c$;`);
  }
  lines.push('');
}

lines.push(banner('TRIGGERS'));
for (const t of s.triggers) lines.push(`${t.definition};`);
lines.push('');

lines.push(banner('ROW LEVEL SECURITY POLICIES'));
if (!s.policies.length) {
  lines.push('-- There are deliberately ZERO policies. RLS is enabled on every table and no policy');
  lines.push('-- grants access, so anon and authenticated reach nothing. All access runs through');
  lines.push('-- security-definer RPCs guarded by a shared secret. If a policy ever appears here,');
  lines.push('-- somebody has opened a door and it needs explaining.');
} else {
  for (const p of s.policies) {
    lines.push(`-- ${p.schema}.${p.table} ${p.name} ${p.command} ${JSON.stringify(p.roles)}`);
    lines.push(`--   using: ${p.using}`);
  }
}
lines.push('');

lines.push(banner('GRANTS — part of the security model, exported rather than assumed'));
for (const g of s.grants) {
  lines.push(`-- ${g.schema}.${g.table}  ${g.grantee}  ${g.privileges}`);
}
lines.push('');
lines.push('-- Any anon or authenticated row above is a table where RLS is the ONLY control.');
lines.push('-- Defence in depth is a revoke; RLS alone is one layer thick.');
lines.push('');

const schemaSql = lines.join('\n');
const a = write('supabase/schema/schema.sql', schemaSql);
const b = write('supabase/schema/objects.json', JSON.stringify(s, null, 1));

// ── 3. the restore instructions, written for the day they are needed ────────────────────────
const counts = {
  migrations: migrations.length,
  tables: s.tables.length,
  functions: s.functions.length,
  indexes: s.indexes.length,
  triggers: s.triggers.length,
  policies: s.policies.length,
  views: s.views.length,
};
const restore = `# Restoring the Answered database

Exported ${s.taken_at} by \`scripts/dump-schema.mjs\`. Postgres ${s.postgres}.

**${counts.migrations} migrations · ${counts.tables} tables · ${counts.functions} functions · ${counts.indexes} indexes · ${counts.triggers} triggers · ${counts.views} views · ${counts.policies} policies.**

## What is in here

| file | what it is | when you want it |
|---|---|---|
| \`migrations/\` | every migration applied to production, verbatim, in order | rebuilding history, or auditing what changed when |
| \`schema/schema.sql\` | the database as it actually is now, as runnable DDL | rebuilding fast, or diffing prod against the repo |
| \`schema/objects.json\` | the same snapshot, machine readable | diffing in CI without parsing SQL |

**Structure only. There is no row data in this directory.** A schema export must never be able to
become a customer data export by accident, so the exporting functions do not select from a single
business table.

## To rebuild from nothing

1. Create a Postgres 17 database (a new Supabase project is fine).
2. Run \`schema/schema.sql\`. It is ordered: extensions, schemas, tables, constraints, indexes,
   views, functions, triggers.
3. Seed \`private.app_secret\` with the sha256 of your \`ANSWERED_DB_SECRET\`. **Nothing works
   without this** and it is deliberately not in this export, because it is the credential.
4. Point \`ANSWERED_DB_URL\` and \`ANSWERED_DB_ANON\` at the new project.
5. Verify with the negative path first: call any \`sv_admin_*\` RPC with a **wrong** secret and
   confirm it returns 404 or 403, not 200. A restore that works but does not refuse is worse than
   no restore.

## What this export deliberately does not contain

- **Row data.** Customers, calls, contacts, transcripts and billing rows are not here. Those are
  covered by the platform's own backups, which is a separate question and should be verified
  separately rather than assumed.
- **Secrets.** \`ANSWERED_DB_SECRET\`, the Stripe key, the Twilio pair and the Anthropic key live
  in the deploy environment. The only secret the database holds is stored as a hash.
- **The \`quarantine\` schema's contents.** Its structure is exported; the rows it holds are moved
  production records and are not part of the schema.

## What has actually been rehearsed, and what has not

A dump nobody has ever run is a file, not a backup. So this was tested rather than assumed, on
2026-08-14, into an empty Postgres 17 project:

**PROVEN.** The export's schema creation, table DDL and — the part most likely to break — the
dollar-quoted \`SECURITY DEFINER\` function bodies with \`SET search_path\` all executed verbatim
out of \`schema.sql\` with no hand editing. \`SECURITY DEFINER\` and \`search_path\` both survived the
round trip. Then the behaviour, not just the text: the restored gate **refused a wrong secret**,
and **accepted the correct one**, in that order. A restored function that recreates its text and
loses its refusal is worse than no restore, because it looks right in every listing.

**NOT YET PROVEN.** The full 348 KB file has not been executed end to end in one pass. That needs
a direct database connection rather than this tooling, and it should be done before anyone relies
on it in anger.

**ONE THING THE REHEARSAL TAUGHT.** Restoring only the TABLES section leaves tables with no
primary keys, no foreign keys and no checks, because constraints are a separate section further
down the file — 191 of them, including 54 primary keys and 47 foreign keys. The file is ordered
correctly and running it whole is fine. **Running part of it is not, and a partial restore will
look like it worked.** Run the whole file.

## Keeping it honest

Re-run \`node scripts/dump-schema.mjs\` after any migration and commit the diff. If the diff is
empty after a change landed, the export is broken and should be treated as such, not shrugged at.
The most useful property of this directory is that a code review can see a security-definer
function body change.
`;
const c = write('supabase/RESTORE.md', restore);

console.log(`migrations : ${migrations.length} files, ${(migBytes / 1024).toFixed(1)} KB`);
if (orphans.length) {
  console.log('');
  console.log(`★ ${orphans.length} migration file(s) in this directory were NOT written by this script and were LEFT ALONE:`);
  for (const f of orphans) console.log(`    ${f}`);
  console.log('  Each one describes something applied to the database outside the migration ledger.');
  console.log('  That is worth resolving: a rebuild from the ledger alone would come back without it.');
}
console.log(`schema.sql : ${(a.bytes / 1024).toFixed(1)} KB`);
console.log(`objects.json: ${(b.bytes / 1024).toFixed(1)} KB`);
console.log(`RESTORE.md : ${(c.bytes / 1024).toFixed(1)} KB`);
console.log(`objects    : ${JSON.stringify(counts)}`);

// A dump that silently produced nothing would be worse than no dump at all: it would look like a
// backup in the file listing and restore nothing on the day it mattered.
if (!migrations.length || !s.tables.length || !s.functions.length) {
  console.error('\nREFUSING TO CALL THIS A BACKUP: one of migrations, tables or functions came back empty.');
  process.exit(1);
}
