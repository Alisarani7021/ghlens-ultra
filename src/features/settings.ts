import type { H } from "../core/handler";
import type { Env } from "../env";
import { fmt } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb, L, type Loc } from "../tg/keyboards";
import { aside, details, footer, h1, hr, p, table, ul } from "../tg/rich";

/** Language, help, about and inline-mode. */
export class Settings {
  async lang(h: H) {
    const fa = h.loc === "fa";
    const options: [Loc, string, string][] = [
      ["fa", "🇮🇷 پارسی", "Persian"],
      ["en", "🇺🇸 English", "English"],
      ["ar", "🇸🇦 العربية", "Arabic"],
      ["ru", "🇷🇺 Русский", "Russian"],
      ["zh", "🇨🇳 中文", "Chinese"],
    ];
    await h.reply(
      `🌐 <b>${fa ? "انتخاب زبان" : "Choose your language"}</b>\n\n${fa ? "زبان رابط ربات و زبان ترجمه‌های README را تعیین می‌کند." : "Sets UI + README translation language."}`,
      kb(
        ...options.map(([loc, label, native]) => [{ text: `${label}${loc === h.loc ? " ✅" : ""}`, cb: `lang:set:${loc}` }]),
        
      ),
      !!h.cbId,
    );
  }

  async setLang(h: H, loc: Loc) {
    await h.store.setLocale(h.u.id, loc);
    h.loc = loc;
    const toastMsg = loc === "fa" ? "✅ زبان به پارسی تغییر کرد" :
                    loc === "ar" ? "✅ تم تغيير اللغة إلى العربية" :
                    loc === "ru" ? "✅ Язык изменен на русский" :
                    loc === "zh" ? "✅ 语言已更改为中文" : "✅ Language updated to English";
    await h.toast(toastMsg);
    await this.home(h, loc);
  }

  /**
   * The welcome banner.
   *
   * Telegram keeps the image and hands back a `file_id`; sending by that id
   * means every /start shows the artwork without uploading a byte, and no CDN,
   * bucket or static route has to exist for one picture. If the id ever goes
   * stale (bot moved, file re-uploaded) sendPhoto fails and the welcome card
   * still arrives — the picture is decoration, never a dependency.
   */
  private static readonly START_BANNER =
    "AgACAgQAAxkDAAICR2q0Kzc9gh09PPk9AAHe34LMS6liZwACuw9rGzOloFFvA9miDkY3WgEAAwIAA3kAAz0E";

  private static readonly START_CAPTION_FA =
    "🔭 <b>GitHub Lens Ultra</b>\n" +
    "<b>هر مخزنی، هر نسخه‌ای، هر آسیب‌پذیری — از پشت یک لنز.</b>\n" +
    "<i>کاوش · ترجمه · امنیت · دانلود · هاب جهانی رویدادها — کاملاً روی کلودفلر</i>";

  private static readonly START_CAPTION_EN =
    "🔭 <b>GitHub Lens Ultra</b>\n" +
    "<b>Every repo, every release, every vulnerability — through one lens.</b>\n" +
    "<i>Search · translate · audit · download · an event-driven hub — all on Cloudflare</i>";

  /**
   * The welcome screen.
   *
   * The owner's ask: after /start it must (a) say hello and explain what the
   * bot can do, and (b) immediately ask for the GitHub token so the account gets
   * linked right there — nobody should have to discover that later. Capabilities
   * are a compact list, not a wall of emoji, and the onboarding card shows the
   * real state (linked or not).
   */
  async home(h: H, loc?: Loc, opts?: { force?: boolean }) {
    const lang = loc ?? h.loc;
    const fa = lang === "fa";
    const u = await h.store.user(h.u.id);
    const linked = !!(u as any)?.github_login;
    const aiState = await aiEngineState(h.env);

    // The owner's ask for this screen: bolder, wider, worth reading. Six equal
    // bullets said what the bot has; this says what it is for.
    // ── the welcome card, as a rich message ────────────────────────────────
    // Tables and collapsible blocks are what make this screen scannable: eight
    // capability lines become a two-column table, and the deeper material folds
    // away until someone wants it. `replyRich` degrades on its own if the API
    // in front of the bot cannot render rich messages.
    const capTable = table(
      [
        [fa ? "بخش" : "Area", fa ? "چه می‌کند" : "What it does"],
        ["🔍 " + (fa ? "جست‌وجو" : "Search"), fa
          ? "معنایی + متنی، هر زبانی؛ «یک کتابخانهٔ سبک برای صف در Go» را می‌فهمد"
          : "Semantic + lexical, any language — describe it the way you'd say it"],
        ["🛰 " + (fa ? "کاوش" : "Scout"), fa
          ? "۱۲ تب: رشد، ضریب اتوبوس، نرخ مرج، ریلیزها، CI، امنیت، چنج‌لاگ"
          : "12 tabs: growth, bus factor, merge rate, releases, CI, security"],
        ["🧠 " + (fa ? "هوش مصنوعی" : "AI"), fa
          ? "۱۱ مدل؛ چت با مخزن با استناد، ترجمهٔ README، بازبینی PR، ورک‌فلو"
          : "11 models; repo chat with citations, README translation, PR review"],
        ["📥 " + (fa ? "دانلود" : "Download"), fa
          ? "زیپ یا تار، کش، تقسیم خودکار برای مخزن‌های بزرگ"
          : "zip or tar, cached, auto-split for large repositories"],
        ["🛡 " + (fa ? "امنیت" : "Security"), fa
          ? "اسکن وابستگی با OSV، شکار کلید لو‌رفته، هشدار CVE"
          : "OSV dependency scan, leaked-key hunt, CVE alerts"],
        ["🧰 " + (fa ? "ابزار" : "Toolbox"), fa
          ? "IP/DNS/ASN/TLS، JWT، هش، کرون، CIDR، رجکس و ۱۵ ابزار دیگر"
          : "IP/DNS/ASN/TLS, JWT, hashes, cron, CIDR, regex and 15 more"],
        ["🌌 " + (fa ? "هاب جهانی" : "Universal hub"), fa
          ? "رویداد می‌گیرد، ورک‌فلو می‌سازد، پست را آماده می‌کند و با تأیید تو منتشر می‌کند"
          : "Takes events, runs workflows, drafts the post, publishes on your word"],
      ],
      { caption: fa ? "⚡ چه کارهایی از دستم برمی‌آید" : "⚡ What I can do" },
    );

    const startHere = details(
      fa ? "🎯 از کجا شروع کنیم؟" : "🎯 Start here",
      ul(
        fa
          ? [
              "یک موضوع بنویس → <i>جست‌وجوی معنایی</i>",
              "یک <code>owner/repo</code> بفرست → <i>پروندهٔ کامل مخزن</i>",
              "<code>/help</code> → همهٔ ۹۳ فرمان، دسته‌بندی‌شده",
            ]
          : [
              "Type a topic → <i>semantic search</i>",
              "Send an <code>owner/repo</code> → <i>the full dossier</i>",
              "<code>/help</code> → all 93 commands, grouped",
            ],
      ),
      true,
    );

    const hubCard = details(
      fa ? "🌌 هاب جهانی چطور کار می‌کند؟" : "🌌 How the hub works",
      p(fa
        ? "یک رویداد از بیرون می‌آید (انتشار، پست RSS، تغییر یک API)، ورک‌فلو اجرا می‌شود، " +
          "متن پست ساخته می‌شود و <b>هیچ‌چیز بدون تأیید تو منتشر نمی‌شود</b>. " +
          "دسترسی: <code>/hub</code>"
        : "An event arrives (a release, an RSS item, an API change), a workflow runs, the post is drafted, " +
          "and <b>nothing is published without your approval</b>. Open it with <code>/hub</code>."),
    );

    const privacy = details(
      fa ? "🔐 حساب، کلید و زبان" : "🔐 Account, keys and language",
      ul(
        fa
          ? [
              `<code>/connect</code> — وصل‌کردن گیت‌هاب با توکن کم‌دسترسی (سقف ۵٬۰۰۰ درخواست در ساعت)`,
              `<code>/keys</code> — اهدای کلید هوش مصنوعی؛ با هم استفاده می‌شود و کلید مرده خودکار حذف می‌شود`,
              `<code>/language</code> — فارسی · انگلیسی · عربی · روسی · چینی`,
            ]
          : [
              `<code>/connect</code> — link GitHub with a least-privilege token (5,000 requests/hour)`,
              `<code>/keys</code> — donate an AI key; the pool is shared and dead keys are evicted`,
              `<code>/language</code> — Persian · English · Arabic · Russian · Chinese`,
            ],
      ),
    );

    const login = String((u as any)?.github_login ?? "") || (fa ? "وصل نشده" : "not linked");

    const helloRich =
      h1("🔭 GitHub Lens Ultra") +
      aside(fa
        ? `سلام${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""}! ایستگاهِ کاوشِ اوپن‌سورس — گیت‌هاب را می‌کاوم، فارسی‌اش می‌کنم، امنیتش را چک می‌کنم، دانلودش می‌کنم.`
        : `Welcome${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""} — an open-source observatory: search it, translate it, audit it, download it.`) +
      capTable +
      startHere + hubCard + privacy +
      hr() +
      footer(
        `🐙 <code>${tgEscape(login)}</code> · 🧠 ${aiState} · ` +
        (fa ? "۹۳ فرمان" : "93 commands") +
        ` · <a href="https://github.com/Alisarani7021/ghlens-ultra">github.com/Alisarani7021/ghlens-ultra</a>`,
      );

    await h.replyRich(
      helloRich,
      mainMenuKb(lang, u?.plan === "admin") as any,
    );
  }

  /** /help — the honest, complete command reference. */
  /**
   * /help — every feature of the bot, in one place.
   *
   * It used to be a single 3900-character string: everything past that point
   * was silently sliced off, which is exactly how "the help does not mention the
   * hub" happens. It is now a list of sections, packed into as many messages as
   * they need, split only at section boundaries so no HTML tag is ever cut in
   * half — and the hub gets its own section, because it grew a lot of surface.
   */
  async help(h: H) {
    const fa = h.loc === "fa";

    const FA: string[] = [
      `📚 <b>راهنمای کامل GitHub Lens Ultra</b>\n<i>همهٔ قابلیت‌ها، دسته‌بندی‌شده — هر بخش دکمه‌های خودش را دارد.</i>`,

      `<b>🚀 شروع سریع</b>\n` +
        `• هر موضوعی بنویس (<code>react state management</code>) → جست‌وجوی معنایی\n` +
        `• هر <code>owner/repo</code> بفرست → پروندهٔ کامل مخزن\n` +
        `• هر سؤالی بفرست → دستیار AI با دادهٔ زنده\n` +
        `• <code>/start</code> → خانه و منوی اصلی`,

      `<b>🔍 کشف</b>\n` +
        `<code>/search [موضوع]</code> — جست‌وجوی هیبرید (معنایی + متنی) با ترجمهٔ خودکار درخواست\n` +
        `<code>/trending</code> — داغ‌ترین‌ها: روزانه/هفتگی/ماهانه/همیشه + فیلتر زبان، آمار واقعی\n` +
        `<code>/browse</code> — مرور دسته‌بندی‌شده (AI، امنیت، دواپس، وب، موبایل، OSINT…)\n` +
        `<code>/gems</code> — گنج‌های پنهان: کیفیت بالا، ستاره کم\n` +
        `<code>/random</code> — کشف تصادفی وزن‌دار بر اساس علاقه‌مندی\n` +
        `<code>/feed</code> — فید شخصی`,

      `<b>🛰 تحلیل عمیق</b>\n` +
        `<code>/scout owner/repo</code> — ۱۲ تب: نما، رشد، زبان‌ها، جامعه، ریلیزها، ایشوها، PRها، کامیت‌ها، CI، امنیت، چنج‌لاگ، مشارکت\n` +
        `<code>/compare a/b c/d</code> · <code>/changelog</code> · <code>/chart</code> · <code>/files</code> · <code>/card</code>`,

      `<b>🤖 هوش مصنوعی</b>\n` +
        `<code>/ask</code> دستیار · <code>/repochat owner/repo</code> چت با مخزن (با منبع)\n` +
        `<code>/ai</code> تحلیل ساختاریافته · <code>/translate</code> ترجمهٔ README \n` +
        `<code>/workflow</code> ساخت GitHub Actions · <code>/review owner/repo#12</code> بازبینی PR · <code>/code</code> توضیح کد\n` +
        `<i>چند مدل موازی، داور و سنتز — جزئیات در دروازهٔ AI پایین‌تر.</i>`,

      `<b>📥 دانلود</b>\n` +
        `<code>/dl owner/repo [@ref] [zip|tar]</code> — دانلود مستقیم با کش و تقسیم خودکار\n` +
        `<code>/secrets owner/repo</code> — شکار کلید لو‌رفته · <code>/security owner/repo</code> — اسکن وابستگی‌ها (OSV)`,

      `<b>🛡 امنیت</b>\n<code>/scan</code> — اسکن کامل مخزن + نمره + اصلاحیه · <code>/cve</code> — هشدارهای تازه`,

      `<b>🧰 ابزارها</b>\n` +
        `<code>/tools</code> تبدیل پکیج (deb/rpm/arch/apk) · <code>/ip 1.1.1.1</code> · <code>/asn 13335</code>\n` +
        `<code>/dev</code> — کرون، رجکس، CIDR، JWT، Base64، هش، UUID، زمان، JSON، .gitignore، SemVer، رنگ`,

      `<b>📡 رادار اینترنت آزاد</b>\n<code>/netradar</code> — وضعیت شبکه، ابزارهای آزادی اینترنت و منابع به‌روز.`,

      `<b>🌌 هاب جهانی</b> — از <code>⚙️ تنظیمات → «🌌 هاب جهانی»</code>\n` +
        `<i>هر اتفاق بیرون → رویداد → ورک‌فلو → محتوا → تأیید تو → انتشار</i>\n` +
        `• 🧪 <b>مأموریت</b> — یک جمله بگو؛ خودش ورک‌فلو می‌سازد و اجرا می‌کند\n` +
        `• 📚 <b>برنامه‌های آماده</b> — انتشار نسخه در کانال · خلاصهٔ RSS · هشدار تغییر صفحه\n` +
        `• 🔌 <b>کانکتورها</b> — گیت‌هاب / RSS / HTTP / تلگرام + تست واقعی + «دریافت الان»\n` +
        `• 🎯 <b>رویدادها</b> — و «🧪 رویداد آزمایشی» برای تست کل مسیر\n` +
        `• 🕹 <b>صف تأیید</b> — ✅ انتشار (دقیقاً یک‌بار) · ✏️ ویرایش متن · 🗑 رد\n` +
        `• ⚙️ <b>ورک‌فلوها</b> · 🕸 <b>گراف محتوا</b> · 📊 <b>اجراها</b> — چه گره‌ای، چند میلی‌ثانیه، با چه نتیجه‌ای\n` +
        `• 🧠 <b>دانش و جست‌وجوی معنایی</b> — یک جمله بنویس، بدون کلیدواژه\n` +
        `• 📄 <b>کالبدشکافی فایل</b> — فایل بفرست: متن، ساختار، موجودیت‌ها، برداری برای جست‌وجو\n` +
        `• 🖼 <b>کارخانهٔ رسانه</b> — کاور SVG + پرامپت تصویر انگلیسی + متن جانشین فارسی\n` +
        `• 🔌 <b>وبهوک و گیت‌وی</b> — آدرس وبهوک هر سرویس + دروازهٔ سازگار با OpenAI (<code>/v1/chat/completions</code>) با ۵ مدل\n` +
        `• 🚀 <b>ساخت نمونهٔ شخصی</b> — کپی ربات روی حساب کلاودفلر خودت، یک‌کلیکی\n` +
        `• 📖 <b>راهنما: از کجا چه کاری</b> — همان راهنمای دکمه‌ای داخل هاب`,

      `<b>🤝 کلید هوش مصنوعی</b>\n` +
        `<code>/keys</code> — استخر کلیدهای اهدایی: کلید خودت را بده، اول تست می‌شود، بعد همهٔ قابلیت‌های AI با کلیدهای همه کار می‌کنند.`,

      `<b>🐙 حساب گیت‌هاب</b>\n` +
        `<code>/connect</code> یا دکمهٔ «🐙 حساب گیت‌هاب» — یک دکمهٔ توکن می‌سازد (دسترسی‌ها از قبل تیک خورده)، توکن را بفرست و حساب وصل می‌شود.`,

      `<b>👤 حساب من</b>\n` +
        `<code>/profile</code> پروفایل و نشان‌ها · <code>/dashboard</code> آمار ۳۰ روزه و مصرف AI\n` +
        `<code>/favorites</code> · <code>/subs</code> · <code>/interests</code> · <code>/refer</code> · <code>/language</code> (fa/en/ar/ru/zh)`,

      `<b>🌱 مشارکت</b>\n<code>/contribute</code> — فرصت‌ها، راهنمای اولین PR، برنامهٔ ۷ روزه`,

      `<b>⚡ نکته‌ها</b>\n` +
        `• دکمه‌های زیر هر پیام یک لایه عمیق‌ترند؛ «◀️ بازگشت» همیشه هست\n` +
        `• با ⭐ ذخیره کن و با 🔔 از ریلیز و امنیت باخبر شو\n` +
        `• در چت خصوصی، حالت inline هم کار می‌کند: <code>@ربات نام مخزن</code>\n` +
        `• متن‌های بلند را کامل می‌فرستم؛ چیزی بریده نمی‌شود.`,
    ];

    const EN: string[] = [
      `📚 <b>GitHub Lens Ultra — complete reference</b>\n<i>Every feature, grouped. Each section has its own buttons.</i>`,

      `<b>🚀 Quick start</b>\n` +
        `• Send a topic → semantic search\n• Send an <code>owner/repo</code> → full dossier\n` +
        `• Ask anything → the AI assistant with live data\n• <code>/start</code> → home`,

      `<b>🔍 Discovery</b>\n` +
        `<code>/search</code> hybrid semantic + lexical · <code>/trending</code> real growth boards\n` +
        `<code>/browse</code> curated categories · <code>/gems</code> hidden gems · <code>/random</code> · <code>/feed</code>`,

      `<b>🛰 Deep scout</b>\n` +
        `<code>/scout owner/repo</code> 12 tabs · <code>/compare a/b c/d</code> · <code>/changelog</code> · <code>/chart</code> · <code>/files</code> · <code>/card</code>`,

      `<b>🤖 AI</b>\n` +
        `<code>/ask</code> · <code>/repochat</code> · <code>/ai</code> · <code>/translate</code> · <code>/workflow</code> · <code>/review</code> · <code>/code</code>\n` +
        `<i>Parallel models, a critic and synthesis — see the AI gateway below.</i>`,

      `<b>📥 Download &amp; audit</b>\n` +
        `<code>/dl owner/repo [@ref] [zip|tar]</code> · <code>/secrets owner/repo</code> · <code>/security owner/repo</code>\n` +
        `<code>/scan</code> full repo scan with a score · <code>/cve</code> recent advisories`,

      `<b>🧰 Toolbox</b>\n<code>/tools</code> · <code>/ip</code> · <code>/asn</code> · <code>/dev</code> (cron, regex, CIDR, JWT, hash, UUID, JSON…)`,

      `<b>📡 Net Radar</b>\n<code>/netradar</code> — network status and internet-freedom resources.`,

      `<b>🌌 Universal hub</b> — <code>Settings → Universal Hub</code>\n` +
        `<i>event → workflow → content → your approval → publish</i>\n` +
        `• 🧪 <b>Mission</b> — one sentence in, a workflow out\n` +
        `• 📚 <b>Playbooks</b> — release-to-channel · RSS digest · page-change alert\n` +
        `• 🔌 <b>Connectors</b> — github / rss / http / telegram, real tests, «Fetch now»\n` +
        `• 🎯 <b>Events</b> — and a test event that runs the whole path\n` +
        `• 🕹 <b>Approval queue</b> — ✅ publish exactly once · ✏️ edit · 🗑 reject\n` +
        `• ⚙️ <b>Workflows</b> · 🕸 <b>Content graph</b> · 📊 <b>Runs</b> (node by node)\n` +
        `• 🧠 <b>Knowledge &amp; semantic search</b> — a sentence, no keyword needed\n` +
        `• 📄 <b>File dissection</b> — text, structure, entities, embeddings\n` +
        `• 🖼 <b>Media factory</b> — SVG cover + image prompt + alt text\n` +
        `• 🔌 <b>Webhooks &amp; gateway</b> — per-source hooks and an OpenAI-compatible endpoint\n` +
        `• 🚀 <b>Self-host</b> — your own copy, one click`,

      `<b>🤝 AI keys</b> · <b>🐙 GitHub</b> · <b>👤 Account</b>\n` +
        `<code>/keys</code> donate a key · <code>/connect</code> link GitHub · <code>/profile</code> · <code>/dashboard</code> · ` +
        `<code>/favorites</code> · <code>/subs</code> · <code>/language</code>`,

      `<b>🌱 Contribute</b>\n<code>/contribute</code> — opportunities, first-PR guide, a 7-day plan.`,
    ];

    const sections = fa ? FA : EN;

    // One rich message instead of two paginated ones: the title is a heading,
    // every section folds into `<details>`, and the first two are open so the
    // message still reads as a page rather than a pile of collapsed rows.
    const rich =
      h1(fa ? "📚 راهنمای کامل" : "📚 Complete reference") +
      p(fa
        ? "همهٔ ۹۳ فرمان، دسته‌بندی‌شده. هر بخش را باز کن؛ عنوانش را لمس کن."
        : "All 93 commands, grouped. Tap a section title to unfold it.") +
      sections
        // the first entry is the document's own title, and the rich message
        // already has an <h1> — keeping it produced an empty "📚" section
        .slice(1)
        .map((sec, i) => {
          const m = sec.match(/^(?:<b>)?([^<\n]+)(?:<\/b>)?\n?([\s\S]*)$/);
          const title = (m?.[1] ?? "").trim();
          const body = (m?.[2] ?? "").trim();
          return details(title, body ? sectionBody(body) : "", i < 2);
        })
        .join("") +
      hr() +
      footer(fa
        ? `۹۳ فرمان · ۵ زبان · <a href="https://github.com/Alisarani7021/ghlens-ultra">ghlens-ultra</a>`
        : `93 commands · 5 languages · <a href="https://github.com/Alisarani7021/ghlens-ultra">ghlens-ultra</a>`);

    await h.replyRich(
      rich,
      kb(
        [
          { text: "🔍 " + (fa ? "جست‌وجو" : "Search"), cb: "n:search" },
          { text: "🔥 " + (fa ? "داغ‌ترین" : "Trending"), cb: "t:menu" },
          { text: "🛰 " + (fa ? "کاوش" : "Scout"), cb: "s:home" },
        ],
        [
          { text: "🤖 AI", cb: "a:home" },
          { text: "📥 " + (fa ? "دانلود" : "Download"), cb: "d:home" },
          { text: "🧰 " + (fa ? "ابزارها" : "Tools"), cb: "u:home" },
        ],
        [
          { text: "🌌 " + (fa ? "هاب جهانی" : "Universal hub"), cb: "hos:home" },
          { text: "🌐 " + (fa ? "زبان" : "Language"), cb: "lang:menu" },
        ],
      ),
      !!h.cbId,
    );
  }


  
/** About — the honest pitch, including the limits. */
  async about(h: H) {
    const fa = h.loc === "fa";
    const stats = await h.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM repo_snapshots) AS snaps`,
    ).first<any>().catch(() => null);
    await h.reply(
      `ℹ️ <b>GitHub Lens Ultra</b> v1.0\n\n` +
        (fa
          ? `ربات کشف و تحلیل اوپن‌سورس، ۱۰۰٪ روی لبه Cloudflare:\n` +
            `• <b>Workers</b> برای منطق و وبهوک تلگرام\n• <b>D1</b> برای داده و اسنپ‌شات‌ها\n• <b>R2</b> برای آرشیو سورس و پادکست\n` +
            `• <b>Vectorize</b> برای جست‌وجوی معنایی\n• <b>Workers AI</b> برای ترجمه، تحلیل، خلاصه، صدا\n` +
            `• <b>Queues</b> برای کارهای سنگین و <b>Durable Objects</b> برای حالت گفت‌وگو\n` +
            `• <b>GitHub Actions</b> به‌عنوان کارخانه سنگین (تقسیم ۷z، تبدیل پکیج)\n\n` +
            `📊 ${fa ? "آمار زنده" : "live stats"}: ${fmt(stats?.repos ?? 0)} ${fa ? "مخزن فهرست‌شده" : "indexed repos"} · ` +
            `${fmt(stats?.users ?? 0)} ${fa ? "کاربر" : "users"} · ${fmt(stats?.snaps ?? 0)} ${fa ? "اسنپ‌شات" : "snapshots"}\n\n` +
            `🎯 <b>چه چیزی واقعی است؟</b> همه اعداد از API خود گیت‌هاب و OSV می‌آید؛ AI فقط خلاصه و ترجمه می‌کند و هرگز عدد نمی‌سازد.\n` +
            `⚠️ <b>محدودیت‌ها:</b> سقف ۴۹ مگابایت آپلود تلگرام (به همین دلیل تقسیم پارت‌ها)، سهمیه رایگان Workers AI و نرخ ۵۰۰۰ درخواست/ساعت گیت‌هاب.`
          : `Cloudflare-native (Workers, D1, R2, Vectorize, Workers AI, Queues, DO) + GitHub Actions helper.
All numbers come from GitHub's and OSV's real APIs; AI only summarises.`) +
        `\n\n🔗 t.me/RepoFA · x.com/PersianGitHub`,
      kb(
        [
          { text: "📚 " + (fa ? "راهنما" : "Help"), cb: "h:main" },
        ],
        
      ),
      !!h.cbId,
    );
  }
}

function mainMenuKb(loc: Loc, isAdmin: boolean) {
  const fa = loc === "fa";
  return kb(
    // The donated-key engine sits at the top: it is the one thing that turns
    // every AI feature on, and the owner asked for it on the main page.
    [
      { text: "🤝 " + (fa ? "اهدای کلید هوش مصنوعی" : "Donate an AI key"), cb: "keys:home" },
      { text: "🐙 " + (fa ? "حساب گیت‌هاب" : "GitHub account"), cb: "gh:home" },
    ],
    [
      { text: L(loc, "search"), cb: "n:search" },
      { text: L(loc, "trending"), cb: "t:menu" },
    ],
    [
      { text: L(loc, "browse"), cb: "b:menu" },
      { text: L(loc, "discover"), cb: "x:gems" },
    ],
    [
      { text: L(loc, "scout"), cb: "s:home" },
      { text: L(loc, "ai"), cb: "a:home" },
    ],
    [
      { text: L(loc, "inbox"), cb: "d:home" },
      { text: L(loc, "security"), cb: "sec:home" },
    ],
    [
      { text: L(loc, "tools"), cb: "u:home" },
      { text: L(loc, "devutils"), cb: "dvu:home" },
    ],
    [
      { text: L(loc, "contribute"), cb: "c:home" },
      { text: "📡 " + (fa ? "رادار اینترنت آزاد" : "Net Radar"), cb: "nr:home" },
    ],
    [
      { text: "🌐 " + (fa ? "ابر‌مرکز دوآپس و هوش مصنوعی" : "Cloud & AI Hub"), cb: "hub:home" },
    ],
    [
      { text: "🌌 " + (fa ? "هاب جهانی — اتوماسیون و رویدادها" : "Universal Hub — events & automation"), cb: "hos:home" },
    ],
    [
      { text: L(loc, "fav"), cb: "f:list" },
      { text: L(loc, "subs"), cb: "sub:list" },
    ],
    [
      { text: L(loc, "profile"), cb: "me:home" },
      { text: L(loc, "dashboard"), cb: "me:dash" },
    ],
    [
      { text: L(loc, "lang"), cb: "lang:menu" },
      { text: L(loc, "help"), cb: "h:main" },
    ],
    ...(isAdmin ? [[{ text: "🛡 Admin", cb: "adm:home" }]] : []),
  );
}


/**
 * The GitHub token card.
 *
 * The owner was explicit: after /start the bot must ask for the token itself,
 * explain it in a way a non-technical person can follow, and hand over a button
 * that opens GitHub's token page with the right scopes already ticked — one tap
 * to create, one paste to finish. Everything else stays the same: encrypted at
 * rest, removable with one button.
 */
/**
 * Retire the old bottom keyboard.
 *
 * A reply keyboard lives in the client until a message carries
 * reply_markup.remove_keyboard — so we send one quietly and delete it right
 * away, leaving the chat with a single clean message and no second keyboard.
 */
async function stripReplyKeyboard(h: H): Promise<void> {
  try {
    const m: any = await h.tg.sendMessage(h.chatId, "🧹", { reply_markup: { remove_keyboard: true } as any });
    const id = m?.result?.message_id ?? m?.message_id;
    if (id) await h.tg.deleteMessage(h.chatId, id).catch(() => null);
  } catch (e: any) {
    console.error("lens-swallowed", String(e?.message ?? e));
  }
}

export function githubSetupCard(fa: boolean, aiState?: string): string {
  return (
    fa
      ? `🐙 <b>اول حساب گیت‌هاب را وصل کن</b>\n\n` +
        `تا وصل نشود بقیهٔ ربات نصفه کار می‌کند: مخزن‌های خصوصی دیده نمی‌شوند،\n` +
        `سقف درخواست ۶۰ در ساعت است و پروفایل و آمار خودت نمی‌آید.\n\n` +
        `<b>سه قدم:</b>\n` +
        `۱. دکمهٔ «🔑 ساخت توکن» را بزن — دسترسی‌ها از قبل تیک خورده‌اند\n` +
        `۲. پایین صفحه <b>Generate token</b> را بزن و توکن را کپی کن\n` +
        `۳. همین‌جا در چت بفرستش — اتصال خودکار انجام می‌شود\n\n` +
        `<i>توکن رمزنگاری‌شده (AES-GCM) ذخیره می‌شود و هیچ‌جا نمایش داده نمی‌شود.</i>`
      : `🐙 <b>Connect your GitHub account first</b>\n\n` +
        `Until you do, half of the bot stays limited: no private repos, a 60/hour API cap, no account stats.\n\n` +
        `<b>Three steps:</b> tap “🔑 Create the token” (scopes pre-ticked), press Generate, paste the token here.\n` +
        `<i>Stored encrypted (AES-GCM), never displayed.</i>`
  ) + (aiState ? `\n\n${fa ? "موتور هوش مصنوعی" : "AI engine"}: ${aiState}` : "");
}

export function githubSetupKb(fa: boolean) {
  // scopes=repo,read:user,user:email,read:org → private repos, profile, orgs.
  const createUrl =
    "https://github.com/settings/tokens/new?scopes=repo,read:user,user:email,read:org&description=" +
    encodeURIComponent("GitHub Lens Ultra");
  return kb(
    [{ text: "🔑 " + (fa ? "ساخت توکن در گیت‌هاب" : "Create the token"), url: createUrl }],
    [{ text: "📥 " + (fa ? "توکن را گرفتم، بفرستم" : "I have the token — paste it"), cb: "me:token" }],
    // dup-ok: on the onboarding card there is no menu yet, and donating a key is
    // how a user without an AI quota unlocks the assistant on the spot
    [{ text: "🤝 " + (fa ? "اهدای کلید هوش مصنوعی" : "Donate an AI key"), cb: "keys:home" }],
    [{ text: "⏭ " + (fa ? "فعلاً نه، منو را نشانم بده" : "Skip — show me the menu"), cb: "m:menu" }],
  );
}

/** One line describing the AI engine, used on the welcome and profile screens. */
export async function aiEngineState(env: Env): Promise<string> {
  const fa = true;
  try {
    const pooled = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_keys WHERE status IN ('ok','new')")
      .first<{ n: number }>().catch(() => null);
    if (Number(pooled?.n ?? 0) > 0) return fa ? "🤝 روشن — از استخر کلیدهای اهدایی" : "on (donated-key pool)";
    const halted = await env.CACHE.get("ai:halt").catch(() => null);
    if (halted) return fa ? "⚠️ سهمیهٔ رایگان امروز تمام شده — با اهدای کلید فوراً روشن می‌شود" : "quota spent until tomorrow";
    return fa ? "✅ آماده" : "ready";
  } catch {
    return fa ? "✅ آماده" : "ready";
  }
}

/**
 * Turn a help section's body into rich blocks.
 *
 * The sections were written for plain messages, where a bullet was a literal
 * "• " and a newline was the only structure available. In a rich message the
 * bullets become a real `<ul>` (Telegram indents and hangs them properly) and
 * the remaining lines stay as prose.
 */
function sectionBody(body: string): string {
  const out: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) { out.push(ul(bullets)); bullets = []; }
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[•\-*]\s+/.test(line)) bullets.push(line.replace(/^[•\-*]\s+/, ""));
    else { flush(); out.push(p(line)); }
  }
  flush();
  return out.join("");
}
