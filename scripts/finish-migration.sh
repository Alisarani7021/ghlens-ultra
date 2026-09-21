#!/usr/bin/env bash
# Finish the migration pieces that need credentials only the owner has.
#
#   bash scripts/finish-migration.sh --pat ghp_xxx        # GitHub token
#   bash scripts/finish-migration.sh --old-token cfut_xxx # wipe the old account
#   bash scripts/finish-migration.sh --pat ghp_xxx --old-token cfut_xxx
#
# Everything else is already deployed on the new account; these are the only
# two steps that require values that were never stored on disk.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./.secrets.local.sh 2>/dev/null || true

NEW_URL="https://ghlens-ultra.gitguts.workers.dev"
NEW_ACCOUNT="88a4e920dc6f9606c9987b872ac9ed69"
OLD_ACCOUNT="4beda91649bed6f5d1271b89056d0565"

PAT=""; OLD_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pat) PAT="${2:-}"; shift 2 ;;
    --old-token) OLD_TOKEN="${2:-}"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done

export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$NEW_ACCOUNT"

# ── 1. GitHub token ────────────────────────────────────────────────────────
if [ -n "$PAT" ]; then
  echo "▸ verifying the GitHub token"
  login=$(curl -s -m 20 https://api.github.com/user -H "Authorization: Bearer $PAT" | python3 -c "import json,sys; print((json.load(sys.stdin).get('login') or 'INVALID'))")
  echo "   identity: $login"
  [ "$login" = "INVALID" ] && { echo "   ✘ token rejected by GitHub, aborting"; exit 1; }
  echo "▸ uploading GITHUB_TOKEN to ghlens-ultra"
  printf '%s' "$PAT" | npx wrangler secret put GITHUB_TOKEN >/dev/null && echo "   ✔ secret set"
  sed -i "s|^export GITHUB_TOKEN_PAT=.*|export GITHUB_TOKEN_PAT='$PAT'|" .secrets.local.sh
  sleep 3
  echo "▸ deep health after the token swap"
  curl -s -m 90 "$NEW_URL/health?deep=$TG_HOOK_SECRET" | python3 -c "
import json,sys
d=json.load(sys.stdin); g=d['checks']['github']
print('   github:', '✅' if g.get('ok') else '❌', {k:v for k,v in g.items() if k!='ok'})
print('   overall pass:', d['pass'])"
fi

# ── 2. wipe the old account ────────────────────────────────────────────────
if [ -n "$OLD_TOKEN" ]; then
  echo "▸ removing GitHub Lens Ultra from the old account ($OLD_ACCOUNT)"
  H="Authorization: Bearer $OLD_TOKEN"
  del() { printf '   %-34s ' "$2"; curl -s -m 30 -X DELETE "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/$1" -H "$H" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('no json'); raise SystemExit
print('✔' if d.get('success') else ('✘ ' + str(d.get('errors'))[:80]))"; }

  # zone route (drsarli.ir/lens) — remove before the worker goes away
  zone=$(curl -s -m 20 "https://api.cloudflare.com/client/v4/zones?name=drsarli.ir" -H "$H" | python3 -c "
import json,sys
r=json.load(sys.stdin).get('result') or []
print(r[0]['id'] if r else '')")
  if [ -n "$zone" ]; then
    for rid in $(curl -s -m 20 "https://api.cloudflare.com/client/v4/zones/$zone/workers/routes" -H "$H" | python3 -c "
import json,sys
for r in (json.load(sys.stdin).get('result') or []):
    if r.get('script') == 'ghlens-ultra': print(r['id'])"); do
      printf '   %-34s ' "route $rid"
      curl -s -m 20 -X DELETE "https://api.cloudflare.com/client/v4/zones/$zone/workers/routes/$rid" -H "$H" >/dev/null && echo "✔"
    done
    printf '   %-34s ' "fallback route */* (had pointed at lens)"
    fallback=$(curl -s -m 20 "https://api.cloudflare.com/client/v4/zones/$zone/workers/routes" -H "$H" | python3 -c "
import json,sys
for r in (json.load(sys.stdin).get('result') or []):
    if r.get('script') == 'ghlens-ultra' and r.get('pattern') == '*/*': print(r['id'])")
    [ -n "$fallback" ] && curl -s -m 20 -X DELETE "https://api.cloudflare.com/client/v4/zones/$zone/workers/routes/$fallback" -H "$H" >/dev/null && echo "✔" || echo "(none)"
  fi

  del "workers/scripts/ghlens-ultra?force=true" "worker ghlens-ultra"
  for pair in "29f61e2084944e9eb8cd56ca73625945:OLD-KV-cache" "3ddfd79b9f58484892ce6d6c4b5b0d6b:OLD-KV-state"; do
    : # ids differ per account; resolved below by title
  done
  # KV namespaces by title
  for ns in $(curl -s -m 25 "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/storage/kv/namespaces" -H "$H" | python3 -c "
import json,sys
for n in (json.load(sys.stdin).get('result') or []):
    if n.get('title','').startswith('ghlens'): print(n['id'] + ':' + n['title'])"); do
    id="${ns%%:*}"; title="${ns##*:}"
    del "storage/kv/namespaces/$id" "KV $title"
  done
  # D1 + queues
  for db in $(curl -s -m 25 "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/d1/database" -H "$H" | python3 -c "
import json,sys
for n in (json.load(sys.stdin).get('result') or []):
    if n.get('name') == 'ghlens': print(n['uuid'])"); do
    del "d1/database/$db" "D1 ghlens"
  done
  for q in $(curl -s -m 25 "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/queues" -H "$H" | python3 -c "
import json,sys
for n in (json.load(sys.stdin).get('result') or []):
    if n.get('queue_name','').startswith('ghlens-jobs'): print(n['queue_id'] + ':' + n['queue_name'])"); do
    qid="${q%%:*}"; qname="${q##*:}"
    printf '   %-34s ' "queue $qname"
    curl -s -m 30 -X DELETE "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/queues/$qid" -H "$H" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('no json'); raise SystemExit
print('✔' if d.get('success') else ('✘ ' + str(d.get('errors'))[:80]))"
  done
  echo
  echo "▸ anything left on the old account?"
  curl -s -m 25 "https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/workers/scripts" -H "$H" | python3 -c "
import json,sys
names=[s['id'] for s in (json.load(sys.stdin).get('result') or [])]
print('   workers:', ', '.join(names))"
fi

echo
echo "▸ current state"
curl -s -m 30 "$NEW_URL/health" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('   new worker ok:', d['ok'], '| storage:', d['bindings']['storage_backend'])"
echo "   bot:  $(curl -s -m 20 "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | python3 -c "
import json,sys; r=json.load(sys.stdin)['result']
print(r['url'], '| pending:', r['pending_update_count'], '| error:', r.get('last_error_message','none'))")"
