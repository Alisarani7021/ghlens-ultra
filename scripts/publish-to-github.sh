#!/usr/bin/env bash
# Put this project on your GitHub account.
#
#   bash scripts/publish-to-github.sh --token ghp_xxxxxxxx --repo ghlens-ultra --private
#
# What it does:
#   1. verifies the token and finds your login
#   2. creates the repository if it does not exist (or reuses it)
#   3. commits the working tree (secrets are git-ignored and scanned for)
#   4. pushes `main` + the version tag
#   5. prints the GitHub Actions secrets you should add for auto-deploy
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN=""; REPO="ghlens-ultra"; VISIBILITY="public"; DESC="GitHub Lens Ultra — a deep open-source discovery & analysis Telegram bot running entirely on Cloudflare (Workers · D1 · KV · Queues · Durable Objects · Workers AI)."
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --private) VISIBILITY="private"; shift ;;
    --desc) DESC="${2:-}"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done
[ -n "$TOKEN" ] || { echo "usage: bash scripts/publish-to-github.sh --token ghp_… [--repo name] [--private]"; exit 1; }

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "accept: application/vnd.github+json" -H "user-agent: ghlens-publish")

echo "▸ verifying the token"
LOGIN=$(curl -s -m 25 "$API/user" "${AUTH[@]}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('login') or '')")
[ -n "$LOGIN" ] || { echo "   ✘ token rejected — check that it has the 'repo' scope"; exit 1; }
echo "   signed in as: $LOGIN"

echo "▸ repository $LOGIN/$REPO"
EXISTS=$(curl -s -m 25 -o /dev/null -w '%{http_code}' "$API/repos/$LOGIN/$REPO" "${AUTH[@]}")
if [ "$EXISTS" = "200" ]; then
  echo "   already exists — pushing into it"
else
  curl -s -m 40 -X POST "$API/user/repos" "${AUTH[@]}" \
    -d "$(python3 -c "
import json,sys
print(json.dumps({'name': sys.argv[1], 'description': sys.argv[2], 'private': sys.argv[3] == 'private', 'has_issues': True, 'has_wiki': False, 'auto_init': False}))" "$REPO" "$DESC" "$VISIBILITY")" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('   created:', (d.get('full_name') or d.get('errors')))"
fi

if [ ! -d .git ]; then
  echo "▸ initialising the repository"
  git init -q -b main
fi
git add -A

echo "▸ scanning every file that is about to be committed (ignored files stay local)"
if git grep --cached -InE "(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|cfut_[A-Za-z0-9]{30,}|[0-9]{8,12}:AA[A-Za-z0-9_-]{30,}|BEGIN (RSA|OPENSSH) PRIVATE KEY|[A-Za-z0-9._%+-]+@(gmail|hotmail|yahoo)\.[a-z]{2,})" -- . ; then
  echo "   ✘ the strings above would leak — aborting. Move them into .secrets.local.sh (git-ignored) and retry."
  exit 1
fi
echo "   clean: $(git diff --cached --name-only | wc -l) files staged, no credentials and no personal e-mail addresses"
git config user.name  >/dev/null 2>&1 || git config user.name  "$LOGIN"
git config user.email >/dev/null 2>&1 || git config user.email "$LOGIN@users.noreply.github.com"
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "GitHub Lens Ultra: Cloudflare-native Telegram bot for deep open-source discovery

77 commands · 137 inline actions · 20 D1 tables · 40 TypeScript files
Workers + D1 + KV + Queues + Durable Objects + Workers AI, with:
• hybrid multilingual search (FA/EN) and trending boards (daily/weekly/monthly)
• 12-tab deep repository dossier and AI dossier briefing
• README translation to Persian with click-to-swap original
• source download: one-shot, streaming splits for big repos, GitHub Actions offload
• security engine (OSV advisories + secret heuristics), toolbox, dev utilities
• favourites, subscriptions, gamification, digests, daily AI audio digest
• /health, /health?deep, /health?cron, /selfcheck diagnostics + SQL guard + tests"
fi
TAG=$(python3 -c "import json;print(json.load(open('package.json')).get('version','0.1.0'))")
git tag -f "v$TAG" -m "v$TAG" >/dev/null 2>&1 || true

echo "▸ pushing"
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$LOGIN/$REPO.git"
git push -u "https://x-access-token:$TOKEN@github.com/$LOGIN/$REPO.git" main --tags --force
git remote set-url origin "https://github.com/$LOGIN/$REPO.git"   # never store the token in .git/config

cat <<EOF

✔ done → https://github.com/$LOGIN/$REPO

Next, to let GitHub Actions deploy for you (optional):
  repository → Settings → Secrets and variables → Actions → New repository secret
    CLOUDFLARE_API_TOKEN      (Edit Cloudflare Workers template)
    CLOUDFLARE_ACCOUNT_ID     $([ -f .secrets.local.sh ] && bash -c 'source ./.secrets.local.sh 2>/dev/null; echo "${CF_ACCOUNT_ID:-<your account id>}"' || echo "<your account id>")
    TELEGRAM_WEBHOOK_SECRET   (only if you want the deep-health smoke test)
EOF
