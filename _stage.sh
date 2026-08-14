#!/usr/bin/env bash
# _stage.sh — build the deploy staging tree, and REFUSE to hand it over if it is
# missing something the last outage was caused by. It does not deploy. It prints
# the exact command to run when everything it can check has passed.
#
#   ./_stage.sh              stage into /tmp/answered-stage
#   ./_stage.sh /some/dir    stage somewhere else
#
# WHY THIS FILE EXISTS. On 2026-08-14 production served healthy:false from
# /api/demo-health, which meant every health gated call control on the site was
# hiding itself. The demo line was fine. The cause was packaging: @netlify/blobs
# was declared only in the repo root package.json, the house deploy runs
# `npm install` inside netlify/functions, and that directory had no
# package.json, so the install was a no-op that looked like a step. The
# scheduled canary imported the missing package at module scope and therefore
# never ran at all, which is why nothing ever went red: it was not failing, it
# was absent. A monitor that cannot start reads as health.
#
# So this script checks the two things that were silently wrong, by MEASURING
# them in the staged tree rather than trusting that a step ran:
#   1. @netlify/blobs actually RESOLVES from the staged netlify/functions
#      directory, verified with node's own resolver, not by looking for a folder.
#   2. the layout is MIRRORED, not flattened. cockpit.mjs imports across
#      directories (../../research/lib), so a flattened functions directory
#      breaks the console even though every file is present.

set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"
STAGE="${1:-/tmp/answered-stage}"

echo "staging $REPO -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/site"

# ── static site, mirrored, minus everything that must never be published ─────
# The exclude list is a RULE, not a list of the tools that happened to exist the
# day it was written. Naming each house script one by one meant a lane could add
# `_accounts-check.mjs` and it would ship to the public site, which is exactly
# what the check below caught. So: every underscore prefixed file is house
# tooling and is excluded, with `_redirects` carved back in because Netlify
# needs it, and every *.test.mjs is excluded because a test is not a page.
#
# Dotfiles go the same way, as a rule and not a list: `.terminal-claims.md` is
# the lanes talking to each other and it has no business on a public web server.
# `.well-known` is carved back in because that one is genuinely public.
rsync -a \
  --include '_redirects' --include '.well-known/' --include '.well-known/**' \
  --exclude '.*' --exclude '_*' --exclude '*.test.mjs' --exclude 'node_modules' \
  --exclude 'research' --exclude 'netlify' --exclude 'netlify.toml' \
  --exclude 'billing' --exclude 'docs' --exclude 'scripts' \
  --exclude 'package.json' \
  "$REPO"/ "$STAGE/site"/

# ── functions and their imports, LAYOUT PRESERVED ────────────────────────────
mkdir -p "$STAGE/netlify"
rsync -a --exclude 'node_modules' "$REPO/netlify/functions" "$STAGE/netlify"/
# research/lib only. research/data is real business contact data and is never
# deployed; the .gitignore says so and this says so again, in the one place
# where forgetting it would publish it.
mkdir -p "$STAGE/research"
rsync -a "$REPO/research/lib" "$STAGE/research"/
cp "$REPO/netlify.toml" "$STAGE/netlify.toml"

# ── the step that was a no-op ────────────────────────────────────────────────
echo "installing function dependencies in the staged tree"
( cd "$STAGE/netlify/functions" && npm install --omit=dev --no-audit --no-fund --silent )

# ── now MEASURE, do not assume ───────────────────────────────────────────────
fail=0

if node -e "require.resolve('@netlify/blobs',{paths:['$STAGE/netlify/functions']})" 2>/dev/null; then
  echo "  ok    @netlify/blobs resolves from the staged functions directory"
else
  echo "  FAIL  @netlify/blobs does NOT resolve from $STAGE/netlify/functions"
  echo "        This is the exact fault that took the site wide call gate red."
  fail=1
fi

if [ -f "$STAGE/netlify/functions/cockpit.mjs" ] && [ -d "$STAGE/research/lib" ]; then
  echo "  ok    layout mirrored: netlify/functions and research/lib are both in place"
else
  echo "  FAIL  layout is flattened or research/lib is missing; the cockpit will break on import"
  fail=1
fi

if [ -d "$STAGE/research/data" ]; then
  echo "  FAIL  research/data made it into the staging tree. That is real business contact data. Stop."
  fail=1
else
  echo "  ok    research/data is not in the staging tree"
fi

dotleak="$(cd "$STAGE/site" && ls -A | grep '^\.' | grep -v '^\.well-known$' || true)"
if [ -n "$dotleak" ]; then
  echo "  FAIL  these dotfiles would be published: $(echo $dotleak | tr '\n' ' ')"
  fail=1
else
  echo "  ok    no dotfiles in the publish directory"
fi

# ── DRIFT: a route that ships unmonitored is a route nobody will miss ───────
# Every path this site declares, whether in netlify.toml redirects or in a v2
# function's own `export const config = { path: ... }`, has to appear in the
# sweep list in lib/ops-status.mjs. Otherwise a lane adds an endpoint, it breaks
# six weeks later, and the operations page reports all green while it does.
# Paths carrying a :param or a * are skipped: a sweep cannot invent a valid
# token, and probing one with a made up value would be a fabricated test.
declare_paths="$(
  { grep -o 'from = "/[^"]*"' "$REPO/netlify.toml" | sed 's/from = //';
    grep -ho "path: *\[[^]]*\]\|path: *'[^']*'" "$REPO"/netlify/functions/*.mjs \
      | grep -o "'/[^']*'"; } | tr -d "\"'" | grep -v '[:*]' | sort -u
)"
unmonitored=""
for p in $declare_paths; do
  grep -q "path: '$p'" "$REPO/netlify/functions/lib/ops-status.mjs" || unmonitored="$unmonitored $p"
done
if [ -n "$unmonitored" ]; then
  echo "  FAIL  these live paths are not in the operations sweep:$unmonitored"
  echo "        Add them to ROUTES in netlify/functions/lib/ops-status.mjs so /internal/ops watches them."
  fail=1
else
  echo "  ok    every declared path is in the operations sweep"
fi

# Nothing that is not the public site may be published. The publish directory is
# what strangers can read, and a test file or a house tool in it is a leak, not
# an untidiness.
leaked="$(cd "$STAGE/site" && ls -A | grep -E '^_|\.test\.mjs$|^netlify\.toml$|^billing$|^docs$' | grep -v '^_redirects$' || true)"
if [ -n "$leaked" ]; then
  echo "  FAIL  these would be published to the public site: $(echo $leaked | tr '\n' ' ')"
  fail=1
else
  echo "  ok    the publish directory holds only the public site"
fi

# Every .mjs and .js function must at least parse. A syntax error here is a 502
# on a live route, and it is free to catch now.
broken="$(cd "$STAGE/netlify/functions" && for f in *.mjs; do node --check "$f" >/dev/null 2>&1 || echo "$f"; done)"
if [ -n "$broken" ]; then echo "  FAIL  these functions do not parse: $broken"; fail=1
else echo "  ok    every function parses"; fi

echo
if [ "$fail" -ne 0 ]; then
  echo "STAGING FAILED. Nothing was deployed. Fix the lines marked FAIL and run this again."
  exit 1
fi

cat <<EOF
Staging tree is ready and every check above passed.

Deploy it with, from OUTSIDE the repo:

  cd $STAGE && netlify deploy --prod \\
    --dir site --functions netlify/functions \\
    --site 2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3

Then, before you call it done:
  curl -s https://answered.reddenda.com/api/demo-health | head -c 400
  open https://answered.reddenda.com/internal/ops
EOF
