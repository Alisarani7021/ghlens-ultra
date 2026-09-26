import type { Ctx, Env } from "../env";
import { Telegram } from "../tg/api";
import { Store } from "./db";
import { TrendingEngine } from "../github/trending";
import { AiBrain, aiHalted } from "../ai/brain";
import { GithubRest } from "../github/rest";
import { SecurityEngine } from "../github/osv";
import { fmt } from "../features/cards";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

/**
 * Cron orchestration.
 *
 * Cloudflare's free plan caps cron triggers per ACCOUNT (not per worker), and
 * other projects on this account already use some, so Lens Ultra runs on two:
 *
 *   "every 15 min" → snapshots, trending refresh, digest drain, broadcasts
 *   "daily at 06:00 UTC" → digests + fresh indexing, and promotes to
 *                   the weekly report on Sundays and monthly retention on the 1st
 *
 * classifyCron() recognises all five historical shapes, so a future paid-plan
 * deployment can add `0 * * * *`, `0 6 * * SUN`, `0 4 1 * *` without code edits.
 */
/* The webhook decides which updates Telegram even delivers. One registered
   without channel_post silences armChannelPost forever: the worker never
   hears about a channel post, so the four glass keys can never grow under
   it. Read the live webhook; if channel posts are missing, re-register the
   SAME url with the full update list — self-healing, no secret by hand. */
async function healWebhook(env: Env, store: Store): Promise<void> {
  const tg = new Telegram(env);
  const info: any = await tg.call("getWebhookInfo").catch(() => null);
  const hook = info?.result ?? {};
  if (!hook?.url || Telegram.deliversChannelPosts(hook)) return;
  const r: any = await tg.call("setWebhook", {
    url: hook.url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: false,
    max_connections: 40,
    allowed_updates: ["message", "callback_query", "inline_query", "channel_post", "my_chat_member", "chosen_inline_result", "pre_checkout_query"],
  }).catch((e: any) => ({ ok: false, description: String(e?.message ?? e) }));
  console.log("webhook-heal", r?.ok === true ? "rebound" : JSON.stringify(r).slice(0, 200));
  await store.event(null, "webhook", r?.ok === true ? "rebind:ok" : "rebind:fail", {
    url: String(hook.url).slice(0, 60),
    error: r?.ok === true ? undefined : String(r?.description ?? "").slice(0, 120),
  }).catch(() => null);
}

export async function runCron(event: ScheduledController, env: Env, ctx: Ctx) {
  const cron = event.cron;
  const store = new Store(env);
  const started = Date.now();
  console.log("cron", cron);

  try {
    switch (classifyCron(cron)) {
      case "fast": {
        await healWebhook(env, store).catch((e) => console.error("webhook-heal", e));
        await fastPoll(env, ctx);
        /* This account's cron triggers refuse to come alive as a fresh fourth
           schedule — but modifying a live one applies within minutes. The old
           15-minute trigger therefore became this five-minute tick, and the
           quarter work rides along at :00/:15/:30/:45: one trigger, two
           cadences. */
        if (new Date().getUTCMinutes() % 15 === 0) await quarterHourly(env, store, ctx);
        break;
      }
      case "quarter": await quarterHourly(env, store, ctx); break;
      case "hourly":  await hourly(env, store, ctx); break;
      case "weekly":  await weekly(env, store, ctx); break;
      case "monthly": await monthly(env, store, ctx); break;
      case "daily":
      default: {
        // One daily trigger covers three cadences: hourly index/security work
        // runs, weekly maintenance on Sundays, retention on the 1st.
        await daily(env, store, ctx);
        const now = new Date();
        if (now.getUTCDay() === 0) await weekly(env, store, ctx);
        if (now.getUTCDate() === 1) await monthly(env, store, ctx);
        // keep the fresh-index pipeline moving a few times per day
        await hourly(env, store, ctx).catch((e) => console.error("hourly-in-daily", e));
        break;
      }
    }
  } catch (e) {
    console.error("cron failure", cron, e);
    await env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind("cron:error", `${cron} ${String((e as any)?.message ?? e).slice(0, 200)}`, Date.now())
      .run().catch((err: any) => console.error("lens-swallowed", String(err?.message ?? err)));
  } finally {
    // heartbeat: /health shows when the scheduler last ran (visible proof that
    // Cloudflare is actually invoking us, not just that the deploy succeeded).
    await env.DB.prepare(
      `INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`,
    ).bind("cron:last", `${cron} took ${Date.now() - started}ms`, Date.now())
      .run().catch((err: any) => console.error("lens-swallowed", String(err?.message ?? err)));
    await env.ANALYTICS?.writeDataPoint({ blobs: ["cron", cron], doubles: [Date.now() - started] });
  }
}

/** Every 15 minutes: snapshot what matters, refresh boards, drain digests. */
async function quarterHourly(env: Env, store: Store, ctx: Ctx) {
  const engine = new TrendingEngine(env);

  // 1. which repos deserve a snapshot? (subscribed + on the current board)
  const { results: watched } = await env.DB.prepare(
    `SELECT DISTINCT full_name FROM subscriptions LIMIT 600`,
  ).all<{ full_name: string }>().catch(() => ({ results: [] as any[] }));
  const board = await engine.rank("daily", "all", 30).catch(() => []);
  const targets = [...new Set([...(watched ?? []).map((w) => w.full_name), ...board.map((b: any) => b.full_name)])].slice(0, 40);

  if (targets.length) await engine.snapshot(targets);
  if (board.length) await engine.store("daily", "all", board);

  // 2. drain due digests (releases / security alerts queued by webhooks or checks)
  const { results: due } = await env.DB.prepare(
    `SELECT id, user_id, kind, payload FROM digest_queue WHERE sent_at IS NULL AND send_after <= ? LIMIT 40`,
  ).bind(Date.now()).all<{ id: string; user_id: number; kind: string; payload: string }>().catch(() => ({ results: [] as any[] }));
  const tg = new Telegram(env);
  for (const row of due ?? []) {
    try {
      const p = JSON.parse(row.payload);
      if (row.kind === "broadcast") {
        await tg.sendMessage(row.user_id, p.text, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      } else if (p.text) {
        await tg.sendMessage(row.user_id, p.text, { parse_mode: "HTML", reply_markup: p.markup }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
      await env.DB.prepare(`UPDATE digest_queue SET sent_at=? WHERE id=?`).bind(Date.now(), row.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    } catch { /* drop malformed */ }
  }
  // broadcast fan-out: expand the special user_id=0 row
  const bcast = await env.DB.prepare(`SELECT payload FROM digest_queue WHERE id LIKE 'bcast:%' AND sent_at IS NULL LIMIT 1`).first<{ payload: string }>().catch(() => null);
  if (bcast) {
    const { text } = JSON.parse(bcast.payload);
    const { results: users } = await env.DB.prepare(`SELECT id FROM users WHERE banned=0 ORDER BY last_seen_at DESC LIMIT 200`).all<{ id: number }>().catch(() => ({ results: [] as any[] }));
    for (const u of users ?? []) {
      await ctx_wait(ctx, tg.sendMessage(u.id, `📣 ${text}`, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e))));
      await new Promise((r) => setTimeout(r, 45)); // ~20 msg/s, safely under Telegram limits
    }
    await env.DB.prepare(`UPDATE digest_queue SET sent_at=? WHERE id LIKE 'bcast:%'`).bind(Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  // 4. hub connectors: pull whatever changed outside, put it on the bus.
  //    Imported lazily so the cron path does not drag the whole hub into every
  //    cold start of the Telegram handler.
  const { pollDueConnectors } = await import("../features/hubos");
  await pollDueConnectors(env, new AiBrain(env), tg).catch((e: any) => console.error("hub-poll", String(e?.message ?? e)));
}
function ctx_wait(ctx: Ctx, p: Promise<unknown>) { ctx.waitUntil(Promise.resolve(p)); }

/** Every five minutes: hub connectors only. A repository that belongs to
 *  someone else can never have a webhook — for it, the poll IS the delivery,
 *  and a 15-minute wait is not «بلافاصله» in anyone's dictionary. The heavy
 *  quarter-hourly work (snapshots, boards, digests) stays on its own clock. */
async function fastPoll(env: Env, ctx: Ctx) {
  const { pollDueConnectors } = await import("../features/hubos");
  await pollDueConnectors(env, new AiBrain(env), new Telegram(env))
    .catch((e: any) => console.error("hub-fast-poll", String(e?.message ?? e)));
}

/** Hourly: keep the semantic index and security watchlist fresh. */
async function hourly(env: Env, store: Store, ctx: Ctx) {
  const ai = new AiBrain(env);
  const gh = new GithubRest(env);

  // 1. index a slice of fresh repos into Vectorize (100 per hour ≈ 2400/day)
  const { results } = await env.DB.prepare(
    `SELECT * FROM repos WHERE indexed_at IS NULL OR indexed_at < updated_at ORDER BY stars DESC LIMIT 40`,
  ).all<any>().catch(() => ({ results: [] as any[] }));

  if (results?.length) {
    const { VectorIndex } = await import("../ai/vector");
    const vi = new VectorIndex(env, ai);
    const docs = [];
    for (const r of results) {
      const readme = await gh.readme(r.full_name, 604800).catch(() => null);
      const digest = readme?.content ? atob(readme.content.replace(/\n/g, "")).replace(/[#*`>-]/g, " ").replace(/\s+/g, " ").slice(0, 600) : "";
      docs.push(VectorIndex.docFromMeta({
        full_name: r.full_name, description: r.description, language: r.language,
        languages: [], topics: safeJson(r.topics), license: r.license, stars: r.stars,
        health: r.health_score, pushed_at: r.pushed_at ? new Date(r.pushed_at).toISOString() : null,
      }, digest));
    }
    await vi.upsertRepos(docs).catch((e) => console.error("index failed", e));
  }

  // 2. security sweep for watched repos: check advisories, queue alerts
  const { results: watched } = await env.DB.prepare(
    `SELECT DISTINCT full_name FROM subscriptions WHERE events LIKE '%security%' LIMIT 25`,
  ).all<{ full_name: string }>().catch(() => ({ results: [] as any[] }));
  const sec = new SecurityEngine(env, gh);
  for (const w of watched ?? []) {
    const alerts = await gh.securityAdvisories(w.full_name).catch(() => []);
    for (const a of alerts.slice(0, 5)) {
      const id = a.ghsa_id ?? a.cve_id ?? crypto.randomUUID();
      const seen = await env.DB.prepare(`SELECT 1 FROM advisories WHERE id=? AND full_name=?`).bind(id, w.full_name).first().catch(() => null);
      if (seen) continue;
      await env.DB.prepare(`INSERT OR REPLACE INTO advisories (id, full_name, severity, summary, published, seen_at) VALUES (?,?,?,?,?,?)`)
        .bind(id, w.full_name, a.severity ?? "UNKNOWN", (a.summary ?? "").slice(0, 400), a.published_at ?? "", Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      const { results: subs } = await env.DB.prepare(`SELECT user_id FROM subscriptions WHERE full_name=? AND events LIKE '%security%'`).bind(w.full_name).all<{ user_id: number }>().catch(() => ({ results: [] as any[] }));
      const tg = new Telegram(env);
      const text =
        `🛡 <b>هشدار امنیتی جدید</b>\n\n📦 <b>${tgEscape(w.full_name)}</b>\n` +
        `⚠️ <b>${tgEscape(a.severity ?? "UNKNOWN")}</b> — ${tgEscape((a.summary ?? "").slice(0, 200))}\n` +
        `<code>${tgEscape(id)}</code>`;
      for (const s of subs ?? []) {
        await tg.sendMessage(s.user_id, text, { parse_mode: "HTML", reply_markup: kb([[{ text: "🛡 اسکن کامل", cb: `sec:repo:${w.full_name}` }]]) }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    }
  }
}

/** Daily 06:00 UTC: personalised digests + fresh indexing. */
async function daily(env: Env, store: Store, ctx: Ctx) {
  const ai = new AiBrain(env);
  const tg = new Telegram(env);
  // the free neuron budget is finite: when it is spent, send the digest with
  // pure data instead of throwing AI calls at a wall
  const halted = await aiHalted(env);
  const engine = new TrendingEngine(env);

  const board = await engine.rank("daily", "all", 25).catch(() => []);
  if (board.length) await engine.store("daily", "all", board);

  // two AI articles for the digest: hottest + best newcomer
  const rows = board.slice(0, 8).map((r: any) => ({ full_name: r.full_name, description: r.description, stars: r.stars, gained: r.gained, lang: r.language, topics: (r.topics ?? []).slice(0, 3) }));
  const narrative = halted ? "" : await ai.chat(
    `Write a short Persian morning brief (max 180 words) about today's GitHub trends using ONLY this data. ` +
      `Mention 3 repos with their star counts and why developers care. No fluff, no emojis.\n\n${JSON.stringify(rows)}`,
    { tier: "smart", max_tokens: 500, cacheKey: `digest:${new Date().toISOString().slice(0, 10)}`, cacheTtl: 43200 },
  );

  const digestText =
    `☀️ <b>خلاصه صبحگاهی گیت‌هاب</b> — ${new Date().toISOString().slice(0, 10)}\n\n` +
    tgEscape(narrative || "") + `\n\n` +
    `<b>🔥 سه تای برتر امروز</b>\n` +
    board.slice(0, 3).map((r: any, i: number) =>
      `${["🥇", "🥈", "🥉"][i]} <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stars)}${r.gained ? ` (+${fmt(r.gained)})` : ""}`).join("\n");

  const digestMarkup = kb(
    [
      { text: "📈 روند ۷ روز", cb: "t:growth:7" },
      { text: "🔥 لیست کامل", cb: "t:b:0,daily,all" },
    ],
    [{ text: "🔎 جست‌وجوی امروز", cb: "n:search" }],
  );

  // enqueue per-user personalised digest (interests-aware)
  const { results: users } = await env.DB.prepare(
    `SELECT id, interests FROM users WHERE last_seen_at > ? AND banned=0 LIMIT 500`,
  ).bind(Date.now() - 14 * 86400000).all<{ id: number; interests: string }>().catch(() => ({ results: [] as any[] }));

  for (const u of users ?? []) {
    const interests: string[] = safeJson(u.interests) ?? [];
    let text = digestText;
    if (interests.length && !halted) {
      const rows2 = await ai.json<{ picks: { full_name: string; why_fa: string }[] }>(
        `Pick 3 repositories (real, from the list) relevant to a developer interested in: ${interests.join(", ")}. ` +
          `For each write one Persian sentence about why they'd care. JSON: {"picks":[{"full_name":"...","why_fa":"..."}]}\n\nLIST:\n${JSON.stringify(rows)}`,
        { tier: "fast", max_tokens: 500, cacheKey: `pick:${u.id}:${new Date().toISOString().slice(0, 10)}` },
      );
      if (rows2?.picks?.length) {
        text += `\n\n<b>✨ بر اساس علاقه‌مندی‌های تو</b>\n` + rows2.picks.map((p) => `• <b>${tgEscape(p.full_name)}</b> — ${tgEscape(p.why_fa)}`).join("\n");
      }
    }
    await store.enqueueDigest(u.id, "daily", { text, markup: digestMarkup }, Date.now());
  }
  console.log("daily digest queued for", users?.length ?? 0);
}

/** Weekly (Sunday 06:00): report, leaderboard, cleanup. */
async function weekly(env: Env, store: Store, ctx: Ctx) {
  const tg = new Telegram(env);
  const engine = new TrendingEngine(env);
  const week = Store.week();

  const leaders = await store.growthLeaders(7, 15);
  const board = await engine.rank("weekly", "all", 25).catch(() => []);
  if (board.length) await engine.store("weekly", "all", board);

  const boardRows = await store.leaderboard("queries", 10);
  const medals = ["🥇", "🥈", "🥉"];
  const report =
    `📅 <b>گزارش هفتگی اوپن‌سورس</b> — ${week}\n\n` +
    `<b>🚀 سریع‌ترین رشدها</b>\n` +
    (leaders.slice(0, 8).map((r: any, i: number) => `${medals[i] ?? `${i + 1}.`} <b>${tgEscape(r.full_name)}</b> — +${fmt(r.gained)} ⭐`).join("\n") || "—") +
    `\n\n<b>🏆 فعال‌ترین کاربران</b>\n` +
    (boardRows.map((r: any, i: number) => `${medals[i] ?? `${i + 1}.`} ${tgEscape(r.first_name ?? r.username ?? "کاربر")} — ${fmt(r.value)} امتیاز`).join("\n") || "—");

  // fan out to everyone active
  const { results: users } = await env.DB.prepare(`SELECT id FROM users WHERE last_seen_at > ? AND banned=0 LIMIT 500`)
    .bind(Date.now() - 30 * 86400000).all<{ id: number }>().catch(() => ({ results: [] as any[] }));
  for (const u of users ?? []) {
    await store.enqueueDigest(u.id, "weekly", { text: report, markup: kb([[{ text: "🏆 لیدربورد", cb: "me:board" }, { text: "🔥 هفتگی", cb: "t:b:0,weekly,all" }]]) }, Date.now());
  }

  // cleanup: old trending rows, old webhook log
  await env.DB.prepare(`DELETE FROM trending WHERE day < date('now','-21 days')`).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM webhook_log WHERE ts < ?`).bind(Date.now() - 14 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM digest_queue WHERE sent_at IS NOT NULL AND sent_at < ?`).bind(Date.now() - 7 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

/** Monthly: deep retention + storage hygiene. */
async function monthly(env: Env, store: Store, ctx: Ctx) {
  await env.DB.prepare(`DELETE FROM events WHERE ts < ?`).bind(Date.now() - 180 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM repo_snapshots WHERE day < date('now','-2 years')`).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM ai_usage WHERE day < date('now','-90 days')`).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM downloads WHERE created_at < ? AND status='ready'`).bind(Date.now() - 30 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM messages WHERE ts < ?`).bind(Date.now() - 60 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  await env.DB.prepare(`DELETE FROM webhook_log WHERE ts < ?`).bind(Date.now() - 30 * 86400000).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  console.log("monthly retention done");
}

function safeJson(s: string | null | undefined): any[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}


/**
 * Cloudflare's cron parser is stricter than Vixie cron: day-of-week `0` is
 * rejected (use 1-7 or SUN-SAT). Classifying by *shape* instead of exact
 * string means the worker keeps working if the schedule is edited later.
 */
export function classifyCron(cron: string): "fast" | "quarter" | "hourly" | "daily" | "weekly" | "monthly" {
  const c = (cron || "").trim().replace(/\s+/g, " ");
  if (c === "*/5 * * * *") return "fast";                         // hub connectors only
  if (c.startsWith("*/")) return "quarter";                       // */15 * * * *
  const [min, hour, dom, mon, dow] = c.split(" ");
  if (dom !== "*" && dow === "*") return "monthly";                // 0 4 1 * *
  if (dow !== "*") return "weekly";                                // 0 6 * * SUN
  if (hour !== "*" && dom === "*" && mon === "*") return "daily";  // 0 6 * * *
  return "hourly";                                                 // 0 * * * *
}
