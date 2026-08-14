#!/usr/bin/env bash
# with-env.sh — run a billing script with live credentials, without ever writing one to disk.
#
#   ./billing/with-env.sh node billing/serve.mjs
#   ./billing/with-env.sh node billing/live.test.mjs
#
# Same posture as research/with-env.sh, which this is modelled on: values are pulled from the
# Answered Netlify project at run time and exist only for the life of the child process. Nothing is
# echoed, nothing is cached, nothing lands in a file or a shell history entry.
#
# ANSWERED_BILLING_ARMED is deliberately NOT in this list. The one switch that lets code charge a
# real card on a live account should have to be typed, in front of you, on the command line.

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v netlify >/dev/null 2>&1; then
  echo "netlify CLI not found. npm i -g netlify-cli" >&2; exit 1
fi

NEEDED="ANSWERED_DB_URL ANSWERED_DB_ANON ANSWERED_DB_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ANSWERED_METER_SECRET URL"

ENV_JSON="$(netlify env:list --json 2>/dev/null)" || { echo "netlify env:list failed. Is this directory linked? (netlify link)" >&2; exit 1; }

EXPORTS="$(printf '%s' "$ENV_JSON" | NEEDED="$NEEDED" python3 -c '
import json, os, sys, shlex
data = json.load(sys.stdin)
out, missing = [], []
for name in os.environ["NEEDED"].split():
    v = data.get(name)
    if isinstance(v, dict):
        v = v.get("value") or v.get("values", [{}])[0].get("value")
    if v:
        out.append("export %s=%s" % (name, shlex.quote(str(v))))
    else:
        missing.append(name)
if missing:
    sys.stderr.write("not set on the Netlify project: %s\n" % ", ".join(missing))
print("\n".join(out))
')"

eval "$EXPORTS"
exec "$@"
