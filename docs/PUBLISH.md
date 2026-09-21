<div dir="rtl">

# 📦 گذاشتن پروژه روی گیت‌هاب خودت

**پاسخ کوتاه:** نه، تا الان هیچ ریپویی روی گیت‌هاب تو ساخته نشده. پروژه در «ورک‌اسپیس» ما و روی Cloudflare زنده است، ولی روی گیت‌هاب تو نه. الان همه‌چیز آماده‌ی پوش است: تاریخچه‌ی گیت ساخته شده، کامیت ثبت شده، تگ `v0.1.0` خورده و فایل‌ها برای هر سه روش زیر آماده‌اند.

> روی اکانت `Alisarani7021` در حال حاضر یک ریپوی عمومی داری (`Ancient-Iran-`). ریپوی این پروژه هنوز وجود ندارد.

---

## ⚡ روش ۱ — سریع‌ترین (اگر اجازه بدهی من انجامش دهم)

یک توکن گیت‌هاب بساز: `github.com/settings/tokens` → **Generate new token (classic)** → فقط تیک **`repo`** (و اگر می‌خواهی ریپو خصوصی باشد، همان تیک کافی است) → مقدار را همین‌جا برایم بفرست. من:

1. توکن را آزمایش می‌کنم و یوزرنیم را می‌گیرم،
2. ریپوی `ghlens-ultra` را می‌سازم (خصوصی یا عمومی — بگو کدام)،
3. همه‌ی ۵۸ فایل با پیام کامیت کامل و تگ `v0.1.0` را پوش می‌کنم،
4. و در پایان توکن را از `origin` پاک می‌کنم تا در `.git/config` نماند.

اسکریپتش همین‌جاست و خودت هم می‌توانی بزنی:

```bash
cd ghlens
bash scripts/publish-to-github.sh --token ghp_xxxxxxx --repo ghlens-ultra --private
```

قبل از پوش، اسکریپت **کل درخت پروژه را برای رشته‌های شبیه کلید اسکن می‌کند** و اگر چیزی پیدا شود، پوش را لغو می‌کند. (من همین اسکن را اجرا کردم: تمیز است.)

## 🧳 روش ۲ — خودت از همین‌جا (بدون توکن برای من)

فایلهای آماده در ورک‌اسپیس:

| فایل | چیست |
|---|---|
| `ghlens-ultra-src.tar.gz` | کل سورس (۵۸ فایل، بدون `node_modules`) — ۱.۸ مگابایت |
| `ghlens-ultra.bundle` | مخزن کامل گیت با تاریخچه و تگ — برای `git clone` روی کامپیوتر خودت |

الف) با بسته‌ی سورس: دانلود کن، در گیت‌هاب یک ریپوی خالی بساز، بعد:

```bash
tar -xzf ghlens-ultra-src.tar.gz && cd ghlens
git init -b main && git add -A
git commit -m "GitHub Lens Ultra v0.1.0"
git remote add origin https://github.com/Alisarani7021/ghlens-ultra.git
git push -u origin main --tags
```

ب) با باندل (تاریخچه هم می‌آید):

```bash
git clone ghlens-ultra.bundle ghlens-ultra
cd ghlens-ultra && git remote set-url origin https://github.com/Alisarani7021/ghlens-ultra.git
git push -u origin main --tags
```

ج) بدون هیچ ابزاری: در صفحه‌ی «New repository» گزینه‌ی **uploading an existing file** را بزن و محتویات پوشه را بکش و رها کن (فایل‌های مخفی مثل `.github/` و `.gitignore` هم مهم‌اند).

## 🤖 چیزهایی که با ریپو می‌آید

| فایل | کار |
|---|---|
| `.github/workflows/ci.yml` | روی هر پوش: تایپ‌چک + گارد SQL + ۲۵ تست + گزارش حجم باندل |
| `.github/workflows/deploy.yml` | روی پوش به `main`: تست → `wrangler deploy` → تست سلامت زنده (`/health`، `/health?deep`، `/health?cron`) |
| `.gitignore` | `.secrets.local.sh`، `.dev.vars`، `.wrangler/`، `node_modules/` را دور می‌اندازد |
| `scripts/publish-to-github.sh` | ساخت ریپو + پوش + اسکن امنیتی |
| `scripts/finish-migration.sh` | ست‌کردن توکن گیت‌هاب و پاک‌کردن اکانت قدیمی کلادفلر |
| `scripts/set-secrets.sh` · `set-webhook.sh` | بازتولید سکرت‌ها و ثبت وبهوک روی هر اکانت تازه |

برای اینکه Actions خودش دیپلوی کند، در ریپو → Settings → Secrets and variables → Actions دو سکرت بساز:

| نام | مقدار |
|---|---|
| `CLOUDFLARE_API_TOKEN` | توکن کلادفلر با دسترسی «Edit Cloudflare Workers» |
| `CLOUDFLARE_ACCOUNT_ID` | `88a4e920dc6f9606c9987b872ac9ed69` |
| `TELEGRAM_WEBHOOK_SECRET` (اختیاری) | همان مقدار سکرت ورکر، برای تست سلامت عمیق |

> توجه: دیپلوی خودکارِ Actions با `wrangler deploy` کار می‌کند، ولی **سکرت‌های ورکر** (توکن ربات و…) یک‌بار باید ست شده باشند — که الان هستند. یعنی پوش بعدی‌ات خودکار منتشر می‌شود، بدون اینکه لازم باشد چیزی را دوباره ست کنی.

## 🔐 یادآوری امنیتی

- توکن گیت‌هابی که قبلاً در چت فرستادی **کار نمی‌کند** (پاک شده و باید باطلش کرده باشی)؛ برای روش ۱ یک توکن **تازه** بساز و بعد از پوش، همان را هم باطل کن.
- توکن کلادفلر جدید را هم بعد از تمام‌شدن کارها عوض کن.
- سکرت‌های داخلی پروژه (وبهوک تلگرام، وبهوک گیت‌هاب، امضای دانلود) در فایل `.secrets.local.sh` هستند که در `.gitignore` است و **هرگز** پوش نمی‌شود.

</div>
