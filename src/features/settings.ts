import type { H } from "../core/handler";
import type { Env } from "../env";
import { fmt } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb, L, type Loc } from "../tg/keyboards";

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
    const capabilities = fa
      ? [
          "🔍 <b>جست‌وجوی چندزبانه</b> — فارسی، انگلیسی، هر زبانی؛ آن‌قدر می‌گردم تا همان را پیدا کنم که منظورت بود",
          "🛰 <b>کاوش عمیق، ۱۲ تب</b> — رشد ستاره‌ها، جامعه، انتشارها، PRها، کامیت‌ها، CI، امنیت، چنج‌لاگ",
          "🧠 <b>هوش مصنوعی چندمدلی</b> — ترجمهٔ README، خلاصه، چت با مخزن، بازبینی PR، ساخت ورک‌فلو، توضیح کد",
          "📥 <b>دانلود مستقیم</b> — زیپ یا تار، با تقسیم خودکار برای مخزن‌های بزرگ",
          "🛡 <b>امنیت</b> — اسکن وابستگی‌ها (OSV)، شکار کلید لو‌رفته، هشدار CVE",
          "🧰 <b>جعبه‌ابزار</b> — IP/DNS/ASN، JWT، هش، کرون، CIDR، رجکس و ۱۵ ابزار دیگر",
          "📡 <b>رادار اینترنت آزاد</b> · ⭐ <b>فید شخصی</b> · 🏆 لیدربورد و نشان",
          "🌌 <b>هاب جهانی</b> — خودش رویداد می‌گیرد، ورک‌فلو می‌سازد، پست کانال را آماده می‌کند و بعد از تأیید تو منتشر می‌کند",
        ].join("\n")
      : [
          "🔍 <b>Multilingual search</b> — any language in, the repo you meant out",
          "🛰 <b>Deep scout, 12 tabs</b> — growth, community, releases, PRs, commits, CI, security",
          "🧠 <b>Multi-model AI</b> — README translation, summaries, repo chat, PR review, workflows",
          "📥 <b>Direct downloads</b> — zip or tar, auto-split for big repos",
          "🛡 <b>Security</b> — OSV dependency scan, leaked-key hunt, CVE alerts",
          "🧰 <b>Toolbox</b> — IP/DNS/ASN, JWT, hashes, cron, CIDR, regex and 15 more",
          "📡 <b>Net Radar</b> · ⭐ <b>Personal feed</b> · 🏆 leaderboard and badges",
          "🌌 <b>Universal hub</b> — reacts to events, builds workflows, drafts the channel post, publishes on your word",
        ].join("\n");

    // the persistent bottom keyboard was retired: the inline menu is enough and
    // the owner does not want two keyboards on screen
    await stripReplyKeyboard(h);

    if (!linked && !opts?.force) {
      // step one, and only step one: link GitHub. Nothing else competes for
      // attention, and the card ends by telling them to press /start again
      await h.tg.sendMessage(h.chatId, githubSetupCard(fa, aiState), {
        parse_mode: "HTML",
        reply_markup: githubSetupKb(fa) as any,
        disable_web_page_preview: true,
      });
      return;
    }

    const login = String((u as any)?.github_login ?? "");
    const hello = fa
      ? `👋 <b>سلام${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""}!</b> — به <b>GitHub Lens Ultra</b> خوش آمدی.\n\n` +
        `<blockquote>اینجا ایستگاهِ کاوشِ اوپن‌سورس است: گیت‌هاب را می‌کاوم، فارسی‌اش می‌کنم، ` +
        `امنیتش را چک می‌کنم، دانلودش می‌کنم — و اگر چیزی ارزش گفتن داشت، خودش می‌فهمد و می‌آورد.</blockquote>\n\n` +
        `<b>⚡ چه کارهایی از دستم برمی‌آید</b>\n${capabilities}\n\n` +
        `🎯 <b>از کجا شروع کنیم؟</b>\n` +
        `• یک موضوع بنویس → <i>جست‌وجوی معنایی</i>\n` +
        `• یک <code>owner/repo</code> بفرست → <i>پروندهٔ کامل مخزن</i>\n` +
        `• <code>/help</code> → همهٔ دستورها، دسته‌بندی‌شده\n\n` +
        `🐙 <code>${tgEscape(login)}</code> · 🧠 ${aiState}\n` +
        `<i>منوی زیر، نقشهٔ همهٔ ۲۷ صفحه است.</i>`
      : `👋 <b>Hello${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""}!</b> — welcome to <b>GitHub Lens Ultra</b>.\n\n` +
        `<blockquote>An open-source observatory: I search GitHub, translate it, audit it and download it — ` +
        `and when something deserves telling, the hub notices on its own.</blockquote>\n\n` +
        `<b>⚡ What I can do</b>\n${capabilities}\n\n` +
        `🎯 <b>Start here:</b> send a topic for semantic search, an <code>owner/repo</code> for the full dossier, ` +
        `or <code>/help</code> for every command.\n\n` +
        `🐙 <code>${tgEscape(login)}</code> · 🧠 ${aiState}`;

    // Art first, then the card. The banner is decoration and must never be the
    // reason a user sees nothing, so a failure here is swallowed on purpose.
    await h.tg.sendPhoto(
      h.chatId,
      Settings.START_BANNER,
      fa ? Settings.START_CAPTION_FA : Settings.START_CAPTION_EN,
      { parse_mode: "HTML" } as any,
    ).catch((e: any) => console.error("start-banner", String(e?.message ?? e)));

    await h.tg.sendMessage(h.chatId, hello, {
      parse_mode: "HTML",
      reply_markup: mainMenuKb(
        lang,
        u?.plan === "admin",
        // the mini app is served by this same worker; without this the
        // keyboard falls back to a callback and /app stays unreachable
        h.env.WORKER_URL ? `${h.env.WORKER_URL}/app` : undefined,
      ) as any,
      disable_web_page_preview: true,
    });
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
    const LIMIT = 3500;

    // Pack sections into messages, splitting only between sections.
    const parts: string[] = [];
    let cur = "";
    for (const sec of sections) {
      if (cur && cur.length + sec.length + 2 > LIMIT) { parts.push(cur); cur = sec; }
      else cur = cur ? `${cur}\n\n${sec}` : sec;
    }
    if (cur) parts.push(cur);

    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const body = last ? parts[i] : `${parts[i]}\n\n<i>… ادامه در پیام بعد</i>`;
      await h.reply(
        body,
        last
          ? kb(
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
            )
          : undefined,
        i === 0 && !!h.cbId,
      );
    }
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

function mainMenuKb(loc: Loc, isAdmin: boolean, miniAppUrl?: string) {
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
    ...(miniAppUrl
      ? [[{ text: "📱 " + (fa ? "اپلیکیشن (نسخهٔ وب)" : "Mini App (web)"), web: miniAppUrl }]]
      : []),
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
