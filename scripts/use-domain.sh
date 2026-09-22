#!/usr/bin/env bash
# Move the bot's public identity onto a custom domain — safely and reversibly.
#
#   bash scripts/use-domain.sh --check                    # is the domain serving yet?
#   bash scripts/use-domain.sh --url https://lens.gitguts.dpdns.org
#   bash scripts/use-domain.sh --url https://ghlens-ultra.gitguts.workers.dev   # roll back
#
# What it changes:
#   1. WORKER_URL in wrangler.jsonc   (every link the bot builds: mini-app,
#      share cards, OAuth redirect, inline results)
#   2. the Telegram webhook           (so updates arrive over the new host)
#   3. a deploy, then a verification pass on the new host
#
# It refuses to switch if the new host does not answer /health with ok:true —
# a half-migrated bot that answers nowhere is exactly what we must avoid.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./.secrets.local.sh

MODE="switch"
TARGET="https://lens.gitguts.dpdns.org"
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --url) TARGET="${2:-}"; shift 2 ;;
    "") ;;
    *) echo "usage: $0 [--check] [--url https://host]"; exit 1 ;;
  esac
done
TARGET="${TARGET%/}"

say() { printf '   %-46s %s\n' "$1" "$2"; }

probe() { # probe <url> → "ok|status|ms"
  curl -s -m 30 -o /tmp/dom.json -w '%{http_code}' "$1/health" 2>/dev/null || echo "000"
}

echo "▸ probing $TARGET"
code=$(probe "$TARGET")
if [ "$code" != "200" ]; then
  say "HTTP /health" "❌ $code"
  if [ "$MODE" = "check" ]; then
    echo
    echo "   the host is not serving yet. For a Cloudflare zone added to the"
    echo "   account but still 'pending', set these nameservers at your DNS"
    echo "   provider (DigitalPlat panel → your domain → nameservers):"
    echo
    echo "       blair.ns.cloudflare.com"
    echo "       otto.ns.cloudflare.com"
    echo
    echo "   Cloudflare then activates the zone, issues the certificate for the"
    echo "   Worker custom domain and creates the DNS record by itself."
    exit 1
  fi
  echo "   ✘ refusing to switch: the new host does not answer."
  exit 1
fi
python3 - <<'PY'
import json
d = json.load(open('/tmp/dom.json'))
assert d.get('ok'), d
print(f"   {'HTTP /health':46} ✅ ok (storage {d['bindings']['storage_backend']})")
PY
[ "$MODE" = "check" ] && { echo "   ✔ the domain is live — safe to switch."; exit 0; }

current=$(grep -oE '"WORKER_URL"[[:space:]]*:[[:space:]]*"[^"]+"' wrangler.jsonc | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')
say "WORKER_URL before" "$current"
if [ "$current" != "$TARGET" ]; then
  python3 - "$TARGET" <<'PY'
import re, sys
new = sys.argv[1]
p = 'wrangler.jsonc'
s = open(p).read()
s2 = re.sub(r'("WORKER_URL"\s*:\s*)"[^"]*"', lambda m: m.group(1) + f'"{new}"', s, count=1)
assert s2 != s, "WORKER_URL not found in wrangler.jsonc"
open(p, 'w').write(s2)
PY
  say "WORKER_URL after" "$(grep -oE '"WORKER_URL"[^,]*' wrangler.jsonc | head -1)"
fi

export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
echo "▸ deploying"
npx wrangler deploy 2>&1 | grep -E "Current Version" | head -1 | sed 's/^/   /'

echo "▸ re-registering the Telegram webhook on the new host"
hook="$TARGET/tg/$TG_HOOK_SECRET"
res=$(curl -s -m 30 -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "$(python3 -c "import json,sys;print(json.dumps({'url':sys.argv[1],'secret_token':sys.argv[2],'allowed_updates':['message','callback_query','inline_query','chosen_inline_result','pre_checkout_query'],'drop_pending_updates':False}))" "$hook" "$TG_HOOK_SECRET")")
echo "$res" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   setWebhook:', '✅' if d.get('ok') else '❌ ' + str(d)[:120])"

sleep 3
curl -s -m 30 "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -c "
import json,sys
r=json.load(sys.stdin)['result']
print('   webhook url   :', r['url'])
print('   pending       :', r['pending_update_count'], '| last error:', r.get('last_error_message','none'))"

echo "▸ verification on the new host"
for path in /health /app "/api/miniapp?kind=ai"; do
  c=$(curl -s -m 40 -o /tmp/v.json -w '%{http_code}' "$TARGET$path")
  printf '   %-46s %s\n' "$path" "$( [ "$c" = "200" ] && echo "✅ 200" || echo "❌ $c" )"
done
curl -s -m 60 "$TARGET/selfcheck?deep=$TG_HOOK_SECRET&text=%2Fstart" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('   selfcheck     :', '✅' if d.get('ok') and d.get('replies') else '❌', f\"({d.get('ms','?')}ms)\")"

echo
echo "▸ done — public base is now $TARGET"
echo "   to roll back:  bash scripts/use-domain.sh --url https://ghlens-ultra.gitguts.workers.dev"
