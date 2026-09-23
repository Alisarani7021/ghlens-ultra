#!/usr/bin/env bash
# Bot profile text — the words Telegram itself shows.
#
# `setMyDescription` is the card on the splash screen ("این ربات چه میکند؟")
# and `setMyShortDescription` is the "About" line in the bot's profile. Both can
# be set per language with the Bot API, so the bot's front page stops saying
# things that are no longer true (it advertised a podcast for a while).
#
# Usage:  BOT_TOKEN=… ./scripts/set-profile.sh [--dry]
set -euo pipefail

: "${BOT_TOKEN:?set BOT_TOKEN (or source .secrets.local.sh)}"
API="https://api.telegram.org/bot${BOT_TOKEN}"
DRY=""
[ "${1:-}" = "--dry" ] && DRY=1

# ── short description: one line, shown in the profile ───────────────────────
short_fa="کاوش، تحلیل، ترجمه، امنیت و دانلود اوپن‌سورس در تلگرام — با هاب رویدادمحور. کاملاً روی Cloudflare."
short_en="GitHub discovery, analysis, translation, security and downloads in Telegram — plus an event-driven hub. On Cloudflare."
short_ar="استكشاف GitHub وتحليله وترجمته وأمنه وتنزيله في تلغرام — مع مركز أحداث. على Cloudflare."
short_ru="Разведка GitHub, анализ, перевод, безопасность и загрузки в Telegram — плюс хаб событий. На Cloudflare."
short_zh="在 Telegram 中探索、分析、翻译、审计与下载 GitHub —— 另含事件驱动中枢。运行于 Cloudflare。"

# ── description: the splash card ────────────────────────────────────────────
desc_fa=$(cat <<'TXT'
۹۳ فرمان برای کار با گیت‌هاب، بدون ترک تلگرام:

🔍 جست‌وجوی معنایی چندزبانه — یک موضوع به هر زبانی بنویس
🛰 کاوش ۱۲ تبی — رشد، ضریب اتوبوس، نرخ مرج، ریلیز، CI، امنیت
🧠 هوش مصنوعی — چت با مخزن با استناد، ترجمهٔ README، بازبینی PR
📥 دانلود مستقیم سورس — با تقسیم خودکار فایل‌های بزرگ
🛡 اسکن وابستگی (OSV) · شکار کلید لو‌رفته · هشدار CVE
🌌 هاب رویدادمحور — رویداد می‌گیرد، پیش‌نویس پست می‌سازد و فقط با تأیید تو منتشر می‌کند

کاملاً روی Cloudflare Workers · ۳۳ جدول D1 · ۵ زبان
همهٔ قابلیت‌ها: /help
TXT
)

desc_en=$(cat <<'TXT'
93 commands for working with GitHub without leaving Telegram:

🔍 Multilingual semantic search — describe it in any language
🛰 12-tab dossier — growth, bus factor, merge rate, releases, CI, security
🧠 AI — repo chat with citations, README translation, PR review
📥 Direct downloads — large files split automatically
🛡 OSV dependency scan · leaked-key hunt · CVE alerts
🌌 Event hub — takes events, drafts the post, publishes on approval

On Cloudflare Workers · 33 D1 tables · /help
TXT
)

desc_ar=$(cat <<'TXT'
٩٣ أمراً للعمل مع GitHub من داخل تلغرام:

🔍 بحث دلالي بعدة لغات · 🛰 تحليل عميق بـ12 تبويباً
🧠 الذكاء الاصطناعي: محادثة مع المستودع مع الاستشهادات وترجمة README
📥 تنزيل المصدر مباشرة مع تقسيم الملفات الكبيرة تلقائياً
🛡 فحص التبعيات (OSV) وكشف المفاتيح المسربة وتنبيهات CVE
🌌 مركز أحداث: يستقبل الحدث، يُعدّ المنشور، ولا ينشر إلا بموافقتك

بالكامل على Cloudflare Workers · 5 لغات · للمزيد: /help
TXT
)

desc_ru=$(cat <<'TXT'
93 команды для работы с GitHub прямо в Telegram:

🔍 Многоязычный семантический поиск · 🛰 Разбор репозитория по 12 вкладкам
🧠 ИИ: чат с репозиторием со ссылками, перевод README, ревью PR
📥 Прямая загрузка исходников с авторазбивкой больших файлов
🛡 Проверка зависимостей (OSV), поиск утёкших ключей, оповещения CVE
🌌 Хаб событий: получает событие, готовит пост и публикует только с вашего согласия

Полностью на Cloudflare Workers · 5 языков · всё: /help
TXT
)

desc_zh=$(cat <<'TXT'
在 Telegram 内使用 GitHub 的 93 条命令：

🔍 多语言语义搜索 · 🛰 十二标签深度分析
🧠 AI：带引用的仓库对话、README 翻译、PR 审查
📥 直接下载源码，大文件自动分卷
🛡 依赖扫描（OSV）、泄露密钥搜寻、CVE 提醒
🌌 事件中枢：接收事件、起草发布内容，仅在你批准后发布

完全运行于 Cloudflare Workers · 5 种语言 · 全部功能：/help
TXT
)

call() { # method, language_code, field, value
  local method="$1" lang="$2" field="$3" value="$4"
  if [ -n "$DRY" ]; then
    echo "  (dry) $method [$lang] ${#value} chars"
    return 0
  fi
  curl -s "$API/$method" -H 'content-type: application/json' \
    --data-binary "$(printf '{"language_code":"%s","%s":%s}' "$lang" "$field" "$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<<"$value")")" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('  $method [$lang] →', 'ok' if d.get('ok') else d.get('description'))"
}

# The no-language copy is what Telegram shows when the client's language is not
# one we set, and it is what the API returns without a language_code — so it must
# be written too, otherwise the old text lives on for every other locale.
echo "▸ default (any other language)"
call setMyShortDescription "" short_description "$short_fa"
call setMyDescription "" description "$desc_fa"

echo "▸ short description (the profile line)"
call setMyShortDescription fa short_description "$short_fa"
call setMyShortDescription en short_description "$short_en"
call setMyShortDescription ar short_description "$short_ar"
call setMyShortDescription ru short_description "$short_ru"
call setMyShortDescription zh short_description "$short_zh"

echo "▸ description (the splash card)"
call setMyDescription fa description "$desc_fa"
call setMyDescription en description "$desc_en"
call setMyDescription ar description "$desc_ar"
call setMyDescription ru description "$desc_ru"
call setMyDescription zh description "$desc_zh"

echo "▸ verify"
if [ -z "$DRY" ]; then
  for m in getMyName getMyShortDescription getMyDescription; do
    curl -s "$API/$m" | python3 -c "
import sys,json
d=json.load(sys.stdin)['result']
print(' ', '$m', '→', repr(d.get('name') or d.get('short_description') or d.get('description'))[:90])
"
  done
fi
