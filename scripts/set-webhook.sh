#!/usr/bin/env bash
# Register the Telegram webhook + slash-command menus for every locale.
# Example: WORKER_URL=https://drsarli.ir/lens (this account cannot serve
# *.workers.dev — see docs/LIVE.md §1).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BOT_TOKEN:?set BOT_TOKEN (or export it from set-secrets.sh output)}"
: "${WORKER_URL:?set WORKER_URL, e.g. https://ghlens-ultra.your-name.workers.dev}"
: "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"

echo "▸ setWebhook"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${WORKER_URL}/tg/${TELEGRAM_WEBHOOK_SECRET}\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"drop_pending_updates\":true,\"max_connections\":40,\"allowed_updates\":[\"message\",\"callback_query\",\"inline_query\",\"channel_post\",\"my_chat_member\",\"chosen_inline_result\",\"pre_checkout_query\"]}" | jq .

echo "▸ setMyCommands (fa)"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'content-type: application/json' \
  -d '{"language_code":"fa","commands":[
    {"command":"start","description":"شروع و منوی اصلی"},
    {"command":"search","description":"جست‌وجوی هوشمند چندزبانه"},
    {"command":"trending","description":"داغ‌ترین مخازن (روزانه/هفتگی/ماهانه)"},
    {"command":"scout","description":"کاوش عمیق ۱۲ تبی یک مخزن"},
    {"command":"repochat","description":"چت با محتوای یک مخزن"},
    {"command":"translate","description":"ترجمه فارسی README"},
    {"command":"dl","description":"دانلود سورس مخزن"},
    {"command":"security","description":"اسکن امنیت و آسیب‌پذیری"},
    {"command":"tools","description":"جمعه‌ابزار: پکیج، IP، DNS، TLS"},
    {"command":"dev","description":"ابزار توسعه‌دهنده"},
    {"command":"contribute","description":"فرصت‌های مشارکت و اولین PR"},
    {"command":"podcast","description":"پادکست صوتی روزانه"},
    {"command":"profile","description":"پروفایل، سطح و نشان‌ها"},
    {"command":"language","description":"تغییر زبان"},
    {"command":"help","description":"راهنمای کامل"}
  ]}' | jq .

echo "▸ setMyCommands (en)"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'content-type: application/json' \
  -d '{"language_code":"en","commands":[
    {"command":"start","description":"Start and open the main menu"},
    {"command":"search","description":"Hybrid semantic search"},
    {"command":"trending","description":"Trending repos (daily/weekly/monthly)"},
    {"command":"scout","description":"12-tab deep dossier"},
    {"command":"repochat","description":"Chat with a repository"},
    {"command":"dl","description":"Download repository source"},
    {"command":"security","description":"Dependency & secret scanning"},
    {"command":"tools","description":"Packages, IP/DNS/TLS, dev utils"},
    {"command":"contribute","description":"Beginner-friendly issues & first PR"},
    {"command":"podcast","description":"Daily AI audio brief"},
    {"command":"profile","description":"Profile, level and badges"},
    {"command":"language","description":"Change language"},
    {"command":"help","description":"Full command reference"}
  ]}' | jq .

echo
echo "▸ GitHub webhook (do this in the repo you want notifications from):"
cat <<EOF
  Payload URL : ${WORKER_URL}/gh-webhook
  Content type: application/json
  Secret      : \$GITHUB_WEBHOOK_SECRET
  Events      : releases, pushes, issues, pull requests, security advisories, workflow runs, stars
EOF
