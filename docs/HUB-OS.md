# GHLens Ultra — Universal Hub OS

> هر اتفاقی در دنیای بیرون → یک **رویداد** → یک **ورک‌فلو** → یک **محتوا** با ثبت نسب کامل.

پیاده‌سازی هستهٔ معماری «Digital Operating System» روی Cloudflare Workers.
وضعیت هر لایه دقیقاً همان چیزی است که تست شده — نه بیشتر.

---

## وضعیت لایه‌ها

| # | لایه | وضعیت | فایل |
|---|------|--------|------|
| 1 | **Universal Bus** | ✅ زنده | `src/hub/event.ts` · `src/hub/bus.ts` |
| 2 | **Connector System** | ✅ زنده (۴ کانکتور) | `src/hub/connectors.ts` |
| 3 | **Policy Engine** | ✅ زنده (۹ قاعده) | `src/hub/policy.ts` |
| 4 | **Content Graph + DNA** | ✅ زنده | `src/hub/content.ts` |
| 5 | **Workflow Engine (App Composer)** | ✅ زنده (۱۳ نوع گره) | `src/hub/engine.ts` |
| 6 | **Mission Mode** | ✅ زنده | `src/hub/mission.ts` |
| 7 | **AI Mesh** | ✅ زنده | `src/hub/mesh.ts` |
| 8 | **Editor** (پست کانال) | ✅ زنده | `src/hub/editor.ts` |
| 9 | **Playbooks** | ✅ زنده (۳ عدد) | `src/hub/playbooks.ts` |
| 10 | **Webhook Receiver چندسرویسی** | 🔜 بعدی | — |
| 11 | **File Universe** (OCR/Transcript) | 🔜 بعدی | — |
| 12 | **Media Factory** (تصویر/ویدیو) | 🔜 بعدی | — |
| 13 | **Knowledge Graph + Semantic Search** | 🔜 بعدی | — |
| 14 | **AI Gateway** (`/v1/chat/completions`) | 🔜 بعدی | — |

---

## ۱. Universal Bus

```
هر چیزی که اتفاق می‌افتد → publish() → ذخیره → fan-out به ورک‌فلوها
```

```ts
interface HubEvent {
  id: string;          // evt_…
  type: string;        // github.release.published
  source: string;      // github | rss | http | telegram | webhook | manual
  payload: object;
  ts: number;
  trace: string;       // در تمام اجراها و محتواها کپی می‌شود
  owner_id?: number;
  dedupe?: string;     // هویت پایدار رویداد
}
```

**ایدempotency یک ایندکس Unique است، نه یک چکِ مسابقه‌ای:**
`CREATE UNIQUE INDEX idx_hub_events_dedupe ON hub_events(dedupe)`
یعنی دو وب‌هوک در یک میلی‌ثانیه هم فقط یک اجرا می‌سازند.

`eventDedupe()` عمداً **timestamp را در هش نمی‌آورد** — وگرنه ارسال دوبارهٔ
همان ریلیز یک ساعت بعد، هش متفاوت می‌گرفت و از فیلتر رد می‌شد.

---

## ۲. Connector Fabric

```ts
interface Connector {
  kind; label; emits: string[]; actions: string[];
  test?(ctx)   → آیا این تنظیمات واقعاً کار می‌کند؟
  poll?(ctx)   → «چه چیزی آن‌طرف عوض شد؟» → رویداد
  act?(ctx, action, args) → انتشار، درخواست HTTP، …
}
```

| کانکتور | emits | actions |
|---|---|---|
| `github` | `github.release.published` · `.prerelease` · `github.push.commits` | get_repo, get_readme |
| `rss` | `rss.item.new` | — |
| `http` | `http.response.received` · `http.value.changed` | request |
| `telegram` | — | publish, send_draft |

**هیچ رازی داخل config نیست.** کانکتور فقط تنظیمات نگه می‌دارد؛
اعتبارنامه‌ها از `env` خوانده می‌شوند.

`http` با `watchPath` هر API را به تریگر تبدیل می‌کند — فقط وقتی مقدار عوض
شد رویداد می‌دهد، بدون اینکه مالک منطق مقایسه بنویسد.

---

## ۳. Policy Engine

```
AI پیشنهاد می‌دهد  →  Policy اجازه می‌دهد  →  سیستم اجرا می‌کند
```

هر قاعده یک **وتو قطعی** است؛ مدل نمی‌تواند با آن بحث کند.

| قاعده | چه‌وقت |
|---|---|
| `singleDelivery` | رویداد تکراری در همین اجرا |
| `channelWired` | انتشار در کانال بدون کانال → **بلاک** |
| `sourceRequired` | کانال بدون منبع → تأیید دستی |
| `freshness` | منبع عوض شده → **بلاک** |
| `noDuplicates` | مشابه قبلی → **بلاک** |
| `checkGate` | ارزیابی خودکار رد کرد → بازبینی |
| `confidenceFloor` | <۰.۴۵ بازبینی · <۰.۷ تأیید |
| `externalPublish` | به‌طور پیش‌فرض تأیید انسانی |
| `quotaGuard` | سهمیه تمام → با دادهٔ خام |

همهٔ قاعده‌ها همیشه اجرا می‌شوند و خروجی یک ورڈیکت است، نه boolean.

---

## ۴. Content Graph + DNA

```
SOURCE ──derived_from──▶ POST ──variant──▶ IMAGE PROMPT
                          │
                     translated
                          ▼
                    POST(ru) / POST(zh)
```

- **Staleness منتشر می‌شود:** منبع عوض شود → کل زیردرخت `stale` می‌شود
- **کارایی به DNA برمی‌گردد:** بازدید/فوروارد روی همان منبع ثبت می‌شود

```ts
interface ContentDNA {
  topic; lang; tone; length; source; entities[]; keywords[];
  media[]; audience; format; confidence; models[]; performance?;
}
```

---

## ۵. Workflow Engine

گره‌ها: `trigger` · `ai` · `compose.release` · `http` · `transform` ·
`condition` · `policy` · `content` · `approval` · `notify` · `connector` ·
`delay` · `stop`

سه قاعده‌ای که موتور نمی‌شکند:

1. **اجرا ادامه‌پذیر است** — گرهٔ `approval` اجرا را یک روز متوقف می‌کند و
   دقیقاً از همان‌جا ادامه می‌دهد (frontier در `hub_runs.output` ذخیره می‌شود)
2. **هر گام قابل بازرسی است** — kind، ms و خلاصه در `hub_runs.steps`
3. **خطا محصور است** — یک گرهٔ خراب فقط اجرای خودش را متوقف می‌کند

---

## ۶. Mission Mode

```
«هر روز اخبار مهم AI رو پیدا کن، تکراری‌ها رو حذف کن، فارسی کن و قبل از
 انتشار بهم نشون بده»
              ↓  Mission Planner
        Workflow DAG معتبر
```

دو چیزی که آن را صادق نگه می‌دارد:

1. **مدل فقط می‌تواند از گره‌هایی استفاده کند که وجود دارند.** خروجی با
   فهرست واقعی گره‌ها اعتبارسنجی می‌شود؛ گرهٔ اختراعی repair می‌شود.
2. **هر مأموریت به‌عنوان داده ذخیره می‌شود، نه کد** — در `hub_workflows`.
3. **اگر چیزی می‌تواند منتشر کند، گرهٔ policy اجباری می‌شود** — حتی اگر
   مدل یادش برود.

---

## ۷. AI Mesh

```
request → Task Analyzer → کدام مدل؟ → موازی → Critic → Synthesis
```

`MODEL_CAPS` می‌گوید هر tier در چه کاری خوب است. `route(kind, breadth)`
ارزان‌ترین مدل مناسب را انتخاب می‌کند.

- **breadth = 1** برای ترجمهٔ معمولی (ارزان)
- **breadth = 3** برای مأموریتی که مالک صریحاً اجرا کرده

اگر Critic یک برندهٔ روشن پیدا کند، **همان متن بدون بازنویسی** استفاده
می‌شود — بازنویسی یک جواب خوب ریسک بدتر شدن دارد.

`meshConfidence()` از **توافق بین مدل‌ها** ساخته می‌شود، نه از اعتماد
خودگزارشی مدل (که بدنام است).

---

## ۸. Editor — چیزی که به کانال می‌رود

```
🚀 نسخهٔ جدید منتشر شد
┌ repo
├ نام نسخه
└ v2.5.5 · ۱ مهر ۱۴۰۵

<blockquote>… چنج‌لاگ خوانا …</blockquote>

⬇️ دانلود — 🍎 مک ×2 · 🐧 لینوکس ×2 · 🪟 ویندوز
```

مراحل ایمنی متن:

1. `markdownToTelegramHtml` — HTML خام را به placeholder منتقل می‌کند،
   بقیهٔ متن را escape می‌کند، سپس تگ‌ها از allowlist رد می‌شوند
2. `restoreTag` — تگ‌های ناشناس **باز می‌شوند** (نه escape)، `script` حذف
3. `balanceTags` — تگ بسته‌نشده باعث می‌شود تلگرام **کل پیام** را رد کند
4. `classifyAsset` / `groupAssets` — نویز (`.sig`/`.sha256`/`.blockmap`) حذف،
   ترتیب خوانا: مک → لینوکس → ویندوز → اندروید

---

## خط لولهٔ تأییدشده (زنده)

```
github.release.published
  → 🧠 AI (synthesis) · 403 نویسه · اطمینان ۸۷٪
  → 🧩 کارت انتشار با ۵ فایل
  → 🔀 شرط
  → 🔐 سیاست: مجاز (approval)
  → 🕸 محتوا ثبت شد
  → 🕹 منتظر تأیید انسانی
```

و ارسال دوبارهٔ همان ریلیز: `🔁 این رویداد قبلاً پردازش شده بود`.
