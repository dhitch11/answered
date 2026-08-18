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

files=$(ls research/*.test.mjs netlify/functions/lib/*.test.mjs 2>/dev/null)
total=0
failed=0
failing_names=""

for t in $files; do
  out=$(node "$t" 2>&1)
  code=$?
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
echo "  suites: $(printf '%s\n' "$files" | wc -l | tr -d ' ')   assertions: $total   FAILING SUITES: $failed"

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
