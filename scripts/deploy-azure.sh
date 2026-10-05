#!/usr/bin/env bash
#
# Puts the portal on Azure App Service.
#
# The app ships as a standalone Next build - the server plus only the modules it
# actually traced - because a B1 instance should not be compiling anything. Two
# things this script exists to get right:
#
#   1. `next build` copies .env into the standalone output. That file holds the
#      live keys and a DATABASE_URL pointing at a laptop, so it is removed here.
#      Configuration on Azure comes from App Settings and nowhere else.
#   2. The migrations are read from disk at runtime, so they have to travel with
#      the bundle; `next build` has no reason to know that.
#
# Usage: npm run deploy
set -euo pipefail

RG="${AZURE_RESOURCE_GROUP:-rg-client-hub}"
APP="${AZURE_WEBAPP:-tc-attendance-99772}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cd "$ROOT"

echo "==> Building"
npm run build

echo "==> Assembling the bundle"
cp -R .next/standalone/. "$STAGE/"
cp -R .next/static "$STAGE/.next/static"
[ -d public ] && cp -R public "$STAGE/public"
mkdir -p "$STAGE/src/db"
cp -R src/db/migrations "$STAGE/src/db/migrations"
cp src/db/rls.sql "$STAGE/src/db/"
# The OCR language data. Without it tesseract reaches for a CDN at runtime.
cp -R tessdata "$STAGE/tessdata"

# Whatever Next decided to bring along, secrets do not go to a web server.
find "$STAGE" -maxdepth 1 -name '.env*' -delete
if find "$STAGE" -maxdepth 2 -name '.env*' -not -path '*/node_modules/*' | grep -q .; then
  echo "refusing to deploy: an .env file is still in the bundle" >&2
  exit 1
fi

echo "==> Zipping"
( cd "$STAGE" && zip -rq "$STAGE/../app.zip" . )
ZIP="$(cd "$STAGE/.." && pwd)/app.zip"

echo "==> Deploying to $APP"
# --clean wipes wwwroot before extracting. A zip deploy on its own only adds and
# overwrites, so anything a previous deploy left behind lives for ever - which is
# how a .env full of live keys, stripped from every bundle since, was still
# sitting on the server days later.
az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP" --type zip --clean true --only-show-errors >/dev/null
rm -f "$ZIP"

echo "==> Waiting for it to come up"
URL="https://$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$URL/api/health" || true)
  [ "$code" = "200" ] && { echo "healthy: $URL"; exit 0; }
  sleep 10
done

echo "still not healthy after five minutes - last response:" >&2
curl -s -m 20 "$URL/api/health" >&2 || true
exit 1
