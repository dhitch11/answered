# Restoring the Answered database

Exported 2026-08-14T23:36:36.316595+00:00 by `scripts/dump-schema.mjs`. Postgres 17.6.

**81 migrations · 62 tables · 186 functions · 182 indexes · 5 triggers · 1 views · 0 policies.**

## What is in here

| file | what it is | when you want it |
|---|---|---|
| `migrations/` | every migration applied to production, verbatim, in order | rebuilding history, or auditing what changed when |
| `schema/schema.sql` | the database as it actually is now, as runnable DDL | rebuilding fast, or diffing prod against the repo |
| `schema/objects.json` | the same snapshot, machine readable | diffing in CI without parsing SQL |

**Structure only. There is no row data in this directory.** A schema export must never be able to
become a customer data export by accident, so the exporting functions do not select from a single
business table.

## To rebuild from nothing

1. Create a Postgres 17 database (a new Supabase project is fine).
2. Run `schema/schema.sql`. It is ordered: extensions, schemas, tables, constraints, indexes,
   views, functions, triggers.
3. Seed `private.app_secret` with the sha256 of your `ANSWERED_DB_SECRET`. **Nothing works
   without this** and it is deliberately not in this export, because it is the credential.
4. Point `ANSWERED_DB_URL` and `ANSWERED_DB_ANON` at the new project.
5. Verify with the negative path first: call any `sv_admin_*` RPC with a **wrong** secret and
   confirm it returns 404 or 403, not 200. A restore that works but does not refuse is worse than
   no restore.

## What this export deliberately does not contain

- **Row data.** Customers, calls, contacts, transcripts and billing rows are not here. Those are
  covered by the platform's own backups, which is a separate question and should be verified
  separately rather than assumed.
- **Secrets.** `ANSWERED_DB_SECRET`, the Stripe key, the Twilio pair and the Anthropic key live
  in the deploy environment. The only secret the database holds is stored as a hash.
- **The `quarantine` schema's contents.** Its structure is exported; the rows it holds are moved
  production records and are not part of the schema.

## What has actually been rehearsed, and what has not

A dump nobody has ever run is a file, not a backup. So this was tested rather than assumed, on
2026-08-14, into an empty Postgres 17 project:

**PROVEN.** The export's schema creation, table DDL and — the part most likely to break — the
dollar-quoted `SECURITY DEFINER` function bodies with `SET search_path` all executed verbatim
out of `schema.sql` with no hand editing. `SECURITY DEFINER` and `search_path` both survived the
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

Re-run `node scripts/dump-schema.mjs` after any migration and commit the diff. If the diff is
empty after a change landed, the export is broken and should be treated as such, not shrugged at.
The most useful property of this directory is that a code review can see a security-definer
function body change.
