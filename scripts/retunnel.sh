#!/usr/bin/env bash
#
# Puts the app back on a working public address.
#
# A free Cloudflare quick tunnel gets a new name every time it starts, and
# expires on its own - twice now the address in .env has outlived the tunnel it
# named, which looks like a broken agent from the outside. This re-points
# everything that holds a copy of that address:
#
#   .env                 the app, and the answer URL it hands Plivo per call
#   the web server       reads .env once, at startup
#   the agent worker     likewise, and it is the one nobody remembers
#
# Inbound calls do not come through here at all - the number hands them to
# LiveKit over SIP - but the worker still reaches the platform this way.
#
#   npm run tunnel
set -euo pipefail
cd "$(dirname "$0")/.."

LOG=/private/tmp/claude-502/cloudflared.log
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"

echo "→ restarting the tunnel"
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 2
nohup "$CLOUDFLARED" tunnel --url http://localhost:3000 > "$LOG" 2>&1 &

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "the tunnel did not come up; see $LOG"; exit 1; }
echo "  $URL"

echo "→ writing it to .env"
python3 - "$URL" <<'PY'
import pathlib, re, sys
url = sys.argv[1]
p = pathlib.Path('.env')
s = p.read_text()
p.write_text(re.sub(r'^APP_BASE_URL=.*$', f'APP_BASE_URL={url}', s, flags=re.M))
PY

echo "→ restarting the web server"
pkill -f "next dev" 2>/dev/null || true
sleep 2
nohup npm run dev >> /private/tmp/claude-502/next.log 2>&1 &
until curl -s -m 2 http://localhost:3000/api/health >/dev/null 2>&1; do sleep 1; done

echo "→ restarting the agent worker"
pkill -f "agent/worker.py" 2>/dev/null || true
sleep 2
nohup agent/.venv/bin/python agent/worker.py dev > /private/tmp/claude-502/agent.log 2>&1 &

echo "→ checking"
curl -s -m 15 -o /dev/null -w "  tunnel  HTTP %{http_code}\n" "$URL/api/health"
for _ in $(seq 1 30); do
  grep -q "registered worker" /private/tmp/claude-502/agent.log 2>/dev/null && break
  sleep 1
done
grep -q "registered worker" /private/tmp/claude-502/agent.log && echo "  worker  registered" || echo "  worker  NOT registered - see /private/tmp/claude-502/agent.log"
echo
echo "Ready. Calls in and out both work from here."
