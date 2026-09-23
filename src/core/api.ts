import type { Ctx, Env } from "../env";
import { Store } from "./db";
import { GithubRest, healthScore } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { KeyPool } from "../ai/keypool";
import { fmt } from "../features/cards";

/**
 * Public JSON API — share cards and read-only integrations (no secrets leaked,
 * CORS-enabled). There is no web front-end — the chat is the interface — so the
 * only thing here a browser is expected to render is a share card.
 *
 *   GET /api/repo?full=owner/repo  — normalised repo JSON
 *   GET /api/card?repo=owner/repo  — standalone HTML share card (screenshot target)
 *   GET /api/compare-card?a=&b=    — HTML comparison card
 *   GET /api/stats                 — public counters
 */
export async function handleApi(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const store = new Store(env);
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-telegram-init-data",
    "cache-control": "public, max-age=60",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    switch (url.pathname) {
      case "/api/gems": return json(await gemsFor(env, store), 200, cors);
      case "/api/me": {
        // Telegram WebApp initData is trusted only when its HMAC validates
        const uid = await userIdFromInitData(env, url, request);
        if (!uid) return json({ linked: false, reason: "no telegram identity" }, 200, cors);
        const row = await env.DB.prepare(
          `SELECT github_login, github_token_at FROM users WHERE id=?`,
        ).bind(uid).first<{ github_login: string | null; github_token_at: number | null }>().catch(() => null);
        return json({ linked: !!row?.github_login, login: row?.github_login ?? null, linked_at: row?.github_token_at ?? null }, 200, cors);
      }
      case "/api/repo": {
        const full = url.searchParams.get("full") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return json({ error: "bad repo" }, 400, cors);
        const m = await store.repoFresh(full, 900);
        return json(m ? { ...m, topics: safeJson(m.topics), languages: safeJson(m.languages) } : { error: "not found" }, m ? 200 : 404, cors);
      }
      case "/api/card": {
        const repo = url.searchParams.get("repo") ?? "";
        const m = await store.repoFresh(repo, 900);
        if (!m) return new Response("not found", { status: 404, headers: cors });
        const eng = new TrendingEngine(env);
        const hist = await eng.history(repo, 90).catch(() => ({ spark: "", rows: [], first: null, last: null }));
        return new Response(shareCardHtml(m, hist), { headers: { "content-type": "text/html; charset=utf-8", ...cors } });
      }
      case "/api/compare-card": {
        const a = url.searchParams.get("a") ?? "";
        const b = url.searchParams.get("b") ?? "";
        const [ma, mb] = await Promise.all([store.repoFresh(a, 1800), store.repoFresh(b, 1800)]);
        if (!ma || !mb) return new Response("not found", { status: 404, headers: cors });
        return new Response(compareCardHtml(ma, mb), { headers: { "content-type": "text/html; charset=utf-8", ...cors } });
      }
      case "/api/stats": {
        const s = await env.DB.prepare(
          `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM repos) AS repos,
                  (SELECT COUNT(*) FROM repo_snapshots) AS snapshots, (SELECT COUNT(*) FROM downloads) AS downloads,
                  (SELECT COUNT(*) FROM events) AS events`,
        ).first<any>().catch(() => null);
        return json({ ...s, generated_at: new Date().toISOString() }, 200, { ...cors, "cache-control": "public, max-age=300" });
      }
      case "/api/search": {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return json({ error: "missing q" }, 400, cors);
        const res = await new GithubRest(env).searchRepos(q, "stars", "desc", 12).catch(() => null);
        return json({ total: res?.total_count ?? 0, items: (res?.items ?? []).map(brief) }, 200, cors);
      }
      default:
        return json({ error: "unknown endpoint", endpoints: ["/api/repo", "/api/card", "/api/compare-card", "/api/stats", "/api/search", "/api/gems"] }, 404, cors);
    }
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500, cors);
  }
}

/**
 * Public JSON: boards, search, repo cards — anything a share card or an
  * integration needs.
 *
 * Board periods are served with a graceful fallback: the 15-minute cron writes
 * snapshots for the daily board only, so weekly/monthly growth is computed from
 * whatever snapshots exist and, while the account is young, filled from the
 * all-time board with an explicit note — the app never shows an empty feed for
 * a period just because the cron has not matured yet.
 */

const PERIOD_LABEL: Record<string, string> = { daily: "۲۴ ساعت", weekly: "۷ روز", monthly: "۳۰ روز", all: "کل تاریخ" };
const PERIOD_DAYS: Record<string, number> = { weekly: 7, monthly: 30 };

/** Board for a period, with the documented fallback chain. */
async function boardFor(env: Env, store: Store, period: "daily" | "weekly" | "monthly" | "all") {
  const rows = await store.board(period, "all", 15).catch(() => [] as any[]);
  if (rows.length) return { items: rows.map(fromBoard), period, source: "board" };

  const eng = new TrendingEngine(env);

  // weekly / monthly: compute real growth from the snapshots we have
  if (period === "weekly" || period === "monthly") {
    const days = PERIOD_DAYS[period];
    const leaders = await store.growthLeaders(days, 15).catch(() => [] as any[]);
    if (leaders.length) {
      return {
        items: leaders.map((l: any) => ({
          full_name: l.full_name, description: l.description ?? "", stars: l.now ?? l.stars ?? 0,
          forks: l.forks ?? 0, language: l.language ?? null, topics: [],
          gained: l.gained, url: `https://github.com/${l.full_name}`,
        })),
        period, source: "snapshots", note: `رشد واقعی ${PERIOD_LABEL[period]} از اسنپ‌شات‌های ذخیره‌شده`,
      };
    }
  }

  // last resort for any period: rank live and label it honestly
  const live = await eng.rank(period === "all" ? "monthly" : period, "all", 15).catch(() => [] as any[]);
  if (live.length) {
    const matured = period === "daily";
    return {
      items: live.map(fromBoard), period, source: "live",
      note: matured ? undefined : `داده‌ی ${PERIOD_LABEL[period]} هنوز کامل نشده — این فهرست بر پایه‌ی محبوبیت کل و تازگی مرتب شده و با پر شدن اسنپ‌شات‌ها به رشد واقعی تغییر می‌کند`,
    };
  }
  return { items: [], period, source: "none" };
}

/** Hidden-gem ranking: quality per star, tuned for "before it explodes". */
async function gemsFor(env: Env, store: Store) {
  const cached = await env.CACHE.get<{ at: number; items: any[] }>("api:gems", "json").catch(() => null);
  if (cached && Date.now() - cached.at < 3600_000) return { items: cached.items, cached: true };
  const gh = new GithubRest(env);
  const res = await gh
    .searchRepos("stars:80..1500 pushed:>2026-05-01 archived:false is:public", "updated", "desc", 30)
    .catch(() => null);
  const items = (res?.items ?? []).map((r: any) => {
    const ageDays = Math.max(30, (Date.now() - Date.parse(r.created_at)) / 86400000);
    const perDay = r.stargazers_count / ageDays;
    const health = healthScore({
      stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count,
      pushed_at: r.pushed_at, created_at: r.created_at, license: r.license?.spdx_id,
      description: r.description, has_readme: true,
    });
    return { ...fromGh(r), health, score: Math.round(health * 0.6 + Math.min(40, perDay * 30)) };
  }).sort((a: any, b: any) => b.score - a.score).slice(0, 15);
  await env.CACHE.put("api:gems", JSON.stringify({ at: Date.now(), items }), { expirationTtl: 3600 })
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  return { items, cached: false };
}

function fromGh(r: any) {
  return {
    full_name: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count,
    language: r.language, topics: r.topics ?? [], url: r.html_url, pushed_at: r.pushed_at,
    license: r.license?.spdx_id ?? null, avatar: r.owner?.avatar_url,
  };
}
function fromBoard(r: any) {
  return { full_name: r.full_name, description: r.description, stars: r.stars, forks: r.forks ?? 0, language: r.language, topics: r.topics ?? [], gained: r.gained, health: r.quality, url: `https://github.com/${r.full_name}` };
}
function brief(r: any) { return { full_name: r.full_name, description: r.description, stars: r.stargazers_count, language: r.language, url: r.html_url }; }
function safeJson(s: string | null | undefined) { try { return JSON.parse(s ?? "[]"); } catch { return []; } }

/** Standalone, screenshot-optimised share card (1200×630). */
function shareCardHtml(m: any, hist: { spark: string; rows: any[]; first: number | null; last: number | null }) {
  const langs = safeJson(m.languages) as any[];
  const total = langs.reduce((s, l) => s + (l.bytes ?? 0), 0) || 1;
  const gain = hist.first && hist.last ? hist.last - hist.first : null;
  const bars = langs.slice(0, 5).map((l) => ({ name: l.name, pct: Math.round(((l.bytes ?? 0) / total) * 100), color: l.color ?? "#22d3ee" }));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1200px;height:630px;background:linear-gradient(135deg,#0b0f19 0%,#0d2130 55%,#0b2b23 100%);
    font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;color:#e6edf3;padding:56px;display:flex;flex-direction:column;justify-content:space-between}
  .top{display:flex;justify-content:space-between;align-items:flex-start}
  h1{font-size:52px;letter-spacing:-1px;line-height:1.1}
  h1 span{color:#22d3ee}
  .desc{color:#9ca3af;font-size:22px;margin-top:16px;max-width:820px;line-height:1.5}
  .badges{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
  .b{background:#111827cc;border:1px solid #1f2937;padding:9px 16px;border-radius:999px;font-size:19px}
  .logo{font-size:26px;font-weight:800;background:linear-gradient(90deg,#22d3ee,#a3e635);-webkit-background-clip:text;background-clip:text;color:transparent}
  .bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
  .stats{display:flex;gap:36px}
  .stat b{display:block;font-size:42px;color:#a3e635}
  .stat span{color:#9ca3af;font-size:18px}
  .langs{flex:1;max-width:420px}
  .lang{display:flex;align-items:center;gap:10px;margin-bottom:9px}
  .lang .n{width:120px;font-size:17px;color:#cbd5e1}
  .lang .track{flex:1;height:10px;background:#1f2937;border-radius:5px;overflow:hidden}
  .lang .fill{height:100%}
  .lang .p{font-size:16px;color:#9ca3af;width:48px;text-align:right}
  .health{margin-top:18px;font-size:20px;color:#cbd5e1}
  </style></head><body>
    <div class="top">
      <div>
        <h1><span>${esc(m.owner)}</span>/${esc(m.name)}</h1>
        <div class="desc">${esc((m.description ?? "").slice(0, 220))}</div>
        <div class="badges">
          ${m.language ? `<div class="b">🧩 ${esc(m.language)}</div>` : ""}
          ${m.license ? `<div class="b">⚖️ ${esc(m.license)}</div>` : ""}
          ${m.archived ? `<div class="b">📦 archived</div>` : ""}
          <div class="b">⭐ ${fmt(m.stars)}</div>
        </div>
      </div>
      <div class="logo">GitHub Lens Ultra</div>
    </div>
    <div class="bottom">
      <div>
        <div class="stats">
          <div class="stat"><b>${fmt(m.stars)}</b><span>stars</span></div>
          <div class="stat"><b>${fmt(m.forks)}</b><span>forks</span></div>
          <div class="stat"><b>${m.health_score ?? 0}</b><span>health</span></div>
          ${gain !== null ? `<div class="stat"><b>+${fmt(gain)}</b><span>90d growth</span></div>` : ""}
        </div>
        ${hist.spark ? `<div class="health">📈 ${esc(hist.spark)}</div>` : ""}
      </div>
      <div class="langs">
        ${bars.map((b) => `<div class="lang"><div class="n">${esc(b.name)}</div><div class="track"><div class="fill" style="width:${b.pct}%;background:${b.color}"></div></div><div class="p">${b.pct}%</div></div>`).join("")}
        <div class="health">❤️ health ${m.health_score ?? 0}/100 · 🕒 updated ${new Date(m.updated_at ?? Date.now()).toISOString().slice(0, 10)}</div>
      </div>
    </div>
  </body></html>`;
}

function compareCardHtml(a: any, b: any) {
  const rows: [string, any, any, number][] = [
    ["⭐ Stars", a.stars, b.stars, 1], ["🍴 Forks", a.forks, b.forks, 1],
    ["🐞 Open issues", a.open_issues, b.open_issues, -1], ["❤️ Health", a.health_score, b.health_score, 1],
    ["🧩 Language", a.language ?? "—", b.language ?? "—", 0], ["⚖️ License", a.license ?? "—", b.license ?? "—", 0],
    ["📅 Updated", new Date(a.updated_at ?? 0).toISOString().slice(0, 10), new Date(b.updated_at ?? 0).toISOString().slice(0, 10), 0],
  ];
  const fmtv = (v: any) => (typeof v === "number" ? fmt(v) : String(v));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{width:1200px;min-height:630px;background:linear-gradient(135deg,#0b0f19,#131c2b);color:#e6edf3;
    font-family:system-ui,-apple-system,Tahoma,sans-serif;padding:48px}
  h1{font-size:40px;margin:0 0 6px}.logo{font-size:22px;font-weight:800;background:linear-gradient(90deg,#22d3ee,#a3e635);-webkit-background-clip:text;background-clip:text;color:transparent}
  table{width:100%;border-collapse:collapse;margin-top:28px;font-size:22px}
  th,td{padding:16px;border-bottom:1px solid #1f2937;text-align:center}
  th:first-child,td:first-child{text-align:left;color:#9ca3af;width:26%}
  .win{color:#a3e635;font-weight:800}.lose{color:#f87171}
  </style></head><body>
  <div class="logo">GitHub Lens Ultra</div>
  <h1>${esc(a.full_name)} <span style="color:#6b7280">vs</span> ${esc(b.full_name)}</h1>
  <table><thead><tr><th>metric</th><th>${esc(a.name)}</th><th>${esc(b.name)}</th></tr></thead><tbody>
  ${rows.map(([label, av, bv, dir]) => {
    const an = typeof av === "number" ? av : NaN, bn = typeof bv === "number" ? bv : NaN;
    const aWin = dir !== 0 && Number.isFinite(an) && Number.isFinite(bn) && ((dir > 0 && an > bn) || (dir < 0 && an < bn));
    const bWin = dir !== 0 && Number.isFinite(an) && Number.isFinite(bn) && ((dir > 0 && bn > an) || (dir < 0 && bn < an));
    return `<tr><td>${label}</td><td class="${aWin ? "win" : bWin ? "lose" : ""}">${fmtv(av)}</td><td class="${bWin ? "win" : aWin ? "lose" : ""}">${fmtv(bv)}</td></tr>`;
  }).join("")}
  </tbody></table></body></html>`;
}

function esc(s: string) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}


/**
 * Validate Telegram WebApp initData (HMAC-SHA256 of the data-check-string with
 * a key derived from the bot token) and return the user id it belongs to.
 */
export async function userIdFromInitData(env: Env, url: URL, request: Request): Promise<number | null> {
  const raw = url.searchParams.get("initData") || request.headers.get("x-telegram-init-data") || "";
  if (!raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get("hash") ?? "";
    if (!hash) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secretKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const derived = await crypto.subtle.sign("HMAC", secretKey, new TextEncoder().encode(env.BOT_TOKEN));
    const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataCheck));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return null;
    const auth = JSON.parse(params.get("user") ?? "{}");
    return Number(auth?.id) || null;
  } catch {
    return null;
  }
}
