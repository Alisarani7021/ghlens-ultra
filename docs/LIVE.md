<div dir="rtl">

# 🟢 وضعیت استقرار زنده — GitHub Lens Ultra

**همه‌چیز روی اکانت کلادفلر جدید بالا آمده و کار می‌کند.** این سند عکس لحظه‌ای از چیزی است که اجرا می‌شود: آدرس‌ها، شناسه‌ها، تست‌های پاس‌شده، محدودیت‌ها و کارهای باقی‌مانده.

| | |
|---|---|
| 🤖 ربات | [`@Gitguts_bot`](https://t.me/Gitguts_bot) |
| 🌐 Worker | `https://ghlens-ultra.gitguts.workers.dev` |
| 🏦 اکانت کلادفلر | `88a4e920dc6f9606c9987b872ac9ed69` (the account that owns the worker) |
| 🕓 آخرین دیپلوی | ۲۰۲۶-۰۹-۲۱ · نسخه `00f628e0-c2ed-41e1-aca4-4079048db441` |

> **مهاجرت انجام شد.** استقرار از اکانت قبلی (`4beda91649bed6f5d1271b89056d0565`) به این اکانت منتقل شد، چون روی آن اکانت زیردامنه‌ی `*.workers.dev` از سمت کلادفلر خراب بود (هر اسکریپت، حتی «hello world»، خطای ۱۱۰۱ می‌گرفت). روی این اکانت `workers.dev` سالم است — همان «hello world» اول تست شد و `probe-ok` برگرداند.

---

## ۱. آدرس‌ها

| چه چیزی | آدرس |
|---|---|
| ❤️ سلامت سریع | `https://ghlens-ultra.gitguts.workers.dev/health` |
| 🩺 سلامت عمیق | `.../health?deep=<TELEGRAM_WEBHOOK_SECRET>` |
| ⏱ ضربان زمان‌بند | `.../health?cron=1` |
| 📱 مینی‌اپ تلگرام | `.../app` |
| 🖼 کارت اشتراک‌گذاری | `.../api/card?repo=react/react` |
| 🧪 خودآزمای مسیر آپدیت | `.../selfcheck?deep=<SECRET>&text=/start&uid=1` |
| 🪝 وبهوک تلگرام | `.../tg/<TELEGRAM_WEBHOOK_SECRET>` |

## ۲. منابع روی اکانت جدید

| منبع | شناسه |
|---|---|
| KV `ghlens-cache` | `29f61e2084944e9eb8cd56ca73625945` |
| KV `ghlens-state` | `3ddfd79b9f58484892ce6d6c4b5b0d6b` |
| D1 `ghlens` (۲۰ جدول) | `7d5661de-ab32-4b03-87fa-ed8d0a964ea4` |
| صف `ghlens-jobs` | `0cccb08747b64bd4add939dd188d56a2` |
| صف `ghlens-jobs-dlq` | `b1767bac91d34141a847b4d43da02a03` |
| Durable Object | `ghlens-ultra_UserSession` — `e7e57fad37ce48379e80af4275256b9b` |
| زیردامنه‌ی workers.dev | `gitguts` (ساخته شد) |
| کرون‌ها | `*/15 * * * *` · `0 * * * *` · `0 6 * * *` (۲ اسلات آزاد ماند) |
| سکرت‌ها | `BOT_TOKEN` · `BOT_USERNAME` · `TELEGRAM_WEBHOOK_SECRET` · `GITHUB_WEBHOOK_SECRET` · `DOWNLOAD_SIGNING_KEY` · `CF_API_TOKEN` · `CF_ACCOUNT_ID` — و `GITHUB_TOKEN` که منتظر توکن توست |

## ۳. تست‌های زنده روی اکانت جدید

```
/health?deep=…       d1 ✅ (۲۲ جدول) · kv ✅ (راند‌تریپ باینری) · telegram ✅ @Gitguts_bot
                     ai_text ✅ · embeddings ✅ (۱۰۲۴ بعد) · queue ✅ · durable_object ✅
                     tts ✅ (۱۰٬۳۴۴ بایت)
                     github ⚠️ ok ولی authenticated:false و core_remaining:0
                            (سهمیه‌ی بدون‌توکنِ IPهای Workers تمام است — با PAT درست می‌شود)
/selfcheck (۱۱ مسیر) ✅ /start /id /help /profile /trending /tools ip /language /security
                     ✅ vuejs/core /scout facebook/react /ask
وبهوک امن            ✅ با سکرت ۲۰۰ در ۵۵ms · بدون سکرت ۴۰۳
زمان‌بند (کرون)      ✅ «*/15 * * * * took 8819ms» بدون خطا
داده‌ی تولیدشده       ✅ ۳۰ ردیف ترند روزانه + ۳۰ اسنپ‌شات ستاره + ۳۱ مخزن در D1
وبهوک تلگرام        → https://ghlens-ultra.gitguts.workers.dev/tg/… · pending: 0 · بدون خطا
منوی دستورات         → ۱۵ فرمان فارسی + ۱۳ فرمان انگلیسی + توضیحات ربات ثبت شد
```

> مسیرهای GitHub حتی بدون توکن هم کار می‌کنند (repo/scout/search تست شدند)، ولی سهمیه‌ی بدون‌احراز هویت فقط **۶۰ درخواست در ساعت** است. با توکن رایگان GitHub این عدد **۵٬۰۰۰ در ساعت** می‌شود — وبه همین دلیل `GITHUB_TOKEN` را حتماً ست کن (دستور پایین).

## ۴. دو کاری که مانده (هر دو با یک دستور)

فایل موقت `/tmp` بین نشست‌ها پاک می‌شود، پس توکن‌های حساس در ورک‌اسپیس ذخیره نشدند. نتیجه: دو مقدار را فقط تو داری:

```bash
cd ghlens
source ./.secrets.local.sh

# ۱) توکن گیت‌هاب (رایگان از github.com/settings/tokens — فقط scope عمومی/public_repo کافی است)
bash scripts/finish-migration.sh --pat ghp_xxxxxxxxxxxx

# ۲) پاک‌کردن کامل استقرار قبلی از اکانت قدیم (توکن قدیمی کلادفلر را بده)
bash scripts/finish-migration.sh --old-token cfut_xxxxxxxxxxxx
```

یا هر دو با هم: `bash scripts/finish-migration.sh --pat ghp_… --old-token cfut_…`

اسکریپت برای کار ۱: توکن را آزمایش می‌کند، به‌عنوان سکرت ست می‌کند و بعد سلامت عمیق می‌گیرد.
برای کار ۲: روت‌های `drsarli.ir/lens`، خود ورکر `ghlens-ultra`، دو KV، دیتابیس D1 و دو صف را از اکانت قدیم حذف می‌کند و در پایان فهرست باقی‌مانده را نشان می‌دهد (به بقیه‌ی ورکرهایت کاری ندارد).

> اگر ترجیح می‌دهی دستی حذف کنی: داشبورد کلادفلر → اکانت قبلی → Workers & Pages → `ghlens-ultra` → Settings → Delete؛ بعد KV (دو تا با نام `ghlens-…`)، D1 (`ghlens`) و Queues (`ghlens-jobs`, `ghlens-jobs-dlq`).

## ۵. سه کار ۳۰ ثانیه‌ای خودت

1. **`/start`** را در ربات بزن (وبهوک روی آدرس جدید فعال است).
2. **`/id`** را بزن و عددش را بفرست تا `ADMIN_IDS` را ست کنم (پنل مدیریت، تست AI، آمار و پخش همگانی).
3. **BotFather → `/setinline`** روی `@Gitguts_bot` تا جست‌وجوی درون‌چت (`@Gitguts_bot react`) فعال شود (الان `supports_inline_queries: false`).

🔐 **و یک نکته‌ی امنیتی:** توکن ربات و توکن کلادفلر در چت فرستاده شدند؛ بعد از پایان کار **هر دو را عوض کن** (BotFather → `/revoke`، و توکن جدید کلادفلر). توکن ربات را من از لاگ‌های محلی بازیابی کردم چون فایل موقت پاک شده بود — این یعنی همان توکن جای دیگری هم نوشته شده است، پس تعویضش را جدی بگیر. سکرت‌های داخلی (وبهوک تلگرام، وبهوک گیت‌هاب، امضای دانلود) را همین حالا از نو تولید کردم و روی استقرار جدید ست کردم، پس آن‌ها لو نرفته‌اند.

## ۶. چرا سه کرون و نه پنج تا؟

پلن Free کلادفلر روی **کل اکانت** ۵ کرون می‌دهد (نه به‌ازای هر ورکر). روی این اکانت فعلاً هیچ کرونی مصرف نشده، ولی برای همکارهای احتمالی آینده‌ات دو اسلات نگه داشتم:

| کرون | کار |
|---|---|
| `*/15 * * * *` | اسنپ‌شات ستاره‌ها، تازه‌سازی تابلوی ترند (روز/هفته/ماه/کل)، تخلیه‌ی صف خلاصه‌ها، پخش‌های زمان‌بندی‌شده |
| `0 * * * *` | ایندکس مخازن تازه، جاروی امنیتی دوره‌ای |
| `0 6 * * *` | پادکست روزانه + خلاصه‌های شخصی‌سازی‌شده، و **در همان اجرا**: گزارش رشد هفتگی (یکشنبه‌ها) و پاک‌سازی ماهانه (روز ۱) |

`classifyCron()` شکل `0 6 * * SUN` و `0 4 1 * *` را هم می‌شناسد، پس اگر پلن پول‌دار گرفتی، فقط در `wrangler.jsonc` اضافه‌شان کن — بدون تغییر کد.

## ۷. محدودیت‌های این اکانت

| مورد | وضعیت | راه‌حل |
|---|---|---|
| R2 | فعال نیست | ذخیره‌سازی خودکار روی KV (تا ۲۴ مگابایت) + تقسیم جریانی؛ با فعال‌کردن R2 فقط بلاک کامنت‌شده را باز کن |
| Vectorize | در دسترس این توکن نیست | جست‌وجوی واژگانی + AI فعال است؛ با `npx wrangler vectorize create ghlens-index --dimensions=1024 --metric=cosine` و باز کردن بایندینگ، جست‌وجوی معنایی روشن می‌شود |
| Analytics Engine | فعال نیست | کامنت `wrangler.jsonc` دستور فعال‌سازی را دارد |
| صدای فارسی Workers AI | مدل فارسی ندارد | صدا از صدای انگلیسی Deepgram Aura با ترجمه‌ی زنده ساخته می‌شود (`voice: en (live translation)`) |
| کرون | ۳ از ۵ اسلات | کار هفتگی/ماهانه داخل اجرای روزانه انجام می‌شود |
| دامنه | `gitguts.dpdns.org` روی این اکانت `pending` است | لازم نیست؛ ربات روی `workers.dev` کامل کار می‌کند |

## ۸. دستورهای عملیاتی

```bash
cd ghlens
source ./.secrets.local.sh          # توکن‌ها (chmod 600، در .gitignore)

npx wrangler deploy                  # انتشار
npx tsc --noEmit && npm test         # تایپ‌چک + گارد SQL + ۲۵ تست
npx wrangler tail --format pretty    # لاگ زنده
curl -s "https://ghlens-ultra.gitguts.workers.dev/health?deep=$TG_HOOK_SECRET" | jq .
curl -s "https://ghlens-ultra.gitguts.workers.dev/health?cron=1" | jq .
bash scripts/finish-migration.sh --pat ghp_… --old-token cfut_…
```

</div>
