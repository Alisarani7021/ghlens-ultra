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

# Command menus, one per locale the bot speaks. Telegram shows the list that
# matches the client's language and falls back to the default scope, so a user
# whose phone is in Russian sees Russian descriptions.
# NOTE: no audio commands exist any more — the podcast was removed on purpose.
menus() {
  cat <<JSON
[
 {"language_code":"fa","commands":[
  {"command":"start","description":"خانه و منوی اصلی"},
  {"command":"help","description":"راهنمای کامل همهٔ قابلیت‌ها"},
  {"command":"search","description":"جست‌وجوی چندزبانه"},
  {"command":"trending","description":"داغ‌ترین مخازن با آمار واقعی"},
  {"command":"scout","description":"کاوش عمیق ۱۲ تبی یک مخزن"},
  {"command":"repochat","description":"چت با محتوای یک مخزن"},
  {"command":"translate","description":"ترجمهٔ فارسی README"},
  {"command":"dl","description":"دانلود سورس مخزن"},
  {"command":"security","description":"اسکن امنیت و کلید لو‌رفته"},
  {"command":"tools","description":"جعبه‌ابزار: پکیج، IP، DNS، TLS"},
  {"command":"hub","description":"هاب جهانی: رویداد، ورک‌فلو، انتشار"},
  {"command":"profile","description":"پروفایل، سطح و نشان‌ها"},
  {"command":"language","description":"تغییر زبان"}]},
 {"language_code":"en","commands":[
  {"command":"start","description":"Home and main menu"},
  {"command":"help","description":"Complete feature reference"},
  {"command":"search","description":"Multilingual semantic search"},
  {"command":"trending","description":"Trending repos with real growth"},
  {"command":"scout","description":"12-tab deep dossier"},
  {"command":"repochat","description":"Chat with a repository"},
  {"command":"translate","description":"Translate a README"},
  {"command":"dl","description":"Download repository source"},
  {"command":"security","description":"Security and leaked-key scan"},
  {"command":"tools","description":"Packages, IP/DNS/TLS, dev utils"},
  {"command":"hub","description":"Universal hub: events, workflows, publishing"},
  {"command":"profile","description":"Profile, level and badges"},
  {"command":"language","description":"Change language"}]},
 {"language_code":"ar","commands":[
  {"command":"start","description":"الرئيسية والقائمة"},
  {"command":"help","description":"دليل كل الميزات"},
  {"command":"search","description":"بحث متعدد اللغات"},
  {"command":"trending","description":"الأكثر رواجاً بإحصاءات حقيقية"},
  {"command":"scout","description":"تحليل عميق بـ12 تبويباً"},
  {"command":"repochat","description":"محادثة مع مستودع"},
  {"command":"translate","description":"ترجمة ملف README"},
  {"command":"dl","description":"تنزيل مصدر المستودع"},
  {"command":"security","description":"فحص الأمان والمفاتيح المسربة"},
  {"command":"tools","description":"أدوات: الحزم، IP، DNS، TLS"},
  {"command":"hub","description":"المركز العالمي: أحداث، سير عمل، نشر"},
  {"command":"profile","description":"الملف والمستوى والشارات"},
  {"command":"language","description":"تغيير اللغة"}]},
 {"language_code":"ru","commands":[
  {"command":"start","description":"Главное меню"},
  {"command":"help","description":"Полное описание возможностей"},
  {"command":"search","description":"Многоязычный поиск"},
  {"command":"trending","description":"Тренды с реальной статистикой"},
  {"command":"scout","description":"Глубокий разбор репозитория"},
  {"command":"repochat","description":"Чат с репозиторием"},
  {"command":"translate","description":"Перевод README"},
  {"command":"dl","description":"Скачать исходники"},
  {"command":"security","description":"Проверка безопасности"},
  {"command":"tools","description":"Пакеты, IP/DNS/TLS, утилиты"},
  {"command":"hub","description":"Хаб: события, сценарии, публикация"},
  {"command":"profile","description":"Профиль, уровень, значки"},
  {"command":"language","description":"Язык"}]},
 {"language_code":"zh","commands":[
  {"command":"start","description":"主页与主菜单"},
  {"command":"help","description":"完整功能说明"},
  {"command":"search","description":"多语言语义搜索"},
  {"command":"trending","description":"真实增长趋势榜"},
  {"command":"scout","description":"十二标签深度分析"},
  {"command":"repochat","description":"与仓库对话"},
  {"command":"translate","description":"翻译 README"},
  {"command":"dl","description":"下载仓库源码"},
  {"command":"security","description":"安全与密钥泄露扫描"},
  {"command":"tools","description":"包转换、IP/DNS/TLS 工具"},
  {"command":"hub","description":"全球中枢：事件·流程·发布"},
  {"command":"profile","description":"资料、等级与徽章"},
  {"command":"language","description":"切换语言"}]}
]
JSON
}

echo "▸ setMyCommands (fa · en · ar · ru · zh)"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'content-type: application/json' \
  --data-binary "$(menus)" | jq .

echo
echo "▸ GitHub webhook (do this in the repo you want notifications from):"
cat <<EOF
  Payload URL : ${WORKER_URL}/hooks/github/<key>   # the key comes from the connector
  Content type: application/json
  Secret      : \$GITHUB_WEBHOOK_SECRET
  Events      : releases, pushes, issues, pull requests, security advisories, workflow runs, stars
EOF
