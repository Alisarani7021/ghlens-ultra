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
| 7 | **AI Mesh** (چندمدلی + داور + سنتز) | ✅ زنده | `src/hub/mesh.ts` |
| 8 | **Editor** (پست کانال) | ✅ زنده | `src/hub/editor.ts` |
| 9 | **Playbooks** | ✅ زنده (۳ عدد) | `src/hub/playbooks.ts` |
| 10 | **Webhook Receiver** (HMAC هر سرویس) | ✅ زنده | `src/hub/hooks.ts` |
| 11 | **File Universe** | ✅ زنده (بدون صوت) | `src/hub/files.ts` |
| 12 | **Media Factory** (تصویر) | ✅ زنده (بدون صوت) | `src/hub/media.ts` |
| 13 | **Knowledge Graph + Semantic Search** | ✅ زنده | `src/hub/knowledge.ts` |
| 14 | **AI Gateway** (`/v1/chat/completions`) | ✅ زنده | `src/hub/gateway.ts` |
| 15 | **File ingest over HTTP** | ✅ زنده | `POST /hub/ingest` |

خارج از دامنه، به‌عمد: **صوت و ویدیو** (طبق درخواست صریح — هیچ مسیر صوتی در ربات نیست)،
**OCR روی PDF اسکن‌شده** (صادقانه «متن پیدا نشد» گزارش می‌شود)، **ترنسکریپت** و **گویندگی**.

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

---

## ۱۶. چه چیزی واقعاً زنده تست شد (نه ادعا)

هر مورد زیر با یک فراخوانی واقعی روی دیپلویِ جاری تأیید شده است:

```
# وب‌هوک: امضای غلط رد می‌شود، امضای درست رویداد می‌سازد
POST /hooks/github/hk_secret_demo_1   sha256=deadbeef  → HTTP 401
POST /hooks/github/hk_secret_demo_1   sha256=<real>    → {ok, type: github.release.published, runs:[…]}
POST (همان بدنه، بار دوم)                               → duplicate: true, runs: []   ← idempotency
POST با مخزن غیرمشترک                                   → ignored: "repo not watched"

# فایل: بدون تلگرام هم قابل تست است
POST /hub/ingest?name=guide.md      → markdown · ۸۱ نویسه · ۴ موجودیت · برداری شد
POST /hub/ingest?name=build.pdf     → pdf · ۶۴ نویسه · ۳ موجودیت · برداری شد
POST /hub/ingest?name=runtime.pdf   → pdf · «متن پیدا نشد — احتمالاً اسکن‌شده» (صادقانه)

# مسیر تأیید و انتشار (کامل، از دکمه تا کانال)
press hos:ok:<run_id> → run از فرانتیر ادامه می‌یابد → نود connector منتشر می‌کند
                      → ۱ پست در کانال، ۵ دکمهٔ دانلود (هر دارایی یکی) + لینک پروژه در متن
                      → run.state = ok، گام‌ها: send | connector ✓ · done | stop

# دروازهٔ AI (سازگار با OpenAI)
GET  /v1/models                → ۵ شناسه
POST /v1/chat/completions      → بدون کلید/کلید غلط: 401
                             → ghlens-fast: پاسخ فارسی، usage 19/25/44، routing {chosen:fast, task:compose}
                             → ghlens-mesh: دو پاسخ یکسان JSON → agreement 1.0 (قبلاً 0.0 — باگ توکنایزر)
                             → stream: true → chat.completion.chunk … [DONE]

# گراف دانش و جست‌وجو
hos:search «…نسخه جدید رانتایم جاوااسکریپت…» (بدون کلمهٔ مشترک) → «Bun v1.2.0» ۵۵٪ · via: semantic
```

### باگ‌هایی که همین تست‌ها پیدا کردند و بسته شدند

- **`embedDocument` ترتیب bind را عوض می‌کرد** — وکتور در ستون `dim`، تایم‌استمپ در `embedding`،
  و INSERT موفق می‌شد. حالا مقادیر موقعیتی و یک‌به‌یک به ستون‌ها bind می‌شوند و یک رگرسیون با D1 تقلبی
  ستون‌ها را با مقادیر تطبیق می‌دهد. (قاعده: هیچ‌وقت spread نکن وقتی مقادیر و placeholderها از یک آرایه نمی‌آیند.)
- **`agreement()` دو پاسخ یکسان را ۰ می‌داد** — توکنایزر کلمات ≤۲ حرف را دور می‌ریخت و `{"a": 7, "b": 4}`
  تمامش همین بود. حالا فهرست stop-word اسمی + مقایسهٔ کاراکتری برای پاسخ‌های کوتاه.
- **تأیید از کارت ورک‌فلو دکمهٔ مرده بود** — دکمه `hos:ok:<run_id>` می‌فرستاد و هندلر آن را
  شناسهٔ محتوا فرض می‌کرد → `?`. حالا run→content حل می‌شود و گره تأیید واقعاً از سر گرفته می‌شود.
- **تأیید دو بار منتشر می‌کرد** — هندلر خودش منتشر می‌کرد و run ادامه‌یافته هم نود connector خودش را
  دوباره اجرا می‌کرد؛ کانال دو پست یکسان گرفت (زنده اندازه‌گیری شد). حالا فقط run منتشر می‌کند و
  هندلر تنها وقتی منتشر می‌کند که run چیزی منتشر نکرده باشد.
- **متن منتشرشدهٔ اجرای ادامه‌یافته ممکن بود نصفه باشد** — `trimBag` هر مقدار ذخیره‌شده را در
  ۱۲۰۰ نویسه می‌بُرد. حالا متن و کیبورد از ردیف محتوا بازخوانی می‌شوند (محتوا منبع حقیقت است، bag فقط کش).
- **`hos:edit` هیچ هندلری نداشت** — دکمه بود و کار نمی‌کرد. حالا حالت ورودی می‌شود و پس از جایگزینی
  متن، هم دوباره برداری می‌شود هم کارت تأیید برمی‌گردد.
- **رد کردن، run را معلق می‌گذاشت** — کارت «رد» پیش‌نویس را blocked می‌کرد ولی run تا ابد `waiting`
  می‌ماند. حالا رد کردن، run را با یک گام صادقانه می‌بندد.
