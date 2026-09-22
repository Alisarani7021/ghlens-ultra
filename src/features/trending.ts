import type { H } from "../core/handler";
import { TrendingEngine } from "../github/trending";
import { fmt, rel } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb, pager } from "../tg/keyboards";

/** Trending boards: 4 windows × N languages, with real growth deltas and sparklines. */
export class TrendingFeature {
  constructor(private engine: TrendingEngine) {}

  private titles(loc: string) {
    const fa = loc === "fa";
    return {
      daily: fa ? "🔥 داغ‌ترین‌های امروز" : "🔥 Trending today",
      weekly: fa ? "📅 داغ‌ترین‌های هفته" : "📅 Trending this week",
      monthly: fa ? "🗓 داغ‌ترین‌های ماه" : "🗓 Trending this month",
      all: fa ? "🏆 محبوب‌ترین‌های همیشه" : "🏆 All-time favourites",
    } as Record<string, string>;
  }

  async board(h: H, period: "daily" | "weekly" | "monthly" | "all" = "daily", language = "all", page = 0) {
    const fa = h.loc === "fa";
    let rows = await h.store.board(period, language, 25);
    if (!rows.length) {
      rows = await this.engine.rank(period, language, 25).catch(() => []);
      if (rows.length) {
        try { await this.engine.store(period === "all" ? "monthly" : period, language, rows); } catch { /* best-effort */ }
      }
    }
    if (!rows.length) {
      return h.reply(`😕 ${fa ? "داده‌ای برای این بازه نیست." : "No data for this window."}`, kb([{ text: "◀️", cb: "m:home" }]));
    }

    const slice = rows.slice(page * 10, page * 10 + 10);
    const head = `<b>${this.titles(h.loc)[period]}</b>  ${language !== "all" ? `• ${tgEscape(language)}` : ""}\n\n`;

    const body = slice
      .map((r: any, idx: number) => {
        const rank = page * 10 + idx + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
        const delta = r.gained ? ` <b>+${fmt(r.gained)}</b> ⭐` : "";
        const vel = r.velocity ? ` · 🚀 ${r.velocity}/day` : "";
        return (
          `${medal} <b>${tgEscape(r.full_name)}</b>\n` +
          (r.description ? `   ${i(truncate(r.description, 95))}\n` : "") +
          `   ⭐ ${fmt(r.stars)}${delta}${vel}${r.language ? ` · 🧩 ${tgEscape(r.language)}` : ""}\n` +
          (r.topics?.length ? `   ${r.topics.slice(0, 3).map((t: string) => code("#" + t)).join(" ")}\n` : "") +
          (r.quality ? `   ${fa ? "سلامت" : "health"}: ${r.quality}/100 · 🕒 ${rel(r.pushed_at, fa)}\n` : "")
        );
      })
      .join("\n");

    const rowsKb = slice.slice(0, 8).map((r: any, i2: number) => [{ text: `${page * 10 + i2 + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]);
    const keyboard = kb(
      ...rowsKb,
      pager("t", "b", page, Math.max(1, Math.ceil(rows.length / 10)), [period, language]),
      [
        { text: (period === "daily" ? "✅ " : "") + (fa ? "روزانه" : "Daily"), cb: "t:b:0,daily,all" },
        { text: (period === "weekly" ? "✅ " : "") + (fa ? "هفتگی" : "Weekly"), cb: "t:b:0,weekly,all" },
        { text: (period === "monthly" ? "✅ " : "") + (fa ? "ماهانه" : "Monthly"), cb: "t:b:0,monthly,all" },
      ],
      [
        { text: "🏆 " + (fa ? "همیشه" : "All-time"), cb: "t:b:0,all,all" },
        { text: "🚀 " + (fa ? "بیشترین رشد" : "Growth leaders"), cb: "t:growth:7" },
      ],
      [
        { text: "🌐 " + (fa ? "فیلتر زبان" : "Language"), cb: "t:lang:" + period },
        { text: "🎙 " + (fa ? "پادکست امروز" : "Today's podcast"), cb: "p:today" },
      ],
      [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }],
    );

    await h.reply(head + body, keyboard, !!h.cbId);
    await h.store.event(h.u.id, "trending", `${period}:${language}`);
  }

  /** Language picker for trending/browse (12 popular + AI-filtered extras). */
  async langMenu(h: H, period = "daily") {
    const langs = ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C++", "C#", "PHP", "Ruby", "Swift", "Kotlin", "Shell", "Dart", "Zig", "Lua", "Elixir", "Scala"];
    const fa = h.loc === "fa";
    await h.reply(
      `🌐 <b>${fa ? "انتخاب زبان برنامه‌نویسی" : "Pick a language"}</b>`,
      kb(
        ...chunk(langs, 3).map((row) => row.map((l) => ({ text: l, cb: `t:b:0,${period},${l}` }))),
        [{ text: "🔄 " + (fa ? "همه زبان‌ها" : "All languages"), cb: `t:b:0,${period},all` }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }],
      ),
    );
  }

  /** Trending hub shown from /start → 🔥. */
  async menu(h: H) {
    const fa = h.loc === "fa";
    const daily = await h.store.board("daily", "all", 3);
    const preview = daily.length
      ? daily.map((r: any, i2: number) => `${["🥇", "🥈", "🥉"][i2]} <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stars)}${r.gained ? ` (+${fmt(r.gained)})` : ""}`).join("\n")
      : (fa ? "<i>در حال ساخت اولین اسنپ‌شات…</i>" : "<i>building the first snapshot…</i>");
    await h.reply(
      `🔥 <b>${fa ? "داغ‌ترین‌های گیت‌هاب" : "GitHub trending"}</b>\n\n${preview}\n\n` +
        (fa
          ? "<i>موتور رتبه‌بندی لنز از سه سیگنال استفاده می‌کند: سرعت رشد ستاره‌ها، شتاب و کیفیت پروژه. هر ۱۵ دقیقه اسنپ‌شات می‌گیریم — پس اعداد واقعی‌اند، نه تخمینی.</i>"
          : "<i>Ranked by growth velocity × acceleration × project quality, snapshotted every 15 minutes.</i>"),
      kb(
        [
          { text: "🔥 " + (fa ? "روزانه" : "Daily"), cb: "t:b:0,daily,all" },
          { text: "📅 " + (fa ? "هفتگی" : "Weekly"), cb: "t:b:0,weekly,all" },
          { text: "🗓 " + (fa ? "ماهانه" : "Monthly"), cb: "t:b:0,monthly,all" },
        ],
        [
          { text: "🏆 " + (fa ? "همیشه" : "All-time"), cb: "t:b:0,all,all" },
          { text: "🚀 " + (fa ? "بیشترین رشد" : "Growth"), cb: "t:growth:7" },
        ],
        [
          { text: "🌐 " + (fa ? "فیلتر زبان" : "By language"), cb: "t:lang:daily" },
          { text: "🎙 " + (fa ? "پادکست" : "Podcast"), cb: "p:today" },
        ],
        [
          { text: "🆕 " + (fa ? "تازه‌واردها" : "Newcomers"), cb: "t:new" },
          { text: "📈 " + (fa ? "نمودار هفتگی" : "Weekly chart"), cb: "t:chart" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }],
      ),
      !!h.cbId,
    );
  }

  async growth(h: H, days = 7) {
    const fa = h.loc === "fa";
    const leaders = await h.store.growthLeaders(days, 12);
    if (!leaders.length) {
      return h.reply(
        fa ? "📈 هنوز داده کافی برای رشد ندارم — بعد از چند اسنپ‌شات پر می‌شود." : "Not enough snapshots yet.",
        kb([{ text: "◀️", cb: "t:menu" }]),
        !!h.cbId,
      );
    }
    const body = leaders.map((r: any, i2: number) =>
      `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> — <b>+${fmt(r.gained)}</b> ⭐ (${fa ? "الان" : "now"} ${fmt(r.now)})`).join("\n");
    await h.reply(
      `🚀 <b>${fa ? `بیشترین رشد ${days} روز اخیر` : `Fastest growing (${days}d)`}</b>\n\n${body}`,
      kb(
        ...leaders.slice(0, 6).map((r: any) => [{ text: `📈 ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        [
          { text: "۷ " + (fa ? "روز" : "days"), cb: "t:growth:7" },
          { text: "۳۰ " + (fa ? "روز" : "days"), cb: "t:growth:30" },
          { text: "۹۰ " + (fa ? "روز" : "days"), cb: "t:growth:90" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }],
      ),
      !!h.cbId,
    );
  }

  /** Brand-new rockets: created in the last 30 days with explosive star velocity. */
  async newcomers(h: H) {
    const fa = h.loc === "fa";
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const res = await h.gh().searchRepos(`created:>${since} stars:>150`, "stars", "desc", 15).catch(() => null);
    const items = res?.items ?? [];
    const body = items.map((r: any, i2: number) => {
      const perDay = (r.stargazers_count / Math.max(1, (Date.now() - Date.parse(r.created_at)) / 86400000)).toFixed(0);
      return `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stargazers_count)} · 🚀 ${perDay}/day\n   ${i(truncate(r.description ?? "", 80))}`;
    }).join("\n\n");
    await h.reply(
      `🆕 <b>${fa ? "موشک‌های تازه" : "Newcomers"}</b>\n\n${body || (fa ? "چیزی نبود." : "Nothing found.")}`,
      kb(
        ...items.slice(0, 6).map((r: any) => [{ text: `🚀 ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }],
      ),
      !!h.cbId,
    );
  }

  /** 7-day star deltas rendered as an ASCII-art chart. */
  async chart(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT day, SUM(delta) AS total FROM repo_snapshots WHERE delta > 0 GROUP BY day ORDER BY day DESC LIMIT 14`,
    ).all<{ day: string; total: number }>().catch(() => ({ results: [] as any[] }));
    const rows = (results ?? []).reverse();
    if (!rows.length) return h.reply(fa ? "📈 داده‌ای نیست." : "No data.", kb([{ text: "◀️", cb: "t:menu" }]), !!h.cbId);
    const max = Math.max(...rows.map((r) => r.total), 1);
    const chart = rows.map((r) => `${r.day.slice(5)}  ${"█".repeat(Math.max(1, Math.round((r.total / max) * 22)))} ${fmt(r.total)}`).join("\n");
    await h.reply(
      `📈 <b>${fa ? "رشد کل ستاره‌ها در مخازن رصدشده" : "Total star growth (tracked repos)"}</b>\n\n<pre>${chart}</pre>\n` +
        (fa ? `<i>مجموع امروز: <b>${fmt(rows.at(-1)?.total ?? 0)}</b> ستاره جدید</i>` : ""),
      kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "t:menu" }]),
      !!h.cbId,
    );
  }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function chunk<T>(arr: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
