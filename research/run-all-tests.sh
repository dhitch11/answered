#!/usr/bin/env bash
# run-all-tests.sh — the one command, and it trusts EXIT CODES, not printed words.
#
# ★ WHY THIS FILE EXISTS. For most of 2026-08-17 I aggregated the suite with a shell loop that
# parsed each file's last line for "N passed, M failed". Every suite I had written prints that. The
# node:test suites do NOT: they print TAP. So `netlify/functions/lib/recover.test.mjs` FAILED with a
# real assertion, exited 1, and my aggregate counted it as 0 failures and reported the whole suite
# green.
#
# I spent the day cataloguing instruments that report success while the thing they describe did not
# happen, and my own test runner was one of them. It could not fail for the reason I thought it
# could, because it was reading prose instead of the one signal every runner agrees on.
#
# So: exit code is the verdict. A suite that exits non-zero fails this script, whatever it printed.
# Counts are still shown because they are useful, but they decide nothing.
#
#   usage: bash research/run-all-tests.sh

set -uo pipefail
cd "$(dirname "$0")/.."

# ★ CREDENTIALS, LOADED ONCE, ADDED 2026-08-17 BY @LANE-SEARCHLIGHT (additive; nothing above changed).
#
# The exit-code rewrite above was right and it immediately surfaced four red suites. Three of them
# were NOT failures. `spine-claim-concurrency`, `spine-worker` and `parley-settle` are INTEGRATION
# tests that talk to the live database, and run bare they die on
# `db not configured: ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET` before asserting
# anything. Given credentials all three exit 0.
#
# ★ SO THE RUNNER HAD THE SAME DISEASE IT WAS BUILT TO CURE, POINTING THE OTHER WAY. The old loop
# could not report a failure; this one could not tell a FAILURE from a test that never got to run.
# Both are one bug: an instrument that does not distinguish "the thing is broken" from "I could not
# look". A red suite nobody can fix is worse than a silent one, because it teaches the next person
# that red is the normal colour of this file.
#
# One `netlify env:list` for the whole run, not one per suite (41 round trips). Same source as
# research/with-env.sh: values live only in this process, never on disk.
if [ -z "${ANSWERED_DB_URL:-}" ] && command -v netlify >/dev/null 2>&1; then
  eval "$(netlify env:list --json 2>/dev/null | python3 -c '
import json, sys, shlex
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)
for name in ("ANSWERED_DB_URL ANSWERED_DB_ANON ANSWERED_DB_SECRET TWILIO_ACCOUNT_SID "
             "TWILIO_API_SID TWILIO_API_SECRET ELEVENLABS_API_KEY ANTHROPIC_API_KEY_LIVE "
             "ANSWERED_EL_AGENT_ID ANSWERED_ADMIN_KEY").split():
    v = data.get(name)
    if isinstance(v, dict): v = v.get("value") or (v.get("values") or [{}])[0].get("value")
    if v: print("export %s=%s" % (name, shlex.quote(str(v))))
' 2>/dev/null)"
fi
if [ -n "${ANSWERED_DB_URL:-}" ]; then
  echo "  credentials: loaded (integration suites will run)"
else
  echo "  credentials: NOT AVAILABLE — integration suites will report [skip], not [FAIL]"
fi
echo

files=$(ls research/*.test.mjs netlify/functions/lib/*.test.mjs 2>/dev/null)
total=0
failed=0
skipped=0
failing_names=""

for t in $files; do
  out=$(node "$t" 2>&1)
  code=$?

  # A suite that could not reach its dependency has not failed, it has not run. Saying otherwise is
  # the same lie in the other direction. This is matched on the thrown message, not on a filename
  # list, because a hardcoded list of "the integration ones" is a defect with a delay on it.
  # ...and the same for a suite the PRODUCT refused. truce.test.mjs creates deals, and truce caps
  # creates at 20/hour/IP. That cap is a control working correctly; a suite that hit it has not
  # found a defect and has not passed either. Calling it FAIL trains people to ignore the word.
  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q "db not configured\|that is a lot of deals from one place"; then
    skipped=$((skipped + 1))
    reason='needs credentials'
    printf '%s' "$out" | grep -q 'a lot of deals' && reason='rate-limited by the product; retry in an hour'
    printf '  [skip] %-52s %s\n' "$t" "$reason"
    continue
  fi
  # counts, for information only
  n=$(printf '%s' "$out" | grep -oE '^[0-9]+ passed' | grep -oE '^[0-9]+' | tail -1)
  [ -z "$n" ] && n=$(printf '%s' "$out" | grep -oE '^# pass [0-9]+' | grep -oE '[0-9]+' | tail -1)
  [ -z "$n" ] && n=0
  total=$((total + n))
  if [ "$code" -ne 0 ]; then
    failed=$((failed + 1))
    failing_names="$failing_names\n  $t (exit $code)"
    printf '  [FAIL] %-52s exit %s\n' "$t" "$code"
    printf '%s\n' "$out" | grep -E "AssertionError|MISSED|FALSE|not ok|FAIL " | head -4 | sed 's/^/         /'
  else
    printf '  [ ok ] %-52s %s assertions\n' "$t" "$n"
  fi
done

echo
echo "  suites: $(printf '%s\n' "$files" | wc -l | tr -d ' ')   assertions: $total   FAILING SUITES: $failed   skipped: $skipped"
# A skip is not free. It is a suite nobody is watching, so it gets said out loud every run.
[ "$skipped" -eq 0 ] || echo "  ⚠ $skipped suite(s) never ran. That is unverified, not passing."

# ★ POSITIVE CONTROL. A runner that cannot fail is not a runner. This proves the exit-code path
# works before the result above is trusted.
probe=$(mktemp /tmp/runner-probe-XXXX.mjs)
printf 'process.exit(3);\n' > "$probe"
node "$probe" >/dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "  *** RUNNER BROKEN: a module that exits 3 was read as success ***"
  rm -f "$probe"; exit 2
fi
rm -f "$probe"
echo "  positive control: a non-zero exit is detected"

[ "$failed" -eq 0 ] || { printf "\n  FAILING:%b\n" "$failing_names"; exit 1; }
