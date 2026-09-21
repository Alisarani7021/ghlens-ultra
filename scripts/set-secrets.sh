#!/usr/bin/env bash
# Push every Worker secret in one pass (idempotent — rerun anytime).
set -euo pipefail
cd "$(dirname "$0")/.."

need() { [ -n "${!1:-}" ] || { echo "missing env var: $1"; exit 1; }; }

# Required
need BOT_TOKEN; need BOT_USERNAME; need GITHUB_TOKEN
: "${TELEGRAM_WEBHOOK_SECRET:=$(openssl rand -hex 24)}"
: "${GITHUB_WEBHOOK_SECRET:=$(openssl rand -hex 24)}"
: "${DOWNLOAD_SIGNING_KEY:=$(openssl rand -hex 32)}"

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  ✅ $1"; }

echo "▸ Uploading secrets"
put BOT_TOKEN "$BOT_TOKEN"
put BOT_USERNAME "$BOT_USERNAME"
put GITHUB_TOKEN "$GITHUB_TOKEN"
put TELEGRAM_WEBHOOK_SECRET "$TELEGRAM_WEBHOOK_SECRET"
put GITHUB_WEBHOOK_SECRET "$GITHUB_WEBHOOK_SECRET"
put DOWNLOAD_SIGNING_KEY "$DOWNLOAD_SIGNING_KEY"

# Optional
[ -n "${CF_API_TOKEN:-}" ]      && put CF_API_TOKEN "$CF_API_TOKEN"      || echo "  ⏭ CF_API_TOKEN (share cards disabled)"
[ -n "${CF_ACCOUNT_ID:-}" ]     && put CF_ACCOUNT_ID "$CF_ACCOUNT_ID"    || echo "  ⏭ CF_ACCOUNT_ID"
[ -n "${HELPER_REPO:-}" ]       && put HELPER_REPO "$HELPER_REPO"        || echo "  ⏭ HELPER_REPO (Actions offload disabled)"
[ -n "${HELPER_REPO_TOKEN:-}" ] && put HELPER_REPO_TOKEN "$HELPER_REPO_TOKEN" || echo "  ⏭ HELPER_REPO_TOKEN"
[ -n "${OPENAI_COMPAT_BASE_URL:-}" ] && put OPENAI_COMPAT_BASE_URL "$OPENAI_COMPAT_BASE_URL" || true
[ -n "${OPENAI_COMPAT_KEY:-}" ] && put OPENAI_COMPAT_KEY "$OPENAI_COMPAT_KEY" || true

echo
echo "▸ Write these down — your GitHub webhook needs the secret:"
echo "  GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET"
echo "  TELEGRAM_WEBHOOK_SECRET=$TELEGRAM_WEBHOOK_SECRET"
echo
echo "▸ Then:  npx wrangler deploy && ./scripts/set-webhook.sh"
