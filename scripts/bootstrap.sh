#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  GitHub Lens Ultra — one-shot bootstrap
#
#  Creates every Cloudflare resource, patches wrangler.jsonc with real IDs,
#  applies the D1 schema and deploys the Worker.
#
#    export CLOUDFLARE_API_TOKEN=…      # Workers + D1 + R2 + Queues + Vectorize
#    export CLOUDFLARE_ACCOUNT_ID=…
#    ./scripts/bootstrap.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }

command -v npx >/dev/null || { echo "node/npx required"; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "set CLOUDFLARE_ACCOUNT_ID"; exit 1; }

say "Installing dependencies"
npm install --no-audit --no-fund

# ── 1. KV ──────────────────────────────────────────────────────────────────
say "Creating KV namespaces (CACHE + STATE)"
CACHE_ID=$(npx wrangler kv namespace create CACHE 2>/dev/null | grep -oP 'id = "\K[^"]+' | head -1 || true)
STATE_ID=$(npx wrangler kv namespace create STATE 2>/dev/null | grep -oP 'id = "\K[^"]+' | head -1 || true)
[ -n "$CACHE_ID" ] || warn "CACHE exists already — keeping current id"
[ -n "$STATE_ID" ] || warn "STATE exists already — keeping current id"

# ── 2. D1 ──────────────────────────────────────────────────────────────────
say "Creating D1 database"
D1_ID=$(npx wrangler d1 create ghlens 2>/dev/null | grep -oP 'database_id = "\K[^"]+' | head -1 || true)
[ -n "$D1_ID" ] || warn "D1 exists already — keeping current id"

# ── 3. R2 ──────────────────────────────────────────────────────────────────
say "Creating R2 bucket ghlens-files"
npx wrangler r2 bucket create ghlens-files 2>/dev/null || warn "bucket exists already"

# ── 4. Queues ──────────────────────────────────────────────────────────────
say "Creating queues"
npx wrangler queues create ghlens-jobs 2>/dev/null || warn "queue exists already"
npx wrangler queues create ghlens-jobs-dlq 2>/dev/null || warn "dlq exists already"

# ── 5. Vectorize ───────────────────────────────────────────────────────────
say "Creating Vectorize index (1024 dims, cosine — matches @cf/baai/bge-m3)"
npx wrangler vectorize create ghlens-index --dimensions=1024 --metric=cosine 2>/dev/null || warn "index exists already"

# ── 6. patch wrangler.jsonc ────────────────────────────────────────────────
say "Patching wrangler.jsonc with real resource ids"
python3 - "$CACHE_ID" "$STATE_ID" "$D1_ID" <<'PY'
import re, sys
cache, state, d1 = sys.argv[1], sys.argv[2], sys.argv[3]
p = "wrangler.jsonc"
s = open(p).read()
if cache: s = s.replace('"REPLACE_WITH_CACHE_KV_ID"', f'"{cache}"')
if state: s = s.replace('"REPLACE_WITH_STATE_KV_ID"', f'"{state}"')
if d1:    s = s.replace('"REPLACE_WITH_D1_ID"', f'"{d1}"')
open(p, "w").write(s)
print("  wrangler.jsonc updated")
PY

# ── 7. schema ──────────────────────────────────────────────────────────────
say "Applying D1 schema (20 tables)"
npx wrangler d1 execute ghlens --remote --file=./schema/d1.sql

# ── 8. secrets ─────────────────────────────────────────────────────────────
say "Secrets"
cat <<'EOF'
The Worker needs these secrets (scripts/set-secrets.sh sets them in one go):
  BOT_TOKEN                 — from @BotFather
  BOT_USERNAME              — the bot's username, without @
  GITHUB_TOKEN              — classic PAT: public_repo (+ read:org if you use orgs)
  TELEGRAM_WEBHOOK_SECRET   — any random string
  GITHUB_WEBHOOK_SECRET     — any random string
  CF_API_TOKEN / CF_ACCOUNT_ID  — for Browser Rendering share cards
  HELPER_REPO / HELPER_REPO_TOKEN — optional, big-repo Actions offload
  DOWNLOAD_SIGNING_KEY      — any random string
EOF

say "Deploying"
npx wrangler deploy

say "Done. Next:"
cat <<'EOF'
  1) ./scripts/set-secrets.sh          # push the secrets above
  2) npx wrangler deploy               # redeploy so secrets are live
  3) ./scripts/set-webhook.sh          # point Telegram at your Worker
  4) open https://<worker>/health       # every binding should say true
  5) send /start to your bot in Telegram
EOF
