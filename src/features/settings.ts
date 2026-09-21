import type { H } from "../core/handler";
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
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  async setLang(h: H, loc: Loc) {
    await h.store.setLocale(h.u.id, loc);
    h.loc = loc;
    await h.toast(loc === "fa" ? "✅ زبان فا به پارسی تغییر کرد" : "✅ Language updated");
    await this.home(h, loc);
  }

  /** Main menu rebuilt in the freshly selected language. */
  async home(h: H, loc?: Loc) {
    const lang = loc ?? h.loc;
    const u = await h.store.user(h.u.id);
    await h.tg.sendMessage(h.chatId,
      lang === "fa"
        ? `✅ <b>عضویت تأیید شد</b>\n\nاکنون می‌توانی از تمام امکانات ربات استفاده کنی.\n\n` +
          `👋 <b>GitHub Lens Ultra</b> — نسل بعدی کشف و تحلیل اوپن‌سورس.\n` +
          `<i>گسترش‌یافته‌ی GitHub Lens، با ۱۰۰ برابر قابلیت و عمق.</i>\n\n` +
          `🔍 جست‌وجوی معنایی چندزبانه   🛰 کاوش عمیق ۱۲ تبی   🧠 چت با مخزن\n` +
          `📥 دانلود سورس با تقسیم خودکار   🛡 اسکن امنیت OSV   🎙 پادکست روزانه`
        : `✅ <b>Welcome aboard</b>\n\n<b>GitHub Lens Ultra</b> — the next generation of open-source discovery.`,
      { parse_mode: "HTML", reply_markup: mainMenuKb(lang, u?.plan === "admin", `${h.env.WORKER_URL}/app`) });
    await h.tg.sendMessage(h.chatId, lang === "fa" ? "منوی اصلی:" : "Main menu:", {
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: false, ...({} as any) },
    } as any).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  /** /help — the honest, complete command reference. */
  async help(h: H) {
    const fa = h.loc === "fa";
    const text = fa
      ? `📚 <b>راهنمای کامل GitHub Lens Ultra</b>\n
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
      [{ text: "🌐 " + (fa ? "زبان" : "Language"), cb: "lang:menu" }, { text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }],
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
          { text: "🎙 " + (fa ? "پادکست" : "Podcast"), cb: "p:today" },
        ],
        [{ text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }
}

function mainMenuKb(loc: Loc, isAdmin: boolean, miniAppUrl?: string) {
  return kb(
    // the glass mini-app: glassmorphism UI, a help key on every section and a
    // back button everywhere — everything the bot shows, but native and fast
    miniAppUrl
      ? [{ text: loc === "fa" ? "🪟 اپلیکیشن شیشه‌ای (Mini App)" : "🪟 Glass Mini App", web: miniAppUrl }]
      : [],
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
      { text: L(loc, "podcast"), cb: "p:today" },
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
