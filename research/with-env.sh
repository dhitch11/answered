#!/usr/bin/env bash
# with-env.sh — run a research script with live credentials, without ever writing one to disk.
#
#   ./research/with-env.sh node research/sweep.mjs --limit 500
#
# Values are pulled from the Answered Netlify project at run time and exist only for the life of
# the child process. Nothing is echoed, nothing is cached, nothing lands in a file or a shell
# history entry. If you find yourself wanting to paste a key into a .env to "make it easier",
# that is the moment this script exists to prevent.

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v netlify >/dev/null 2>&1; then
  echo "netlify CLI not found. npm i -g netlify-cli" >&2; exit 1
fi

NEEDED="TWILIO_ACCOUNT_SID TWILIO_API_SID TWILIO_API_SECRET CANARY_FROM_NUMBER ANSWERED_DEMO_NUMBER ELEVENLABS_API_KEY ANTHROPIC_API_KEY_LIVE ANSWERED_EL_AGENT_ID ANSWERED_DB_URL ANSWERED_DB_ANON ANSWERED_DB_SECRET RESEND_API_KEY ANSWERED_ADMIN_KEY"

# One API call, then pick out what we need. env:get per-variable would be N round trips.
ENV_JSON="$(netlify env:list --json 2>/dev/null)" || { echo "netlify env:list failed. Is this directory linked? (netlify link)" >&2; exit 1; }

EXPORTS="$(printf '%s' "$ENV_JSON" | NEEDED="$NEEDED" python3 -c '
import json, os, sys, shlex
data = json.load(sys.stdin)
out = []
missing = []
for name in os.environ["NEEDED"].split():
    v = data.get(name)
    if isinstance(v, dict):
        v = v.get("value") or v.get("values", [{}])[0].get("value")
    if v:
        out.append("export %s=%s" % (name, shlex.quote(str(v))))
    else:
        missing.append(name)
if missing:
    sys.stderr.write("warning: not set on the Netlify project: %s\n" % ", ".join(missing))
print("\n".join(out))
')"

eval "$EXPORTS"
exec "$@"
