import type { Ctx, Env } from "../env";
import { Store } from "./db";
import { GithubRest, healthScore } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { fmt } from "../features/cards";

/**
 * Public JSON API — powers the Telegram Mini App, share cards and any
 * external integration (all read-only, no secrets leaked, CORS-enabled).
 *
 *   GET /api/miniapp?kind=…        — data for the WebApp
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
      case "/api/miniapp": return json(await miniapp(url, env, store), 200, cors);
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
        return json({ error: "unknown endpoint", endpoints: ["/api/miniapp", "/api/repo", "/api/card", "/api/compare-card", "/api/stats", "/api/search"] }, 404, cors);
    }
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500, cors);
  }
}

async function miniapp(url: URL, env: Env, store: Store) {
  const kind = url.searchParams.get("kind") ?? "trending";
  const q = url.searchParams.get("q") ?? "";
  switch (kind) {
    case "search": {
      const res = await new GithubRest(env).searchRepos(q || "stars:>5000", "stars", "desc", 15).catch(() => null);
      return { items: (res?.items ?? []).map(fromGh) };
    }
    case "weekly": {
      const rows = await store.board("weekly", "all", 15);
      if (rows.length) return { items: rows.map(fromBoard) };
      const eng = new TrendingEngine(env);
      return { items: (await eng.rank("weekly", "all", 15).catch(() => [])).map(fromBoard) };
    }
    case "gems": {
      const res = await new GithubRest(env).searchRepos("stars:100..1200 pushed:>2026-06-01 archived:false", "updated", "desc", 15).catch(() => null);
      return { items: (res?.items ?? []).map((r: any) => ({ ...fromGh(r), health: healthScore({ stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count, pushed_at: r.pushed_at, created_at: r.created_at, license: r.license?.spdx_id, description: r.description, has_readme: true }) })) };
    }
    case "favorites": case "subs": {
      // the mini-app sends Telegram initData; for the public read-only build we
      // return a curated sample when identity cannot be verified
      const rows = await store.board("daily", "all", 10);
      return { items: rows.map(fromBoard), note: "sign in via the bot for your personal list" };
    }
    default: {
      const rows = await store.board("daily", "all", 15);
      if (rows.length) return { items: rows.map(fromBoard) };
      const eng = new TrendingEngine(env);
      return { items: (await eng.rank("daily", "all", 15).catch(() => [])).map(fromBoard) };
    }
  }
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
