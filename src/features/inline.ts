/**
 * The cards the inline search deals out.
 *
 * Inline is the bot's shop window: the panel opens next to a keyboard, so
 * every card has one glance to earn its tap — a grade, the stars, the
 * language, and a living description. Kept pure on purpose: no fetches,
 * no state, just shapes in → Telegram article out, so the suite can press
 * every card like a user would.
 */
import { tgEscape } from "../tg/types";
import { Showcase } from "./showcase";

export interface InlineRepo {
  full_name: string;
  html_url?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count: number;
  forks_count: number;
  pushed_at?: string;
  created_at?: string;
  archived?: boolean;
  topics?: string[];
  license?: { spdx_id?: string } | null;
  owner?: { avatar_url?: string } | null;
}

const scorer = new Showcase();

/** 82500 → «82.5k» — the panel is narrow, and stars read best short. */
export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k";
  return (Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "") + "M";
}

/** «امروز» / «دیروز» / «۱۲ روز پیش» — a date the eye can feel. */
export function relDays(iso: string | undefined, fa: boolean): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return fa ? "نامشخص" : "unknown";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d <= 0) return fa ? "امروز" : "today";
  if (d === 1) return fa ? "دیروز" : "yesterday";
  return fa ? `${faDigits(d)} روز پیش` : `${d} days ago`;
}

function faDigits(n: number | string): string {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  return String(n).replace(/\d/g, (d) => fa[Number(d)]);
}

function deepLink(kind: "s" | "d" | "t" | "c", full: string): string {
  return `https://t.me/Gitguts_bot?start=${kind}_${full.replace("/", "_")}`;
}

/** The repo card: one object, everywhere the same — direct hit, search
 *  result, or today's hottest. `gained` is stars won today (trending). */
export function repoArticle(r: InlineRepo, fa: boolean, gained?: number): any {
  const sc = scorer.repoScore({
    stars: r.stargazers_count, forks: r.forks_count,
    pushedAt: Date.parse(r.pushed_at ?? "") || Date.now(),
    createdAt: Date.parse(r.created_at ?? "") || Date.now(),
    license: r.license?.spdx_id ?? null, archived: r.archived,
  });
  const url = r.html_url ?? `https://github.com/${r.full_name}`;
  const desc = (r.description ?? "").trim();
  const heat = gained ? (fa ? `🔥 +${faDigits(gained)} امروز · ` : `🔥 +${gained} today · `) : "";
  return {
    type: "article", id: `repo:${r.full_name}`,
    title: `📦 ${r.full_name} · ${sc.grade}`,
    description: `${heat}⭐ ${fmtK(r.stargazers_count)}${r.language ? ` · ${r.language}` : ""}${desc ? ` — ${desc}` : fa ? " — بدون توضیح" : ""}`.slice(0, 95),
    thumbnail_url: r.owner?.avatar_url,
    input_message_content: {
      message_text:
        `📦 <b><a href="${url}">${tgEscape(r.full_name)}</a></b> · ${sc.grade} <i>(${sc.total}/100)</i>\n\n` +
        (desc ? `<i>${tgEscape(desc)}</i>\n\n` : "") +
        `⭐ <b>${faDigits(r.stargazers_count.toLocaleString("en-US"))}</b> ${fa ? "ستاره" : "stars"}` +
        (gained ? ` <b>(+${faDigits(gained)} ${fa ? "امروز" : "today"})</b>` : "") +
        ` · 🍴 <b>${faDigits(r.forks_count.toLocaleString("en-US"))}</b> ${fa ? "فورک" : "forks"} · 🧩 <b>${tgEscape(r.language ?? (fa ? "چندزبانه" : "polyglot"))}</b>\n` +
        `🕒 ${fa ? "آخرین به‌روزرسانی" : "last push"}: <b>${relDays(r.pushed_at, fa)}</b>` +
        ((r.topics ?? []).length ? `\n🏷 ${(r.topics ?? []).slice(0, 5).map((t) => `#${tgEscape(t)}`).join(" ")}` : ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    reply_markup: {
      inline_keyboard: fa
        ? [
            [
              { text: "کاوش عمیق 🛰", url: deepLink("s", r.full_name) },
              { text: "تحلیل هوشمند 🧠", url: deepLink("c", r.full_name) },
            ],
            [
              { text: "ترجمهٔ فارسی 🌍", url: deepLink("t", r.full_name) },
              { text: "گیت‌هاب 🌐", url },
            ],
          ]
        : [
            [
              { text: "Deep dive 🛰", url: deepLink("s", r.full_name) },
              { text: "AI analysis 🧠", url: deepLink("c", r.full_name) },
            ],
            [
              { text: "Translate 🌍", url: deepLink("t", r.full_name) },
              { text: "GitHub 🌐", url },
            ],
          ],
    },
  };
}

/** @username → the maker, not just his code. */
export function userArticle(
  u: { login: string; avatar_url?: string; html_url?: string; bio?: string | null; followers?: number; public_repos?: number },
  top: { full_name: string; stargazers_count: number }[],
  fa: boolean,
): any {
  const url = u.html_url ?? `https://github.com/${u.login}`;
  const best = top
    .slice(0, 3)
    .map((r) => `  • <a href="https://github.com/${r.full_name}">${tgEscape(r.full_name.split("/")[1])}</a> — ⭐ ${faDigits(fmtK(r.stargazers_count))}`)
    .join("\n");
  return {
    type: "article", id: `user:${u.login}`,
    title: `👤 ${u.login}`,
    description: (u.bio?.trim() || (fa ? "حساب گیت‌هاب" : "GitHub account")).slice(0, 95),
    thumbnail_url: u.avatar_url,
    input_message_content: {
      message_text:
        `👤 <b><a href="${url}">${tgEscape(u.login)}</a></b>` +
        (u.followers != null ? ` — ${faDigits(u.followers.toLocaleString("en-US"))} ${fa ? "فالوور" : "followers"} · ${faDigits(u.public_repos ?? 0)} ${fa ? "ریپو" : "repos"}` : "") +
        (u.bio?.trim() ? `\n<i>${tgEscape(u.bio.trim())}</i>` : "") +
        (best ? `\n\n🏆 <b>${fa ? "ریپوهای برتر" : "Top repos"}:</b>\n${best}` : ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    reply_markup: {
      inline_keyboard: [[
        { text: fa ? "پروفایل گیت‌هاب 🌐" : "GitHub profile 🌐", url },
      ]],
    },
  };
}

/** What the empty panel greets you with — examples, not a dead end. */
export function helpArticle(fa: boolean): any {
  return {
    type: "article", id: "help",
    title: fa ? "💡 این‌طوری جست‌وجو کن" : "💡 How to search",
    description: fa
      ? "owner/repo · @username · یا هر موضوعی (python http، ربات تلگرام…)"
      : "owner/repo · @username · or any topic (python http, telegram bot…)",
    input_message_content: {
      message_text:
        (fa
          ? `🔍 <b>GitHub Lens Ultra — جست‌وجوی زندهٔ گیت‌هاب داخل همین چت</b>\n\n` +
            `• <code>owner/repo</code> → کارت کامل ریپو با نمرهٔ کیفیت\n` +
            `• <code>@username</code> → پروفایل سازنده و ریپوهای برترش\n` +
            `• <b>موضوع آزاد</b> → بهترین ریپوهای ماه، مثلاً «fast http server» یا «اپن‌سورس ایرانی»\n\n` +
            `هر کارتی ۴ دکمه دارد: کاوش عمیق، تحلیل هوشمند، ترجمهٔ فارسی و خودِ گیت‌هاب 🚀`
          : `🔍 <b>GitHub Lens Ultra — live GitHub search in any chat</b>\n\n` +
            `• <code>owner/repo</code> → the full repo card with a quality grade\n` +
            `• <code>@username</code> → the maker and his best repos\n` +
            `• <b>any topic</b> → this month's best, e.g. “fast http server”\n\n` +
            `Every card carries four keys: deep dive, AI analysis, translation, GitHub 🚀`),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  };
}

/** Nothing matched — the panel still owes the reader a next step. */
export function notFoundArticle(fa: boolean, query: string): any {
  return {
    type: "article", id: "notfound",
    title: fa ? `🔍 برای «${query}» چیزی پیدا نشد` : `🔍 Nothing for “${query}”`,
    description: fa ? "املای نام را چک کن یا با موضوع کلی‌تری امتحان کن" : "Check the spelling, or try a broader topic",
    input_message_content: {
      message_text: fa
        ? `🔍 برای «<b>${tgEscape(query)}</b>» چیزی پیدا نشد.\n\nنام ریپو را کامل بنویس (<code>owner/repo</code>)، یا با موضوع کلی‌تری بگرد — مثلاً «http server» به‌جای نام دقیق پکیج.`
        : `🔍 Nothing for “<b>${tgEscape(query)}</b>”.\n\nTry the full name (<code>owner/repo</code>) or a broader topic.`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  };
}

/** The footer card — the day's board, one tap away in the bot's chat. */
export function trendingArticle(fa: boolean): any {
  return {
    type: "article", id: "trending",
    title: fa ? "🔥 داغ‌ترین‌های امروز گیت‌هاب" : "🔥 Today's GitHub trending",
    description: fa ? "بردار امتیازی با رشد روزانه، نمودارها و برگزیدگان" : "The ranked board, growth charts, today's picks",
    input_message_content: {
      message_text: fa
        ? `🔥 <b>داغ‌ترین‌های امروز گیت‌هاب</b>\n\n<i>بردار امتیازی GitHub Lens Ultra — رشد ستاره‌های امروز، نمودار ۹۰ روزه و برگزیدگان هفته.</i>\nدکمهٔ پایین، بردار کامل را داخل ربات باز می‌کند.`
        : `🔥 <b>Today's GitHub trending</b>\n\n<i>The GitHub Lens Ultra ranked board — today's star growth, 90-day charts, picks of the week.</i>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    reply_markup: {
      inline_keyboard: [[
        { text: fa ? "بردار کامل در ربات 🔥" : "Full board in the bot 🔥", url: "https://t.me/Gitguts_bot?start=trending" },
      ]],
    },
  };
}
