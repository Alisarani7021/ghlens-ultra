import type { InlineKeyboardMarkup } from "./types";

export const B = {
  home: "🏠 منوی اصلی",
  back: "◀️ بازگشت",
  next: "بعدی ▶️",
  prev: "◀️ قبلی",
  close: "✖️ بستن",
  more: "🔎 بیشتر",
};

export type Loc = "fa" | "en" | "ar" | "ru" | "zh";

/** Per-locale button labels for the persistent keyboards. */
export const LBL: Record<Loc, Record<string, string>> = {
  fa: {
    home: "🏠 منوی اصلی", search: "🔍 جستجوی هوشمند", browse: "🗂 مرور پروژه‌ها", trending: "🔥 داغ‌ترین‌ها",
    scout: "🛰 کاوش عمیق", inbox: "📥 دانلود سورس", tools: "🧰 جعبه‌ابزار", profile: "👤 پروفایل من",
    fav: "⭐ علاقه‌مندی‌ها", subs: "🔔 اشتراک‌ها", ai: "🤖 دستیار هوش مصنوعی", help: "ℹ️ راهنما",
    lang: "🌐 تغییر زبان", podcast: "🎙 پادکست روزانه", puzzles: "🧩 چالش هفتگی", radar: "📡 رادار شبکه",
    security: "🛡 امنیت و آسیب‌پذیری", contribute: "🌱 فرصت مشارکت", devutils: "⚙️ ابزار توسعه‌دهنده",
    dashboard: "📊 داشبورد من", discover: "✨ اکتشاف گنج پنهان", compare: "⚖️ مقایسه مخازن",
    back: "◀️ بازگشت", next: "بعدی ▶️", prev: "◀️ قبلی", close: "✖️ بستن",
  },
  en: {
    home: "🏠 Main menu", search: "🔍 AI search", browse: "🗂 Browse repos", trending: "🔥 Trending",
    scout: "🛰 Deep scout", inbox: "📥 Download source", tools: "🧰 Toolbox", profile: "👤 My profile",
    fav: "⭐ Favorites", subs: "🔔 Subscriptions", ai: "🤖 AI assistant", help: "ℹ️ Help",
    lang: "🌐 Change language", podcast: "🎙 Daily podcast", puzzles: "🧩 Weekly quest", radar: "📡 Network radar",
    security: "🛡 Security & vulns", contribute: "🌱 Contribute", devutils: "⚙️ Dev utils",
    dashboard: "📊 My dashboard", discover: "✨ Hidden gems", compare: "⚖️ Compare repos",
    back: "◀️ Back", next: "Next ▶️", prev: "◀️ Prev", close: "✖️ Close",
  },
  ar: {
    home: "🏠 القائمة الرئيسية", search: "🔍 بحث ذكي", browse: "🗂 تصفح المستودعات", trending: "🔥 الأكثر رواجاً",
    scout: "🛰 استكشاف عميق", inbox: "📥 تنزيل المصدر", tools: "🧰 صندوق الأدوات", profile: "👤 ملفي",
    fav: "⭐ المفضلة", subs: "🔔 الاشتراكات", ai: "🤖 مساعد الذكاء", help: "ℹ️ مساعدة",
    lang: "🌐 تغيير اللغة", podcast: "🎙 بودكاست يومي", puzzles: "🧩 تحدّي الأسبوع", radar: "📡 رادار الشبكة",
    security: "🛡 الأمن والثغرات", contribute: "🌱 فرص المساهمة", devutils: "⚙️ أدوات المطور",
    dashboard: "📊 لوحتي", discover: "✨ جواهر مخفية", compare: "⚖️ مقارنة",
    back: "◀️ رجوع", next: "التالي ▶️", prev: "◀️ السابق", close: "✖️ إغلاق",
  },
  ru: {
    home: "🏠 Главное меню", search: "🔍 Умный поиск", browse: "🗂 Обзор", trending: "🔥 В тренде",
    scout: "🛰 Глубокий анализ", inbox: "📥 Скачать исходники", tools: "🧰 Инструменты", profile: "👤 Профиль",
    fav: "⭐ Избранное", subs: "🔔 Подписки", ai: "🤖 ИИ-помощник", help: "ℹ️ Справка",
    lang: "🌐 Язык", podcast: "🎙 Дневной подкаст", puzzles: "🧩 Квест недели", radar: "📡 Радар",
    security: "🛡 Безопасность", contribute: "🌱 Контрибьютинг", devutils: "⚙️ Утилиты",
    dashboard: "📊 Дашборд", discover: "✨ Скрытые жемчужины", compare: "⚖️ Сравнить",
    back: "◀️ Назад", next: "Далее ▶️", prev: "◀️ Назад", close: "✖️ Закрыть",
  },
  zh: {
    home: "🏠 主菜单", search: "🔍 智能搜索", browse: "🗂 浏览仓库", trending: "🔥 热榜",
    scout: "🛰 深度侦察", inbox: "📥 下载源码", tools: "🧰 工具箱", profile: "👤 我的主页",
    fav: "⭐ 收藏", subs: "🔔 订阅", ai: "🤖 AI 助手", help: "ℹ️ 帮助",
    lang: "🌐 语言", podcast: "🎙 每日播客", puzzles: "🧩 每周任务", radar: "📡 网络雷达",
    security: "🛡 安全漏洞", contribute: "🌱 参与贡献", devutils: "⚙️ 开发工具",
    dashboard: "📊 仪表盘", discover: "✨ 隐藏宝石", compare: "⚖️ 对比仓库",
    back: "◀️ 返回", next: "下一页 ▶️", prev: "◀️ 上一页", close: "✖️ 关闭",
  },
};

export type Btn = { text: string; cb?: string; url?: string; web?: string; copy?: string };
type BtnArg = Btn | Btn[] | Btn[][];

/** Normalise the many shapes callers pass ("one button", "a row", "many rows"). */
function normaliseRows(args: BtnArg[]): Btn[][] {
  const out: Btn[][] = [];
  for (const a of args) {
    if (!Array.isArray(a)) { out.push([a as Btn]); continue; }
    if (a.length && Array.isArray((a as any)[0])) out.push(...(a as Btn[][]));
    else out.push(a as Btn[]);
  }
  return out;
}

export const kb = (...rows: BtnArg[]): InlineKeyboardMarkup => ({
  inline_keyboard: normaliseRows(rows).map((row) =>
    row.map((b) => ({
      text: b.text,
      ...(b.cb ? { callback_data: b.cb } : {}),
      ...(b.url ? { url: b.url } : {}),
      ...(b.web ? { web_app: { url: b.web } } : {}),
      ...(b.copy ? { copy_text: { text: b.copy } } : {}),
    })),
  ),
});

export const L = (loc: Loc | string, key: string) => (LBL[(loc as Loc)] ?? LBL.en)[key] ?? LBL.en[key] ?? key;

export const mainMenu = (loc: Loc, isAdmin = false, miniAppUrl?: string) =>
  kb(
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
      { text: L(loc, "dashboard"), ...(miniAppUrl ? { web: miniAppUrl } : { cb: "me:dash" }) },
    ],
    [
      { text: L(loc, "lang"), cb: "lang:menu" },
      { text: L(loc, "help"), cb: "h:main" },
    ],
    ...(isAdmin ? [[{ text: "🛡 پنل مدیریت", cb: "adm:home" }]] : []),
  );

export const replyKeyboard = (loc: Loc, miniAppUrl?: string) => ({
  keyboard: [
    [{ text: L(loc, "home") }, { text: L(loc, "trending") }],
    [{ text: L(loc, "search") }, { text: L(loc, "browse") }],
    [{ text: L(loc, "profile") }, ...(miniAppUrl ? [{ text: L(loc, "dashboard"), web_app: { url: miniAppUrl } }] : [])],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: loc === "fa" ? "نام مخزن، موضوع، یا سؤالت را بفرست…" : "Send a repo, topic or question…",
});

/** Pagination row helper. */
export const pager = (ns: string, action: string, page: number, totalPages: number, extra: (string | number)[] = []) => {
  const row: { text: string; cb: string }[] = [];
  if (page > 0) row.push({ text: "◀️", cb: `${ns}:${action}:${[...extra, page - 1].join(",")}` });
  row.push({ text: `${page + 1}/${Math.max(totalPages, 1)}`, cb: `noop:noop:0` });
  if (page + 1 < totalPages) row.push({ text: "▶️", cb: `${ns}:${action}:${[...extra, page + 1].join(",")}` });
  return row;
};
