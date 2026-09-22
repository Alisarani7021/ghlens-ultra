import type { Env } from "../env";
import type { RepoMeta } from "../github/graphql";
import { bar, healthScore, sparkline } from "../github/rest";
import { b, code, i, link, tgEscape } from "../tg/types";
import { kb, L, pager, type Loc } from "../tg/keyboards";
import type { Store } from "../core/db";

export type CardMode = "auto" | "full" | "compact";

/**
 * RepoCard — the visual soul of the bot.
 * Renders a repository as a rich Telegram HTML card with a health meter, language
 * distribution, growth sparkline, red-flag audit and 8 quick actions.
 */
export class RepoCard {
  constructor(private env: Env, private store: Store) {}

  async render(meta: RepoMeta | any, opts: { loc: Loc; mode?: CardMode; history?: { spark: string; gained?: number }; page?: number } ) {
    const loc = opts.loc;
    const mode = opts.mode ?? "auto";
    const m = normalise(meta);
    const fa = loc === "fa";

    const health = m.health || healthScore({
      stars: m.stars, forks: m.forks, open_issues: m.issues,
      pushed_at: m.pushed_at ?? undefined, created_at: m.created_at ?? undefined,
      license: m.license, archived: m.archived, description: m.description, has_readme: true,
    });
    const meter = meterBar(health);
    const langs = (m.languages ?? []).slice(0, 4);
    const total = langs.reduce((s: number, l: any) => s + (l.bytes ?? 0), 0) || 1;
    const langLines = langs.map((l) => {
      const pct = Math.round(((l.bytes ?? 0) / total) * 100);
      return `${dot(l.color)} ${tgEscape(l.name)} <b>${pct}%</b> ${bar(pct, 8)}`;
    }).join("\n");

    const flags = (m.redFlags ?? []).map((f: string) => flagLabel(f, fa)).filter(Boolean);
    const spark = opts.history?.spark ?? "";
    const gained = opts.history?.gained;

    const head =
      `<b>${tgEscape(m.full_name)}</b>\n` +
      (m.description ? `${i(truncate(m.description, 220))}\n` : "") +
      (m.homepage ? `🔗 ${link("Homepage", m.homepage)}\n` : "");

    const stats =
      `\n⭐ <b>${fmt(m.stars)}</b>   🍴 <b>${fmt(m.forks)}</b>   👀 ${fmt(m.watchers ?? 0)}   🐞 ${fmt(m.issues)}\n` +
      (m.releases ? `🏷 ${fmt(m.releases)} ${fa ? "نسخه" : "releases"}   ` : "") +
      (m.good_first ? `🌱 ${m.good_first} good-first   ` : "") +
      `\n`;

    const healthBlock =
      `\n${fa ? "سلامت پروژه" : "Project health"}: <b>${health}/100</b>  ${meter}\n` +
      (m.stars_per_day ? `${fa ? "سرعت رشد" : "velocity"}: <b>${m.stars_per_day}</b> ⭐/${fa ? "روز" : "day"}\n` : "") +
      (spark ? `📈 ${code(spark)}${gained ? `  <b>+${fmt(gained)}</b> ⭐` : ""}\n` : "");

    const meta2 =
      `\n${m.language ? `🧩 ${tgEscape(m.language)}` : ""}${m.license ? `   ⚖️ ${tgEscape(m.license)}` : `   ⚠️ ${fa ? "بدون مجوز" : "no license"}`}` +
      `${m.archived ? `   📦 ${fa ? "آرشیو شده" : "archived"}` : ""}\n` +
      (m.topics?.length ? `🏷 ${(m.topics as string[]).slice(0, 8).map((t) => code("#" + t)).join(" ")}\n` : "") +
      `🕒 ${fa ? "آخرین پوش" : "last push"}: ${rel(m.pushed_at, fa)}   👥 ${fmt(m.contributors ?? 0)}\n` +
      (flags.length ? `\n${fa ? "⚠️ نکات هشدار" : "⚠️ flags"}: ${flags.join(" • ")}\n` : "");

    const tail =
      `\n<a href="https://github.com/${m.full_name}">github.com/${tgEscape(m.full_name)}</a>` +
      `  •  <a href="https://github.com/${m.full_name}/stargazers">${fa ? "ستاره‌دهندگان" : "stargazers"}</a>`;

    const full = head + stats + (mode === "compact" ? "" : healthBlock + (langLines ? `\n${langLines}\n` : "") + meta2) + tail;

    return {
      text: full,
      keyboard: this.keyboard(m, loc),
    };
  }

  /** 8 primary + 6 deep actions per repo — every one is a real feature. */
  keyboard(m: any, loc: Loc) {
    const ns = `r:${m.full_name}`;
    const rows: { text: string; cb?: string; url?: string }[][] = [
      [
        { text: "🛰 " + (loc === "fa" ? "کاوش عمیق" : "Deep scout"), cb: `s:go:${m.full_name}` },
        { text: "🤖 " + (loc === "fa" ? "تحلیل هوش مصنوعی" : "AI analysis"), cb: `ai:repo:${m.full_name}` },
      ],
      [
        { text: "🧠 " + (loc === "fa" ? "چت با مخزن" : "Chat with repo"), cb: `a:repochat:${m.full_name}` },
        { text: "🤖 " + (loc === "fa" ? "ترجمه README" : "Translate README"), cb: `ai:tr:${m.full_name}` },
      ],
      [
        { text: "📥 " + (loc === "fa" ? "دانلود سورس" : "Download source"), cb: `d:repo:${m.full_name}` },
        { text: "🛡 " + (loc === "fa" ? "امنیت" : "Security"), cb: `sec:repo:${m.full_name}` },
      ],
      [
        { text: "📊 " + (loc === "fa" ? "نمودار رشد" : "Growth chart"), cb: `r:chart:${m.full_name}` },
        { text: "🗂 " + (loc === "fa" ? "فایل‌ها" : "Files"), cb: `r:files:${m.full_name}` },
      ],
      [
        { text: "🧩 " + (loc === "fa" ? "مشارکت" : "Contribute"), cb: `c:repo:${m.full_name}` },
        { text: "✨ " + (loc === "fa" ? "مشابه‌ها" : "Similar"), cb: `x:sim:${m.full_name}` },
      ],
      [
        { text: "⭐ " + (loc === "fa" ? "علاقه‌مندی" : "Favourite"), cb: `f:add:${m.full_name}` },
        { text: "🔔 " + (loc === "fa" ? "اشتراک" : "Subscribe"), cb: `sub:add:${m.full_name}` },
      ],
      [
        { text: "➕ " + (loc === "fa" ? "مقایسه" : "Compare"), cb: `s:cmp:${m.full_name}` },
        { text: "🖼 " + (loc === "fa" ? "کارت تصویری" : "Share card"), cb: `r:card:${m.full_name}` },
      ],
      [
        { text: "🌐 GitHub", url: `https://github.com/${m.full_name}` },
        { text: "🔗 " + (loc === "fa" ? "ارسال" : "Share"), cb: `r:share:${m.full_name}` },
      ],
    ];
    return kb(...rows);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
export function normalise(r: any): RepoMeta {
  if (r.nameWithOwner || r.stargazerCount !== undefined) {
    // GraphQL shape → keep as-is but alias common fields
    return {
      ...r,
      full_name: r.nameWithOwner,
      stars: r.stargazerCount ?? 0,
      forks: r.forkCount ?? 0,
      issues: r.issues?.totalCount ?? 0,
      health: r.health ?? r.health_score ?? 0,
      languages: (r.languages?.edges ?? []).map((e: any) => ({ name: e.node.name, color: e.node.color, bytes: e.size })),
      topics: (r.repositoryTopics?.nodes ?? r.topics ?? []).map((n: any) => n?.topic?.name ?? n),
      license: r.licenseInfo?.spdxId ?? r.license ?? null,
      description: r.description ?? r.shortDescriptionHTML?.replace(/<[^>]+>/g, "") ?? null,
    } as RepoMeta;
  }
  return {
    ...r,
    languages: typeof r.languages === "string" ? safeParse(r.languages, []) : (r.languages ?? []),
    topics: typeof r.topics === "string" ? safeParse(r.topics, []) : (r.topics ?? []),
    license: r.license ?? null,
    health: r.health_score ?? r.health ?? 0,
    stars: r.stars ?? 0,
    forks: r.forks ?? 0,
    issues: r.open_issues ?? 0,
    pushed_at: r.pushed_at ? new Date(r.pushed_at).toISOString() : null,
  } as RepoMeta;
}

const safeParse = (s: string, d: any) => { try { return JSON.parse(s); } catch { return d; } };

export function fmt(n: number | null | undefined) {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(v);
}

export function meterBar(pct: number, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  const clr = pct >= 75 ? "🟢" : pct >= 45 ? "🟡" : "🔴";
  return clr + " " + "▰".repeat(filled) + "▱".repeat(width - filled);
}

const dot = (hex?: string) => (hex ? "🔸" : "🔹");

export function rel(iso: string | number | null | undefined, fa = true) {
  if (!iso) return fa ? "نامشخص" : "unknown";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const d = (Date.now() - t) / 1000;
  const units: [number, string, string][] = [
    [60, "ثانیه", "s"], [3600, "دقیقه", "m"], [86400, "ساعت", "h"], [2592000, "روز", "d"], [31536000, "ماه", "mo"],
  ];
  let out = fa ? "مدت‌ها پیش" : "long ago";
  let prev = 1;
  for (const [limit, faU, enU] of units) {
    if (d < limit) { out = fa ? `${Math.floor(d / prev)} ${faU} پیش` : `${Math.floor(d / prev)}${enU} ago`; break; }
    prev = limit;
  }
  if (d >= 31536000) out = fa ? `${Math.floor(d / 31536000)} سال پیش` : `${Math.floor(d / 31536000)}y ago`;
  return out;
}

export function flagLabel(f: string, fa: boolean) {
  const map: Record<string, [string, string]> = {
    archived: ["آرشیو شده — دیگر توسعه نمی‌یابد", "archived — no longer developed"],
    "no-license": ["بدون مجوز — برای استفاده تجاری ریسک دارد", "no license — commercial use is risky"],
    fork: ["فورک است، پروژه اصلی نیست", "it is a fork, not the upstream"],
    "no-dependabot": ["هشدارهای امنیتی دپندنسی فعال نیست", "dependency alerts disabled"],
    stale: ["بیش از یک سال بدون کامیت", "no commits in over a year"],
    "low-community-health": ["سلامت جامعه پایین نسبت به محبوبیت", "community health low vs popularity"],
  };
  const v = map[f];
  return v ? (fa ? v[0] : v[1]) : f;
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
