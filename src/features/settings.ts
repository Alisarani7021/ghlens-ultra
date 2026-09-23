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

    const capabilities = fa
      ? [
          "🔍 <b>جست‌وجو</b> — فارسی یا انگلیسی بنویس، دقیق‌ترین مخزن را پیدا می‌کنم",
          "🛰 <b>کاوش عمیق</b> — ۱۲ تب: رشد، جامعه، انتشارها، امنیت، PRها",
          "🧠 <b>هوش مصنوعی</b> — ترجمهٔ README، خلاصه، چت با مخزن، ورک‌فلو، بازبینی PR",
          "📥 <b>دانلود</b> — زیپ، با تقسیم خودکار برای مخزن‌های بزرگ",
          "🧰 <b>جعبه‌ابزار</b> — تبدیل پکیج، IP/DNS/ASN، هش، JWT، کرون",
          "⭐ <b>فید شخصی</b> — علاقه‌مندی‌ها، هشدار انتشار، جدول امتیاز",
        ].join("\n")
      : [
          "🔍 <b>Search</b> — type in any language, I find the exact repo",
          "🛰 <b>Deep scout</b> — 12 tabs: growth, community, releases, security, PRs",
          "🧠 <b>AI</b> — README translation, summaries, repo chat, workflows, PR review",
          "📥 <b>Downloads</b> — zip, with automatic splitting for big repos",
          "🧰 <b>Toolbox</b> — package conversion, IP/DNS/ASN, hashes, JWT, cron",
          "⭐ <b>Personal feed</b> — interests, release alerts, leaderboard",
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
      ? `👋 <b>سلام${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""}!</b>\n\n` +
        `من <b>GitHub Lens Ultra</b> هستم — دستیار کشف و تحلیل اوپن‌سورس، کاملاً روی کلودفلر.\n\n` +
        `<b>چه کارهایی می‌کنم:</b>\n${capabilities}\n\n` +
        `🐙 <code>${tgEscape(login)}</code> · 🧠 ${aiState}\n` +
        `<i>هر بخش دکمهٔ راهنما و بازگشت دارد.</i>`
      : `👋 <b>Hello${u?.first_name ? " " + tgEscape(String(u.first_name)) : ""}!</b>\n\n` +
        `<b>GitHub Lens Ultra</b> — open-source discovery and analysis, entirely on Cloudflare.\n\n` +
        `<b>What I do:</b>\n${capabilities}\n\n` +
        `🐙 <code>${tgEscape(login)}</code> · 🧠 ${aiState}`;

    await h.tg.sendMessage(h.chatId, hello, {
      parse_mode: "HTML",
      reply_markup: mainMenuKb(lang, u?.plan === "admin") as any,
      disable_web_page_preview: true,
    });
  }

  /** /help — the honest, complete command reference. */
  async help(h: H) {
    const fa = h.loc === "fa";
    const text = fa
      ? `📚 <b>راهنمای کامل GitHub Lens Ultra</b>\n
<b>🤝 کلید هوش مصنوعی</b>
<code>/keys</code> — استخر کلیدهای اهدایی: کلید خودت را بده، اول تست می‌شود، بعد همهٔ قابلیت‌های AI (ترجمه، خلاصه، چت با مخزن، پادکست) با کلیدهای همه کار می‌کنند؛ کلید سوخته فوراً حذف می‌شود.

<b>🐙 حساب گیت‌هاب</b>
<code>/connect</code> یا دکمهٔ «🐙 حساب گیت‌هاب» در منو — یک دکمه توکن می‌سازد (دسترسی‌ها از قبل تیک خورده)، توکن را بفرست، حساب وصل می‌شود و همهٔ قابلیت‌ها باز می‌شود. وضعیت کامل حساب هم همین‌جا می‌آید. — تعداد مخزن‌ها (خصوصی/عمومی)، زبان‌ها، ستاره‌ها، سازمان‌ها، سقف درخواست.

<b>🚀 شروع سریع</b>
هر اسم مخزنی بفرست (<code>owner/repo</code>) → کارت کامل
هر موضوعی بفرست (<code>react state management</code>) → جست‌وجوی معنایی
هر سؤالی بفرست → دستیار AI پاسخ می‌دهد
هر ویسی بفرست → تبدیل به متن و پاسخ 🎙

<b>🔍 کشف</b>
<code>/search [موضوع]</code> — جست‌وجوی هیبرید (معنایی + متنی) با ترجمه خودکار درخواست
<code>/trending</code> — داغ‌ترین‌ها: روزانه/هفتگی/ماهانه/همیشه + فیلتر زبان + رشد واقعی
<code>/browse</code> — مرور دسته‌بندی‌شده (AI، امنیت، دواپس، وب، موبایل، OSINT، بازی…)
<code>/gems</code> — گنج‌های پنهان: کیفیت بالا، ستاره کم
<code>/random</code> — کشف تصادفی وزنی بر اساس علاقه‌مندی
<code>/feed</code> — فید شخصی

<b>🛰 تحلیل عمیق</b>
<code>/scout owner/repo</code> — ۱۲ تب: نمای کلی، رشد، زبان‌ها، جامعه، ریلیزها، ایشوها، PRها، کامیت‌ها، CI، امنیت، چنج‌لاگ، مشارکت
<code>/compare a/b c/d</code> — مقایسه تنگاتنگ با جدول و حکم AI
<code>/changelog owner/repo</code> — چنج‌لاگ انسانی از کامیت‌ها
<code>/chart owner/repo</code> — نمودار رشد ستاره‌ها
<code>/files owner/repo</code> — مرورگر فایل داخل تلگرام
<code>/card owner/repo</code> — کارت تصویری اشتراک‌گذاری

<b>🤖 هوش مصنوعی</b>
<code>/ask [سؤال]</code> — دستیار با داده زنده گیت‌هاب
<code>/repochat owner/repo</code> — چت با مخزن (RAG + منبع‌دهی)
<code>/ai owner/repo</code> — تحلیل ساختاریافته: چیست، برای کی، نقاط قوت/ضعف، جایگزین‌ها
<code>/translate owner/repo</code> — ترجمه README با حفظ ساختار
<code>/workflow [توضیح]</code> — ساخت GitHub Actions
<code>/review owner/repo#12</code> — بازبینی PR
<code>/code</code> — توضیح کد

<b>📥 دانلود سورس</b>
<code>/dl owner/repo [@ref] [zip|tar]</code> — دانلود مستقیم، کش R2، تقسیم خودکار
<code>/secrets owner/repo</code> — جست‌وجوی کلید لو رفته
<code>/security owner/repo</code> — اسکن وابستگی‌ها با OSV

<b>🛡 امنیت</b>
<code>/scan</code> — اسکن کامل مخزن + نمره + اصلاحیه
<code>/cve</code> — هشدارهای اخیر

<b>🧰 ابزارها</b>
<code>/tools</code> — تبدیل پکیج (deb/rpm/arch/apk)، IP، ASN، DNS، TLS
<code>/ip 1.1.1.1</code> — استعلام شبکه و وضعیت تهدید
<code>/asn 13335</code> — اطلاعات ASN
<code>/dev</code> — کرون، رجکس، CIDR، JWT، Base64، هش، UUID، زمان، JSON، .gitignore، SemVer، رنگ

<b>👤 حساب</b>
<code>/profile</code> — پروفایل، سطح، نشان، رتبه
<code>/dashboard</code> — آمار ۳۰ روز، streak، مصرف AI
<code>/favorites</code> · <code>/subs</code> · <code>/interests</code> · <code>/refer</code>
<code>/language</code> — تغییر زبان (fa/en/ar/ru/zh)

<b>🌱 مشارکت</b>
<code>/contribute</code> — فرصت‌ها، راهنمای اولین PR، برنامه ۷ روزه

<b>⚡ نکته‌ها</b>
• دکمه‌های زیر هر پیام همیشه یک لایه عمیق‌تر هستند
• با ⭐ مخزن را ذخیره کن، با 🔔 از ریلیز/امنیت باخبر شو
• هر جست‌وجو XP می‌دهد؛ هفتگی لیدربورد و نشان دارد
• در چت خصوصی، حالت inline (@ربات) هم کار می‌کند`
      : `📚 <b>GitHub Lens Ultra — command reference</b>

• <code>/search</code> hybrid semantic+lexical search
• <code>/trending</code> daily/weekly/monthly/all-time boards with real growth
• <code>/browse</code> curated categories · <code>/gems</code> hidden gems · <code>/random</code>
• <code>/scout owner/repo</code> 12-tab deep dossier
• <code>/compare a/b c/d</code> · <code>/changelog</code> · <code>/chart</code> · <code>/files</code> · <code>/card</code>
• <code>/ask</code> · <code>/repochat</code> · <code>/ai</code> · <code>/translate</code> · <code>/workflow</code> · <code>/review</code> · <code>/code</code>
• <code>/dl owner/repo</code> download with R2 cache + auto-split
• <code>/security</code> · <code>/secrets</code> · <code>/scan</code> OSV dependency scanning
• <code>/tools</code> · <code>/ip</code> · <code>/asn</code> · <code>/dev</code>
• <code>/profile</code> · <code>/dashboard</code> · <code>/favorites</code> · <code>/subs</code> · <code>/language</code>
• <code>/contribute</code> first-PR guidance`;

    await h.reply(text.slice(0, 3900), kb(
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
      [{ text: "🌐 " + (fa ? "زبان" : "Language"), cb: "lang:menu" }],
    ), !!h.cbId);
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
