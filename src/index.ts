import { NetRadar } from "./features/netradar";
import { ArchitectureExplainer } from "./features/architecture";
import { AppGen } from "./features/appgen";
import { MultiHub } from "./features/multihub";
import type { Ctx, Env, Job } from "./env";
import { botUsername, isAdmin } from "./env";
import { Telegram, splitSmart } from "./tg/api";
import type { CallbackQuery, InlineQuery, Message, Update, User } from "./tg/types";
import { tgEscape } from "./tg/types";
import { kb } from "./tg/keyboards";
import { Store } from "./core/db";
import { BlobStore } from "./core/blobstore";
import { AiBrain } from "./ai/brain";
import { RepoCard } from "./features/cards";
import type { H } from "./core/handler";
import { loadingText } from "./core/handler";
import { GithubRest } from "./github/rest";
import { TrendingEngine } from "./github/trending";
import { SearchFeature } from "./features/search";
import { TrendingFeature } from "./features/trending";
import { BrowseFeature } from "./features/browse";
import { DeepScout } from "./features/deep";
import { Downloader } from "./features/download";
import { ToolsFeature } from "./features/tools";
import { DevUtils } from "./features/devutils";
import { ProfileFeature } from "./features/profile";
import { SecurityFeature } from "./features/security";
import { Assistant } from "./features/assistant";
import { Discover } from "./features/discover";
import { Contribute } from "./features/contribute";
import { Settings, githubSetupCard, githubSetupKb, aiEngineState } from "./features/settings";
import { Admin } from "./features/admin";
import { handleWebhook } from "./core/webhook";
import { runCron } from "./core/cron";
import { consumeQueue } from "./core/queue";
import { handleApi } from "./core/api";
import { audioBytes, describe } from "./ai/brain";
import { aiDownNotice, aiHalted } from "./ai/brain";
import { readMode, touchMode, clearMode, modeKeeps, setMode } from "./core/mode";
import { parseRepoRef } from "./core/repo-ref";
import { decryptSecret, encryptSecret } from "./core/crypto";
import { keys as keysFeature } from "./features/keys";
import { account as accountFeature } from "./features/account";
import { hubOS } from "./features/hubos";
import { handleHook } from "./hub/hooks";
import { authorise, chatCompletion, modelsResponse, streamResponse } from "./hub/gateway";

export { UserSession } from "./core/session";

// feature singletons (stateless — safe to reuse per isolate)
const search = new SearchFeature();
const browse = new BrowseFeature();
const scout = new DeepScout();
const tools = new ToolsFeature();
const devutils = new DevUtils();
const profile = new ProfileFeature();
const security = new SecurityFeature();
const assistant = new Assistant();
const discover = new Discover();
const contribute = new Contribute();
const settings = new Settings();
const admin = new Admin();
const netRadar = new NetRadar();
const archExplainer = new ArchitectureExplainer();
const appGen = new AppGen();
const multiHub = new MultiHub();

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();

    // This account cannot serve *.workers.dev (every script there dies with
    // error 1101), so Lens Ultra is mounted on a custom domain behind a path
    // prefix, e.g. https://drsarli.ir/lens/health. WORKER_URL carries the
    // prefix and we transparently strip it so every route below stays clean.
    const mounted = (() => {
      try {
        const p = new URL(env.WORKER_URL ?? "").pathname.replace(/\/+$/, "");
        return p === "/" ? "" : p;
      } catch {
        return "";
      }
    })();
    if (mounted && (url.pathname === mounted || url.pathname.startsWith(mounted + "/"))) {
      url.pathname = url.pathname.slice(mounted.length) || "/";
      // Rebuild the Request so downstream handlers (handleApi, handleWebhook…)
      // that re-parse request.url also see the stripped path.
      request = new Request(url.toString(), request);
    }

    try {
      // ── Telegram webhook ───────────────────────────────────────────────
      if (url.pathname === `/tg/${env.TELEGRAM_WEBHOOK_SECRET}` && request.method === "POST") {
        const secret = request.headers.get("x-telegram-bot-api-secret-token");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const update = (await request.json()) as Update;
        // acknowledge instantly; process in the background
        ctx.waitUntil(handleUpdate(update, env, ctx).catch((e) => console.error("tg-update-failed", String(e?.stack ?? e))));
        return new Response("ok");
      }

      // ── self-test: runs the real update pipeline inline and reports what the
      //    bot would send. Never touches Telegram: outgoing API calls are
      //    captured, so this doubles as an end-to-end assertion harness. ──────
      if (url.pathname === "/selfcheck") {
        const secret = url.searchParams.get("deep");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        /* Two modes, and the difference matters.
           With `uid` the audit impersonates that account, which is how a screen
           gets inspected exactly as its owner sees it.
           Without `uid` it is a *probe*: the whole handler runs, every read is
           real, and not one write lands. The cheap version drove the real code
           path as a synthetic user and left him behind everywhere it touched —
           a users row, a weekly leaderboard entry, AI counters, download
           records. Reading is what a smoke test needs; writing was the bug. */
        const probe = !url.searchParams.has("uid");
        const uid = Number(url.searchParams.get("uid") ?? 999999);
        const text = url.searchParams.get("text") ?? "";
        const cb = url.searchParams.get("cb");            // simulate a button press
        const capture = url.searchParams.get("capture") !== "0";
        /* An audit drives the handler with a synthetic account. Marking it as a
           bot is both true and useful: the leaderboard (and anything else that
           counts people) skips it, so a health check can never outrank a real
           user on a public screen. */
        await new Store(env).upsertUser({ id: uid, is_bot: true, first_name: "Self (audit)" } as any).catch(() => null);
        const from = { id: uid, is_bot: false, first_name: "Self", language_code: "fa" } as any;
        const chat = { id: uid, type: "private", first_name: "Self" } as any;
        const message = {
          message_id: 990001, from, chat, date: Math.floor(Date.now() / 1000),
          text: text || (cb ? "" : "/start"),
          entities: text ? [{ offset: 0, length: text.length, type: "bot_command" }] : undefined,
        };
        const update: any = cb
          ? { update_id: 990002, callback_query: { id: "990002", from, message: { ...message, text: undefined }, chat_instance: "1", data: cb } }
          : { update_id: 990001, message };

        const sent: any[] = [];
        const logs: string[] = [];
        const origFetch = globalThis.fetch;
        const origLog = console.log, origErr = console.error;
        if (capture) {
          globalThis.fetch = (async (input: any, init?: any) => {
            const u = typeof input === "string" ? input : input?.url ?? String(input);
            if (u.includes("api.telegram.org")) {
              const method = u.split("/").pop()!;
              let body: any = init?.body;
              if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep raw */ } }
              else if (body instanceof FormData) {
                const o: any = {};
                for (const [k, v] of body.entries()) o[k] = typeof v === "string" ? v.slice(0, 200) : `[file ${(v as any)?.size ?? "?"}B]`;
                body = o;
              }
              sent.push({ method, body });
              return new Response(JSON.stringify({ ok: true, result: { message_id: 1, file_id: "f" } }), { headers: { "content-type": "application/json" } });
            }
            return origFetch(input, init);
          }) as any;
          console.log = (...a: any[]) => { logs.push("log " + a.map(String).join(" ").slice(0, 300)); };
          console.error = (...a: any[]) => { logs.push("err " + a.map(String).join(" ").slice(0, 300)); };
        }
        const t0 = Date.now();
        try {
          await handleUpdate(update, probe ? probeEnv(env) : env, ctx);
          const u = await new Store(env).user(uid);
          const replies = sent.map((s) => ({
            m: s.method,
            text: (s.body?.text ?? s.body?.caption ?? "") as string,
            cb_text: s.body?.text && s.method === "answerCallbackQuery" ? s.body.text : undefined,
            // every keyboard this reply carries, so the audit can assert things
            // like "every screen has a way back"
            buttons: (s.body?.reply_markup?.inline_keyboard ?? []).flat()
              .map((b: any) => b.text ?? b.web_app?.url ?? b.url ?? "").slice(0, 80),
            home: !!(s.body?.reply_markup?.keyboard),
            kb: s.body?.reply_markup?.inline_keyboard?.length ?? 0,
            doc: s.body?.document ?? s.body?.photo ?? undefined,
            // rich messages: keep the payload so an audit can check the shape
            // (blocks, rtl flag) instead of trusting that a new API worked
            rich: typeof s.body?.rich_message?.html === "string" ? s.body.rich_message.html : undefined,
            rtl: s.body?.rich_message?.is_rtl === true ? true : undefined,
            rich_len: typeof s.body?.rich_message?.html === "string" ? s.body.rich_message.html.length : undefined,
          }));
          return json({
            ok: true, ms: Date.now() - t0, text, cb, admin: isAdmin(env, uid),
            user_row: u ? { id: u.id, locale: u.locale, xp: u.xp, level: u.level } : null,
            replies: capture ? replies : undefined,
            logs: capture ? logs.slice(0, 40) : undefined,
          });
        } catch (e: any) {
          return json({
            ok: false, ms: Date.now() - t0, error: String(e?.message ?? e),
            stack: String(e?.stack ?? "").split("\n").slice(0, 5),
            replies: capture ? sent.map((s2) => ({ m: s2.method, text: (s2.body?.text ?? "").slice(0, 120) })) : undefined,
            logs: capture ? logs.slice(0, 15) : undefined,
          }, 500);
        } finally {
          globalThis.fetch = origFetch;
          console.log = origLog;
          console.error = origErr;
        }
      }

      // ── mock OpenAI-compatible provider (secret-gated) ─────────────────
      // Lets the key-donation flow be tested end to end against a provider
      // that behaves like a real one: the right key answers, and a flipped
      // flag makes it answer 402 so "exhausted keys are deleted at once" can
      // be proven instead of assumed. The gate *is* the API key, so with the
      // secret unknown this endpoint is just a 401.
      if (url.pathname.startsWith("/mock/v1/")) {
        const auth = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!env.TELEGRAM_WEBHOOK_SECRET || auth !== env.TELEGRAM_WEBHOOK_SECRET) {
          return json({ error: { code: 401, message: "invalid api key" } }, 401);
        }
        if (await env.CACHE.get("mock:exhausted")) {
          return json({ error: { code: 402, message: "quota exceeded — insufficient credits (mock)" } }, 402);
        }
        if (url.pathname.endsWith("/models")) {
          return json({ object: "list", data: [{ id: "mock-chat", object: "model", owned_by: "mock" }] });
        }
        const body: any = await request.json().catch(() => ({}));
        const last = (body?.messages ?? []).slice(-1)[0]?.content ?? "";
        return json({
          id: "mock-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: `پاسخ آزمایشی از کلید اهدایی ✅ — ${String(last).replace(/<[^>]+>/g, "").slice(0, 60)}` }, finish_reason: "stop" }],
          usage: { total_tokens: 7 },
        });
      }
      if (url.pathname === "/mock/control") {
        if (url.searchParams.get("deep") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const on = url.searchParams.get("exhausted") === "1";
        if (on) await env.CACHE.put("mock:exhausted", "1", { expirationTtl: 900 });
        else await env.CACHE.delete("mock:exhausted");
        return json({ ok: true, exhausted: on });
      }

      // ── GitHub webhook (releases, security, pushes) ────────────────────
      if (url.pathname === "/gh-webhook" && request.method === "POST") {
        return handleWebhook(request, env, ctx);
      }

      // ── GitHub OAuth callback (only reachable when the app is configured) ─
      if (url.pathname === "/oauth/gh/callback") {
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const uid = await verifyState(env, state);
        if (!uid) return new Response("invalid state", { status: 400 });
        const id = (env as any).GITHUB_OAUTH_CLIENT_ID, secret = (env as any).GITHUB_OAUTH_CLIENT_SECRET;
        if (!id || !secret) return new Response("oauth not configured", { status: 400 });
        const tok = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: id, client_secret: secret, code }),
        }).then((r) => r.json() as any);
        if (!tok?.access_token) return new Response("token exchange failed", { status: 400 });
        const me = await whoamiWithToken(tok.access_token);
        const enc = await encryptToken(env, tok.access_token);
        await new Store(env).upsertUser({ id: uid, is_bot: false, first_name: "" } as any);
        await env.DB.prepare(`UPDATE users SET github_login=?, github_token_enc=?, github_token_at=? WHERE id=?`)
          .bind(me?.login ?? null, enc, Date.now(), uid).run();
        const tg = new Telegram(env);
        await tg.sendMessage(uid, `✅ GitHub linked${me?.login ? ` as @${me.login}` : ""}. /profile`, { parse_mode: "HTML" });
        return new Response(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b1020;color:#e6edf3;text-align:center;padding:60px">` +
            `<h2>✅ اتصال انجام شد</h2><p>به تلگرام برگرد — پیام تأیید را فرستادم.</p></body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      // ── public JSON API (share cards, magic links, integrations) ────────
      // ── file ingest over HTTP ───────────────────────────────────────────
      // The Telegram path can only accept what the Bot API will hand over
      // (20MB, and only from a real chat). This is the same pipeline reachable
      // programmatically, which is what makes the file universe testable and
      // what lets an owner pipe a build artefact in from CI.
      //
      //   POST /hub/ingest?name=report.pdf&uid=1&key=<secret>   (body = bytes)
      if (url.pathname === "/hub/ingest" && request.method === "POST") {
        const key = url.searchParams.get("key") ?? request.headers.get("x-hub-key") ?? "";
        if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
          return json({ ok: false, error: "forbidden" }, 403);
        }
        const name = url.searchParams.get("name") ?? "upload.bin";
        const uid = Number(url.searchParams.get("uid") ?? 0);
        if (!uid) return json({ ok: false, error: "uid required" }, 400);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length) return json({ ok: false, error: "empty body" }, 400);
        if (bytes.length > 20 * 1024 * 1024) return json({ ok: false, error: "over 20MB" }, 413);
        const ingestAi = new (await import("./ai/brain")).AiBrain(env);
        const { ingest } = await import("./hub/files");
        const r = await ingest(env, ingestAi, {
          name, mime: request.headers.get("content-type") ?? undefined,
          bytes, owner_id: uid, skipEmbed: url.searchParams.get("embed") === "0",
        });
        return json({
          ok: true, doc_id: r.doc_id, kind: r.detected.kind, lang: r.detected.lang,
          extractable: r.detected.extractable, chars: r.chars,
          entities: r.entities, embedded: r.embedded,
          facts: r.facts, note: r.note, preview: r.preview.slice(0, 800),
        });
      }

      // the same address, opened in a browser, explains itself instead of 404ing
      if (url.pathname.startsWith("/hooks/") && request.method === "GET") {
        const { hookPage } = await import("./hub/hooks");
        const parts = url.pathname.split("/").filter(Boolean);
        return hookPage(env, parts[1] ?? "generic", parts[2] ?? "", new URL(request.url).origin);
      }

      // ── inbound webhooks: one endpoint per source, one shared pipeline ──
      if (url.pathname.startsWith("/hooks/") && request.method === "POST") {
        const source = url.pathname.split("/")[2] ?? "generic";
        const hookAi = new (await import("./ai/brain")).AiBrain(env);
        return handleHook(request, env, ctx, hookAi, source);
      }

      // ── AI gateway: OpenAI-compatible, authenticated ────────────────────
      if (url.pathname === "/v1" || url.pathname === "/v1/") {
        const { gatewayLanding } = await import("./hub/gateway");
        return gatewayLanding(new URL(request.url).origin);
      }
      if (url.pathname === "/v1/models" && request.method === "GET") return modelsResponse();
      /* Any other /v1 path answers with the list of real ones. Before this, a
         single mistyped character produced a bare «Not found» from the edge and
         nothing to act on. */
      if (url.pathname.startsWith("/v1/") && request.method === "GET") {
        const { gatewayNotFound } = await import("./hub/gateway");
        return gatewayNotFound(url.pathname);
      }
      if (url.pathname.startsWith("/v1/") && request.method === "POST") {
        const auth = await authorise(env, request);
        if (!auth.ok) return json({ error: { message: "invalid api key", type: "auth_error", code: 401 } }, 401);
        if (url.pathname === "/v1/chat/completions") {
          const body = await request.json().catch(() => null) as any;
          if (!body) return json({ error: { message: "invalid JSON body", type: "invalid_request_error", code: 400 } }, 400);
          const gwAi = new (await import("./ai/brain")).AiBrain(env);
          const result = await chatCompletion(env, gwAi, body, auth.who);
          return body.stream && result.status === 200 ? streamResponse(result.body) : json(result.body, result.status);
        }
        {
          const { gatewayNotFound } = await import("./hub/gateway");
          return gatewayNotFound(url.pathname);
        }
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi(request, env, ctx);
      }

      // ── health & metrics ───────────────────────────────────────────────
      if (url.pathname === "/health" && url.searchParams.get("ai") === "reset") {
        const secret = url.searchParams.get("deep");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        await env.CACHE.delete("ai:halt").catch(() => null);
        await env.CACHE.delete("ai:last-failure").catch(() => null);
        return Response.json({ ok: true, cleared: ["ai:halt", "ai:last-failure"] }, { headers: { "cache-control": "no-store" } });
      }

      // ── Workers AI probe: which model answers, and exactly why not ────
      if (url.pathname === "/health" && url.searchParams.get("ai") === "probe") {
        const secret = url.searchParams.get("deep");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const asked = url.searchParams.get("models");
        const models = asked
          ? asked.split(",").map((m) => m.trim()).filter(Boolean)
          : [
              "@cf/meta/llama-3.1-8b-instruct-fp8",
              "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              "@cf/meta/llama-3.2-3b-instruct",
              "@cf/qwen/qwen2.5-coder-32b-instruct",
              "@cf/openai/gpt-oss-120b",
            ];
        const out: Record<string, string> = {};
        for (const m of models) {
          try {
            const r: any = await env.AI.run(m as any, { messages: [{ role: "user", content: "ping" }], max_tokens: 8 } as any);
            const t = (r?.response ?? "").toString().trim();
            out[m] = t ? `✅ ${t.slice(0, 40)}` : `shape ${describe(r)}`;
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            // 4006 = valid model, free daily neurons spent · 5007/deprecated = gone
            out[m] = msg.includes("4006") || /neuron/i.test(msg) ? "⛔ quota" : "❌ " + msg.slice(0, 140);
          }
        }
        return Response.json({ probe: "ai", results: out }, { headers: { "cache-control": "no-store" } });
      }

      // NOTE: /health?tts=probe used to enumerate speech models here. Everything
      // audio was removed from this bot by owner instruction, so the probe is
      // gone with it — no point asking the account what it can sing.
      if (url.pathname === "/health" && url.searchParams.get("session") === "purge") {
        if (url.searchParams.get("deep") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
        const uid = Number(url.searchParams.get("uid") ?? 0);
        if (uid) {
          const stub: any = env.SESSION.get(env.SESSION.idFromName(`user:${uid}`));
          await stub.clear();
        }
        return json({ ok: true, purged: uid || "none" });
      }
      if (url.pathname === "/health" && url.searchParams.get("cron") === "1") {
        return json({ scheduler: await cronHeartbeat(env) });
      }
      if (url.pathname === "/health") {
        const deep = url.searchParams.get("deep");
        if (deep) {
          // deep probes cost AI neurons, so they require the operator secret
          if (deep !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
          return json(await deepHealth(env));
        }
        return json({ ok: true, ms: Date.now() - started, version: "1.0.0", bindings: bindingsReport(env) });
      }
      if (url.pathname === "/") {
        return new Response(landing(env), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      // Compatibility shim, deliberately not a page: the bot's default chat
      // menu button still opens /app on every client, and Telegram accepts
      // setChatMenuButton for that scope without actually changing it, so the
      // address cannot be un-shipped from here. It redirects to the landing
      // page — no web app, no Telegram SDK, no state — and can be deleted the
      // day the button is moved in BotFather.
      if (url.pathname === "/app") {
        return Response.redirect(url.origin + "/", 302);
      }
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error("fatal", e?.stack ?? e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },

  // ── cron: snapshots, boards, digests, hub sweeps, security ────────────
  async scheduled(event: ScheduledController, env: Env, ctx: Ctx) {
    ctx.waitUntil(runCron(event, env, ctx));
  },

  // ── queue consumer: heavy jobs ────────────────────────────────────────
  async queue(batch: MessageBatch<Job>, env: Env, ctx: Ctx) {
    await consumeQueue(batch, env, ctx);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE HANDLING
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Progress guard.
 *
 * A flow that shows "در حال جست‌وجو…" and then returns without replacing it
 * leaves the user staring at a spinner forever — the single most common
 * complaint about the bot. Every handler now reports whether it reached a
 * conclusion; if it did not, the caller replaces the loader with a real answer
 * and a way forward instead of silence.
 */
interface ProgressGuard {
  chatId: number;
  msgId?: number;
  loading: boolean;
  settled: boolean;
  lastLoader?: string;
  /** when this update started, so ai calls can share one deadline */
  startedAt?: number;
  /** how long this request may take. A webhook gets 22 s; a queued job gets
      minutes, because it is not racing the platform's reply window. */
  budgetMs?: number;
}

/**
 * How long an update may take end to end.
 *
 * 22s, not 30s: the platform's guarantee is "about thirty seconds after the
 * response", and the handler still has to send its answer after the model has
 * finished. Anything that runs long must give up and say so — a message that
 * arrives is worth more than a perfect one that never does.
 */
const UPDATE_BUDGET_MS = 22_000;

async function handleUpdate(update: Update, env: Env, ctx: Ctx) {
  const tg = new Telegram(env);
  const store = new Store(env);
  const ai = new AiBrain(env);
  const card = new RepoCard(env, store);

  const guard: ProgressGuard = { chatId: 0, loading: false, settled: true, startedAt: Date.now() };
  try {
    if (update.callback_query) {
      guard.chatId = update.callback_query.from.id;
      guard.msgId = update.callback_query.message?.message_id;
      return await routeCallback(update.callback_query, env, ctx, tg, store, ai, card, guard);
    }
    if (update.inline_query) return await routeInline(update.inline_query, env, ctx, tg, store, ai);
    if (update.message) {
      guard.chatId = update.message.chat.id;
      return await routeMessage(update.message, env, ctx, tg, store, ai, card, guard);
    }
  } finally {
    if (guard.loading && !guard.settled && guard.chatId) {
      console.error("stuck-flow", guard.lastLoader ?? "?");
      /* Say the most useful true thing. Three cases, in order of likelihood:
         the model was slow (the platform's window closed first — the cause of
         every "thinking…" that never ends), the quota is spent, or genuinely
         nothing answered. */
      const aiOff = await aiHalted(env);
      const ai = new AiBrain(env);
      const text = aiOff
        ? "⚠️ این بخش به هوش مصنوعی نیاز دارد و سهمیه‌اش امروز تمام شده.\n" +
          "تا برگشتنش می‌توانی از کارت مخزن، داغ‌ترین‌ها، کاوش عمیق، ابزارها و جست‌وجوی واژگانی استفاده کنی."
        : ai.failure === "timeout"
          ? "⏱ مدل در این نوبت کند بود و جواب در وقت مقرر نرسید — خراب نیست.\n" +
            "• یک بار دیگر بزن (اغلب بار دوم سریع است)\n" +
            "• یا کوتاه‌تر بپرس"
          : "⚠️ این بخش پاسخ نداد. یک بار دیگر بزن؛ اگر تکرار شد از منوی اصلی ادامه بده.";
      // a stuck flow gets two exits: home, or the deep-scout section
      const keyboard = { inline_keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "m:home" }, { text: "🛰 کاوش عمیق", callback_data: "s:home" }]] };
      try {
        if (guard.msgId) await tg.editMessageText(guard.chatId, guard.msgId, text, { parse_mode: "HTML", reply_markup: keyboard as any });
        else await tg.sendMessage(guard.chatId, text, { parse_mode: "HTML", reply_markup: keyboard as any });
      } catch (e: any) {
        console.error("lens-swallowed", String(e?.message ?? e));
      }
    }
  }
}

/**
 * Which features may be answered later.
 *
 * These are the ones whose model work routinely exceeds one platform reply
 * window: a repo analysis makes two calls plus GitHub reads (measured: 39.7 s
 * end to end on a cold repo), code review and workflow synthesis are comparable.
 * Anything that fits in seconds stays synchronous, because a synchronous answer
 * is a better one.
 */
export const DEFERRED_FEATURES = new Set(["repo", "code", "review", "workflow", "mission"]);

/**
 * Hand a slow feature to the queue and tell the user what will happen.
 *
 * Returns false when there is no queue bound (a self-hosted copy without
 * Cloudflare Queues), so the caller can fall back to doing the work inline —
 * slower is better than unavailable.
 */
export async function deferFeature(
  h: H,
  feature: "repo" | "code" | "review" | "workflow" | "ask" | "mission",
  arg: string,
  note: string,
): Promise<boolean> {
  const env = h.env;
  if (!env.JOBS) return false;
  const card = await h.tg.sendMessage(
    h.chatId,
    note,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "◀️ منوی اصلی", callback_data: "m:home" }]] } } as any,
  ).catch(() => null);
  const messageId = Number((card as any)?.result?.message_id ?? 0) || undefined;
  await env.JOBS.send({
    type: "ai.defer", feature, arg, chat_id: h.chatId, message_id: messageId,
    user_id: h.u.id, trace: `df_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  }).catch((e: any) => console.error("defer-enqueue-failed", String(e?.message ?? e)));
  return true;
}

/**
 * Run a deferred feature inside a queued job.
 *
 * The feature names are deliberately the *same* ones the buttons use, so a slow
 * request and a fast one take exactly one code path and cannot drift apart.
 */
export async function runDeferredFeature(feature: string, h: H, arg: string): Promise<void> {
  switch (feature) {
    case "repo": return assistant.dossier(h, normRepo(arg));
    case "code": return assistant.code(h, arg);
    case "review": return assistant.review(h, arg);
    case "workflow": return assistant.workflow(h, arg);
    case "ask": return assistant.ask(h, arg);
    case "mission": return hubOS.compileMission(h, arg);
    default: return h.reply(`⚠️ صف نمی‌داند «${feature}» یعنی چه.`);
  }
}

/**
 * GitHub account linking.
 *
 * Two paths, so this can never dead-end in a 404 page again:
 *  • OAuth — used when GITHUB_OAUTH_CLIENT_ID/SECRET are configured. We sign a
 *    state value, send the user to GitHub, and finish at /oauth/gh/callback.
 *  • Personal access token — always available. The user pastes a token (a
 *    fine-grained one with public read access is enough), we verify it against
 *    /user, encrypt it with AES-GCM and store only the ciphertext.
 */
async function githubLink(h: H) {
  const fa = h.loc === "fa";
  const oauthReady = !!(h.env as any).GITHUB_OAUTH_CLIENT_ID && !!(h.env as any).GITHUB_OAUTH_CLIENT_SECRET;
  const rows: any[][] = [];
  if (oauthReady) {
    const state = await signState(h.env, h.u.id);
    const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent((h.env as any).GITHUB_OAUTH_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(`${h.env.WORKER_URL}/oauth/gh/callback`)}` +
      `&scope=${encodeURIComponent("read:user public_repo")}&state=${encodeURIComponent(state)}`;
    rows.push([{ text: "🐙 " + (fa ? "اتصال با GitHub (OAuth)" : "Connect with GitHub (OAuth)"), url }]);
  }
  rows.push([{ text: "🔑 " + (fa ? "اتصال با توکن شخصی (همیشه کار می‌کند)" : "Connect with a personal token (always works)"), cb: "me:token" }]);
  rows.push([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]);
  return h.reply(
    `🐙 <b>${fa ? "اتصال حساب گیت‌هاب" : "Connect your GitHub account"}</b>\n\n` +
      (fa
        ? "با اتصال حساب، مخزن‌های خصوصی‌ات را هم می‌بینی، سقف درخواست از ۶۰ به ۵٬۰۰۰ در ساعت می‌رسد و پروفایل/اشتراک‌ها به حساب خودت گره می‌خورد.\n\n" +
          (oauthReady
            ? "روش سریع: دکمه‌ی OAuth. روش مطمئن (بدون تنظیمات): توکن شخصی."
            : "روش OAuth تنظیم نشده، پس از توکن شخصی استفاده کن: در گیت‌هاب برو به Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token، فقط دسترسی «Public repositories (read-only)» را بده، بساز و توکن را همین‌جا بفرست.\n\nصبر کن تا اتصال تمام شود — توکن فقط رمزنگاری‌شده ذخیره می‌شود و هر وقت خواستی با «جدا کردن» پاک می‌شود.")
        : "Linking raises your API limit from 60 to 5000 requests/hour and unlocks private repos.\n\nSend a fine-grained token with public read access, or use the OAuth button when configured."),
    kb(...rows),
    !!h.cbId,
  );
}

/**
 * The account screen behind the 🐙 button and /connect.
 *
 * Linked users get the real dashboard; everyone else gets the two-step
 * onboarding with a button that opens GitHub's token page pre-filled. The token
 * prompt is written for someone who has never made a token before.
 */
async function githubOverview(h: H) {
  const fa = h.loc === "fa";
  const u = await h.store.user(h.u.id);
  if ((u as any)?.github_login) return accountFeature.home(h);
  const aiState = await aiEngineState(h.env);
  return h.reply(githubSetupCard(fa, aiState), githubSetupKb(fa), !!h.cbId);
}

/** Where the user pastes the token: we arm the wizard and explain the steps. */
async function githubTokenPrompt(h: H) {
  const fa = h.loc === "fa";
  await h.session.set("me:token", Date.now());   // stamped: an old prompt must not eat a later message
  const createUrl =
    "https://github.com/settings/tokens/new?scopes=repo,read:user,user:email,read:org&description=" +
    encodeURIComponent("GitHub Lens Ultra");
  return h.reply(
    `🔑 <b>${fa ? "توکن گیت‌هاب را همین‌جا بفرست" : "Paste your GitHub token here"}</b>\n\n` +
      (fa
        ? `اگر هنوز نساخته‌ای:\n` +
          `۱. دکمهٔ پایین «ساخت توکن در گیت‌هاب» را بزن — دسترسی‌ها از قبل تیک خورده‌اند\n` +
          `۲. پایین صفحه <b>Generate token</b> را بزن\n` +
          `۳. توکن ساخته‌شده (شبیه <code>ghp_…</code>) را کپی کن و همین‌جا بفرست\n\n` +
          `<b>امنیت:</b> رمزنگاری‌شده ذخیره می‌شود، در چت نمایش داده نمی‌شود، با «جدا کردن» پاک می‌شود.\n` +
          `<i>پیام حاوی توکن را بعد از ارسال، از تلگرام پاک کن.</i>`
        : `Tap “Create the token” (scopes pre-ticked), press Generate, paste it here. Stored encrypted; removable any time.`),
    kb(
      [{ text: "🔑 " + (fa ? "ساخت توکن در گیت‌هاب" : "Create the token"), url: createUrl }],
      [{ text: "❌ " + (fa ? "لغو" : "Cancel"), cb: "me:home" }],
    ),
    !!h.cbId,
  );
}

async function githubUnlink(h: H) {
  const fa = h.loc === "fa";
  await h.env.DB.prepare(`UPDATE users SET github_login=NULL, github_token_enc=NULL, github_token_at=NULL WHERE id=?`)
    .bind(h.u.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  return h.reply(fa ? "🔓 حساب گیت‌هاب جدا شد و توکن پاک شد." : "🔓 GitHub unlinked, token deleted.",
    kb([[{ text: "🐙 " + (fa ? "اتصال حساب" : "Connect account"), cb: "me:link" }]]), !!h.cbId);
}

export async function buildH(
  m: { from?: User; chat: { id: number }; message_id?: number },
  env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard,
  opts: { cbId?: string; args?: string[]; text?: string; msg?: Message; guard?: ProgressGuard; editTarget?: number } = {},
): Promise<H> {
  const guard = opts.guard;
  const u = m.from ?? { id: 0, is_bot: false, first_name: "?" } as User;
  await store.upsertUser(u);
  const user = await store.user(u.id);
  const loc = (user?.locale as any) ?? env.DEFAULT_LOCALE ?? "fa";
  const chatId = m.chat.id;
  const msgId = m.message_id;

  const session = env.SESSION.get(env.SESSION.idFromName(`user:${u.id}`)) as any;

  // a linked account uses its own token: private repos work and the rate limit
  // (5000/h) belongs to the user instead of the deployment
  const userToken = user?.github_token_enc ? await decryptToken(env, user.github_token_enc) : null;
  const gh = new GithubRest(env, userToken ?? undefined);
  /* One clock for the whole request.
     The platform allows roughly half a minute per update and every model call in
     this handler draws from that one allowance; a call that forgets its deadline
     runs on the default 20 s, two of them can never both land, and the user stares
     at a spinner that never resolves. The clock therefore lives in the brain
     (`hardDeadline`) rather than in a wrapper around two method names, so every
     path — chat, json, analyzeRepo, parallel, translate — inherits it. A queued
     job sets a much larger allowance, because the queue's window is minutes, not
     seconds. */
  const allowance = guard?.budgetMs ?? UPDATE_BUDGET_MS;
  const left = () => Math.max(2_000, (guard?.startedAt ?? Date.now()) + allowance - Date.now());
  ai.hardDeadline = Date.now() + allowance;

  const h: H = {
    env, store, tg, ai, card, u, user, loc, chatId, msgId,
    cbId: opts.cbId, args: opts.args ?? [], text: opts.text ?? "", msg: opts.msg,
    editTarget: opts.editTarget,
    userToken: userToken ?? undefined,
    session,
    gh: () => gh,
    budget: left,
    async reply(body, keyboard, edit = false) {
      if (guard) guard.settled = true;
      // a queued answer claims the card it was announced in, once
      if (!edit && h.editTarget) {
        const target = h.editTarget;
        h.editTarget = undefined;
        const res = await tg.editMessageText(chatId, target, body, { parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true });
        if ((res as any).ok !== false) return;
        // the card was deleted or is too old to edit → fall through to a send
      }
      if (edit && h.cbId && msgId) {
        const res = await tg.editMessageText(chatId, msgId, body, { parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true });
        if ((res as any).ok === false && /not modified/i.test((res as any).description ?? "")) return;
        if ((res as any).ok === false) {
          // message too old / identical → send new
          await tg.sendLong(chatId, body, { parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true });
        }
        return;
      }
      await tg.sendLong(chatId, body, { parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true });
    },
    async replyRich(html, keyboard, edit = false) {
      if (guard) guard.settled = true;
      const { editRich, sendRich } = await import("./tg/rich");
      const extras = { reply_markup: keyboard, disable_web_page_preview: true } as any;
      const rtl = loc === "fa" || loc === "ar";
      if (!edit && h.editTarget) {
        const target = h.editTarget;
        h.editTarget = undefined;
        const how = await editRich(tg, chatId, target, html, { extra: extras, rtl })
          .catch(async () => { await sendRich(tg, chatId, html, { extra: extras, rtl }); return "legacy" as const; });
        if (how) return;
      }
      if (edit && h.cbId && msgId) {
        const how = await editRich(tg, chatId, msgId, html, { extra: extras, rtl })
          .catch(async () => { await sendRich(tg, chatId, html, { extra: extras, rtl }); return "legacy" as const; });
        if (how === "legacy") return;
        return;
      }
      await sendRich(tg, chatId, html, { extra: extras, rtl });
    },
    async toast(text, alert = false) {
      if (guard) guard.settled = true;
      if (h.cbId) await tg.answerCallbackQuery(h.cbId, text.slice(0, 190), alert);
    },
    async loading(label) {
      const text = label ?? loadingText(loc);
      if (guard) { guard.loading = true; guard.settled = false; guard.lastLoader = text; guard.chatId = chatId; guard.msgId = guard.msgId ?? msgId; }
      if (h.cbId && msgId) {
        await tg.editMessageText(chatId, msgId, text, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      } else {
        await tg.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    },
  };
  return h;
}

// ── messages ───────────────────────────────────────────────────────────────
/**
 * A read-only view of the environment for `/selfcheck` probes.
 *
 * Reads pass straight through — a probe has to see the same data a user sees or
 * it audits nothing. Writes report success without touching the database, so a
 * synthetic run can walk every screen in the bot and leave no trace. The shape
 * matches D1's, because code that inspects `meta.changes` must not crash.
 */
function probeEnv(env: Env): Env {
  const real = env.DB as any;
  const stub = (sql: string, binds: any[]): any => ({
    bind: (...a: any[]) => stub(sql, a),
    run: async () => ({ success: true, meta: { changes: 0, duration: 0 } }),
    first: async (...a: any[]) => real.prepare(sql).bind(...(a.length ? a : binds)).first(),
    all: async (...a: any[]) => real.prepare(sql).bind(...(a.length ? a : binds)).all(),
    raw: async (...a: any[]) => real.prepare(sql).bind(...(a.length ? a : binds)).raw(),
  });
  return {
    ...env,
    DB: {
      prepare: (sql: string) => stub(sql, []),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    },
  } as unknown as Env;
}

async function routeMessage(msg: Message, env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard, guard?: ProgressGuard) {
  const opts = (extra: { cbId?: string; args?: string[]; text?: string } = {}) => ({ ...extra, msg, guard });
  const text = (msg.text ?? msg.caption ?? "").trim();

  // voice notes → transcription pipeline
  if (msg.voice?.file_id) {
    const h = await buildH(msg, env, ctx, tg, store, ai, card, opts({ }));
    return assistant.voice(h, msg.voice.file_id);
  }

  // documents → the file pipeline.
  //
  // Behaviour depends on where the user is standing:
  //   • inside the hub's file screen (or any hub mode) → full dissection:
  //     detect, extract, index entities, embed, report facts
  //   • anywhere else → the package inspector, which is what a stray
  //     Dockerfile or package-lock.json in a normal conversation means
  // Routing on the session mode rather than on the file type is deliberate:
  // the same JSON is a package manifest or a dataset depending on intent.
  if (msg.document?.file_name) {
    const hDoc = await buildH(msg, env, ctx, tg, store, ai, card, opts({}));
    const m = await readMode(hDoc.session);
    const hubish = m?.kind === "hos:file" || m?.kind?.startsWith("hos:") || /^(hos|hub):/.test(String(m?.data?.from ?? ""));
    if (hubish) {
      await clearMode(hDoc.session);
      return hubOS.ingestFile(hDoc, msg.document);
    }
    return tools.pkg(hDoc);
  }

  if (!text) return;

  // slash commands
  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.replace(/@[\w_]+$/, "").toLowerCase();
    const arg = rest.join(" ").trim();
    const h = await buildH(msg, env, ctx, tg, store, ai, card, opts({ args: rest, text: arg }));
    return routeCommand(cmd, arg, h, env, ctx);
  }

  // GitHub token paste (armed by /login or the "personal token" button)
  if (/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(text) || /^[A-Za-z0-9_]{36,}$/.test(text)) {
    const h0 = await buildH(msg, env, ctx, tg, store, ai, card, opts({ text }));
    const armed = await h0.session?.get("me:token").catch(() => null);
    // a prompt older than half an hour is not waiting for this message
    const armedFresh = !!armed && (armed === true || Date.now() - Number(armed) < 30 * 60_000);
    if (armedFresh) {
      if (/^(gh[pousr]_|github_pat_)/.test(text) || text.length >= 36) return completeLink(h0, text.trim());
    }
  }

  // session-driven inputs (wizard steps) take priority over heuristics
  const h = await buildH(msg, env, ctx, tg, store, ai, card, opts({ text }));
  const sessionCtx = await inputContext(h);
  if (sessionCtx) return sessionCtx(text);

  // heuristics: repo link/name → card ; question → assistant ; else search
  // (parseRepoRef accepts /tree/main, .git, ssh, ?tab=… — all the shapes the
  //  GitHub app and the share sheet actually produce)
  if (/github\.com|^[\w.-]+\/[\w.-]+$/.test(text) && !/\s/.test(text.trim())) {
    const ref = parseRepoRef(text);
    if (ref) return scout.open(h, ref, 0);
  }
  /* The persistent bottom keyboard sends its label as plain text and nothing
     used to handle it, so tapping «🏠 منوی اصلی» ran a GitHub search for that
     very string. Map the labels back to their actions. */
  const kbAction = replyKeyAction(text, h.loc);
  if (kbAction) return kbAction(h);

  /* A pasted API key or provider URL is not a search query either: handing it
     to GitHub search is how a user ends up staring at "nothing found" while
     their key is right there in the message. */
  if (looksLikeKey(text)) return keyLooksLikeKey(h, text);

  /* A greeting is not a search query. Handing "سلام" to GitHub search answers
     «چیزی پیدا نشد», which reads as a broken bot. Greet back instead, with the
     menu and an honest word about the AI engine when it is off. */
  if (isGreeting(text)) return greetBack(h);
  if (text.length < 60 && /^(find|search|جست|پیدا|دنبال|چی|چه|recommend|پیشنهاد)/i.test(text)) {
    return search.run(h, text);
  }
  /* Everything typed outside a section searches for projects. The AI chat lives
     in its own section (the 🤖 button) — a question typed here gets real search
     results plus a one-tap «ask the AI» button, instead of the whole bot behaving
     like a chat window. */
  return search.run(h, text);
}

/** Text that smells like an API key or a provider base URL, not a query. */
function looksLikeKey(text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return false;
  if (/^(sk-|sk_|gsk_|xai-|AIza|hf_|pplx-|cfut_|gh[pousr]_|github_pat_)/.test(t)) return true;
  if (/^https?:\/\/\S+\.\S{2,}(\/\S*)?$/i.test(t) && /\/v1\b|\/api\b|openai|completions/i.test(t)) return true;
  return /^[A-Za-z0-9_\-]{40,}$/.test(t);
}

/**
 * Someone dropped a key (or a provider URL) into the chat.
 * Offer exactly two things: store it, or search it anyway.
 */
async function keyLooksLikeKey(h: H, text: string): Promise<void> {
  const fa = h.loc === "fa";
  const peek = text.replace(/\s+/g, " ").slice(0, 24) + "…";
  await h.reply(
    `🔑 <b>${fa ? "به‌نظر یک کلید یا آدرس سرور است" : "That looks like a key or a server URL"}</b>\n\n` +
      `<i>${tgEscape(peek)}</i>\n\n` +
      (fa
        ? "اگر می‌خواهی موتور هوش مصنوعی ربات از آن استفاده کند، بزن «ذخیره در استخر» و همان‌جا تست می‌شود.\nاگر منظور دیگری داشتی، جست‌وجو کن."
        : "Tap “Store it” and I will test it right away, or search it instead."),
    kb(
      [{ text: "🔑 " + (fa ? "ذخیره در استخر کلیدها" : "Store it for the AI pool"), cb: "keys:home" }],
      [{ text: "🔎 " + (fa ? "نه، این را جست‌وجو کن" : "No, search it"), cb: `n:q:${encodeURIComponent(text).replace(/%/g, "_").slice(0, 60)}` }],
      [{ text: "🏠 " + (fa ? "منوی اصلی" : "Main menu"), cb: "m:home" }],
    ),
    true,
  );
}

/**
 * Small-talk detector — Persian and English, tolerant of punctuation and the
 * different ways people type a greeting. Deliberately tight: 「سلامت باشی» is a
 * greeting, 「سلامت سنج» is a search.
 */
const GREETINGS = [
  "سلام", "درود", "سلان", "سلم", "های", "هی", "چطوری", "چطورید", "خوبی", "خوبید",
  "حالت چطوره", "حالتون چطوره", "صبح بخیر", "شب بخیر", "روز بخیر", "وقت بخیر",
  "ممنون", "مرسی", "تشکر", "دستت درد نکنه", "خسته نباشی",
  "hi", "hey", "hello", "yo", "sup", "good morning", "good evening", "how are you",
  "thanks", "thank you", "thx", "test", "تست",
];
/**
 * Bottom-keyboard labels → actions.
 *
 * Telegram sends the caption as a normal message, so every label needs a route
 * back into the router. Matching ignores emoji, spaces and ZWNJ so it keeps
 * working when a label is renamed.
 */
const REPLY_LABELS: { keys: string[]; action: string }[] = [
  { keys: ["منوی اصلی", "منو", "main menu", "menu", "خانه"], action: "home" },
  { keys: ["جستجوی هوشمند", "جستجو", "search", "ai search"], action: "search" },
  { keys: ["داغ‌ترین‌ها", "داغترین", "trending", "hot"], action: "trending" },
  { keys: ["مرور پروژه‌ها", "مرور", "browse", "repos"], action: "browse" },
  { keys: ["پروفایل", "حساب من", "profile", "account"], action: "profile" },
  { keys: ["داشبورد", "dashboard"], action: "dashboard" },
  { keys: ["حساب گیت‌هاب", "github account", "حساب گیت هاب", "اتصال گیت‌هاب", "github"], action: "github" },
  { keys: ["اهدای کلید", "اهدا کلید", "donate key", "donate", "کلید هوش مصنوعی"], action: "keys" },
  { keys: ["کاوش عمیق", "scout"], action: "scout" },
  { keys: ["راهنما", "help"], action: "help" },
];

export function replyKeyAction(text: string, loc: string):
  | ((h: H) => Promise<void> | void)
  | null {
  const norm = (x: string) =>
    x.replace(/[\u200c\u200f\u200e]/g, "").replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const t = norm(text);
  if (!t || t.length > 24) return null;
  const hit = REPLY_LABELS.find((r) => r.keys.some((k) => norm(k) === t));
  if (!hit) return null;
  switch (hit.action) {
    case "home": return (h) => settings.home(h);
    case "search": return (h) => h.reply((loc === "fa" ? "🔎 چه چیزی را پیدا کنم؟ بنویس:" : "🔎 What should I find? Type it:") + "", kb([[{ text: "🎯 " + (loc === "fa" ? "جست‌وجوی پیشرفته" : "Advanced search"), cb: "n:search" }], []]), !!h.cbId);
    case "trending": return (h) => trendingMenuOrBoard(h, "");
    case "browse": return (h) => browse.menu(h);
    case "profile": return (h) => profile.home(h);
    case "github": return (h) => githubOverview(h);
    case "dashboard": return (h) => accountFeature.home(h);
    case "keys": return (h) => keysFeature.home(h);
    case "scout": return (h) => scout.home(h);
    case "help": return (h) => settings.help(h);
    default: return null;
  }
}

function isGreeting(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/[!؟?.,،؛;:()\u200c«»"'']/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 30) return false;
  return GREETINGS.some((g) => t === g || t.startsWith(g + " ") || t.startsWith(g + "‌"));
}

async function greetBack(h: H) {
  const fa = h.loc === "fa";
  const name = h.u.first_name || (fa ? "دوست من" : "friend");
  const ai = await import("./ai/brain");
  const halted = await ai.aiHalted(h.env).catch(() => false);
  const pool = await h.env.DB.prepare("SELECT COUNT(*) AS n FROM ai_keys WHERE status IN ('ok','new')")
    .first<{ n: number }>().catch(() => null);
  const engine = Number(pool?.n ?? 0) > 0
    ? (fa ? "🤝 موتور AI از استخر کلیدهای اهدایی کار می‌کند" : "🤝 AI runs on the donated-key pool")
    : halted
      ? (fa ? "⚠️ موتور AI امروز سهمیه‌اش تمام شده — با <code>/keys</code> یک کلید اهدا کن یا فردا دوباره امتحان کن" : "⚠️ the free AI quota is spent until tomorrow — donate a key with /keys")
      : (fa ? "✅ همه‌چیز آماده است" : "✅ all set");
  const { kb } = await import("./tg/keyboards");
  return h.reply(
    (fa
      ? `👋 <b>${tgEscape(name)} عزیز، خوش آمدی!</b>\n\nمن لنز اولترا هستم؛ برای پیدا کردن، ترجمه و دانلود پروژه‌های گیت‌هاب ساخته شده‌ام و کاملاً روی کلودفلر اجرا می‌شوم.\n\n`
      : `👋 <b>Hi ${tgEscape(name)}!</b>\n\nI'm Lens Ultra — search, translate and download GitHub projects, all on Cloudflare.\n\n`) +
      engine +
      (fa ? "\n\n<b>مثال:</b> «یک کتابخانه سبک برای صف در Go» یا <code>vuejs/core</code>" : "\n\n<b>Try:</b> “a lightweight queue library in Go” or <code>vuejs/core</code>"),
    kb(
      [{ text: "🛰 " + (fa ? "کاوش عمیق" : "Deep scout"), cb: "s:home" }],
      [{ text: "🏠 " + (fa ? "منوی اصلی" : "Main menu"), cb: "m:home" }],
      
    ),
    !!h.cbId,
  );
}

/** Detects whether the user is mid-wizard, and returns the handler for their next message. */
async function inputContext(h: H): Promise<((text: string) => Promise<void>) | null> {
  const s = h.session;
  const pendingKeys = await s.get("keys:pending");
  if (pendingKeys) {
    let state: any = {};
    try { state = typeof pendingKeys === "string" ? JSON.parse(pendingKeys) : pendingKeys; } catch { state = {}; }
    return async (t: string) => {
      const fa = h.loc === "fa";
      const text = t.trim();
      if (state.stage === "url") {
        if (!/^https?:\/\//i.test(text)) return h.reply(fa ? "❌ آدرس باید با http یا https شروع شود." : "❌ the URL must start with http(s)");
        const { KeyPool } = await import("./ai/keypool");
        const clean = KeyPool.normalizeBase(text);
        const trimmed = clean !== text.trim().replace(/\/+$/, "");
        state.baseUrl = clean;
        state.stage = "key";
        await s.set("keys:pending", JSON.stringify(state));
        return h.reply(
          (trimmed ? (fa ? `✂️ آدرس را به فرم پایه کوتاه کردم: <code>${clean}</code>\n\n` : `✂️ trimmed to the base URL: <code>${clean}</code>\n\n`) : "") +
            (fa ? `🔑 حالا کلید را بفرست (برای سرور محلی بدون کلید، «-» بفرست).` : "🔑 now send the key (or “-” for a keyless local server)") +
            (fa ? `\n\n<i>کلید فقط بعد از تست موفق ذخیره می‌شود.</i>` : ""),
          kb([[{ text: "◀️", cb: "keys:add" }]]),
        );
      }
      if (state.stage === "model") {
        // a custom/local OpenAI-compatible server has no "auto": without a real
        // model name every later call answers 404 and the key looks broken
        const needsModel = state.provider === "custom" || state.provider === "local";
        if (needsModel && text === "-")
          return h.reply(
            (fa ? "❗️ سرور سفارشی مدل «خودکار» ندارد — نام دقیق مدل را بفرست." : "❗️ a custom server has no auto model — send the exact name.") +
              (state.models?.length ? `\n\n<i>${fa ? "فهرست دیده‌شده" : "seen"}: ${state.models.slice(0, 10).map((m: string) => `<code>${m}</code>`).join(" · ")}</i>` : ""),
            kb([[{ text: "◀️", cb: "keys:add" }]]),
          );
        state.model = text === "-" ? "" : text;
        await keysFeature.accept(h, state, state.savedKey ?? "");
        return;
      }
      // the key itself
      const test = await (async () => {
        const { KeyPool } = await import("./ai/keypool");
        return KeyPool.test(state.baseUrl ?? "", text === "-" ? "" : text, state.model || "");
      })();
      const modelProblem = !test.ok && (
        test.errorKind === "model"
        || (/404|400|unsupported|unknown|does not exist/i.test(test.error ?? "")
            && !/(401|402|403|429|quota|credit|invalid api key|unauthorized)/i.test(test.error ?? ""))
      );
      if (!test.ok && (modelProblem || state.model || test.errorKind === "model")) {
        // the key itself may be fine — the model name is what the server refused
        state.savedKey = text;
        state.stage = "model";
        state.lastError = test.error ?? "";
        state.models = (test.models ?? state.models ?? []).slice(0, 40);
        await s.set("keys:pending", JSON.stringify(state));
        return h.reply(
          (fa
            ? `⚠️ با مدل <code>${tgEscape(String(state.model || "(خودکار)"))}</code> جواب نداد:\n<code>${tgEscape(String(test.error ?? "").slice(0, 200))}</code>\n\n` +
              `اگر کلید سالم است، نام مدل را درست بفرست.`
            : `⚠️ failed with model ${tgEscape(String(state.model || "auto"))}: ${tgEscape(String(test.error ?? "").slice(0, 160))}\nSend another model name.`) +
            (state.models.length
              ? `\n\n<i>${fa ? "مدل‌های دیده‌شده" : "seen"}: ${state.models.slice(0, 10).map((m: string) => `<code>${tgEscape(m)}</code>`).join(" · ")}</i>`
              : ""),
          kb(
            state.models.slice(0, 6).map((m: string) => ({ text: "🧠 " + m.slice(0, 22), cb: `keys:m:${encodeURIComponent(m).slice(0, 20)}` })),
          ),
        );
      }
      if (!test.ok && test.errorKind === "rate") {
        // 429 means "busy", not "wrong": keep the key as a warm backup instead
        // of telling someone their working key is broken
        state.model = state.model || (test.models?.[0] ?? "");
        return keysFeature.accept(h, state, text, "rate");
      }
      if (!test.ok) {
        // the wizard stays open: the next message is another key (or a new URL),
        // never a search query — that is how a working key used to get "lost"
        const kind = test.errorKind === "url" ? "url" : "key";
        state.stage = kind;
        state.lastError = test.error ?? "";
        state.models = (test.models ?? state.models ?? []).slice(0, 40);
        await s.set("keys:pending", JSON.stringify(state));
        const { keys: keysFeature } = await import("./features/keys");
        return h.reply(
          (fa ? `❌ <b>کلید ذخیره نشد</b>\n\n` : `❌ <b>Key not stored</b>\n\n`) +
            `${keysFeature.explain(fa, test)}\n\n` +
            (fa ? `<b>پاسخ سرور:</b>\n<code>${tgEscape(String(test.error ?? "unknown").slice(0, 220))}</code>\n\n` : `<code>${tgEscape(String(test.error ?? "unknown").slice(0, 220))}</code>\n\n`) +
            (kind === "url"
              ? (fa ? `✏️ آدرس پایه را دوباره بفرست (فقط تا <code>/v1</code>).` : `✏️ send the base URL again (stop at /v1).`)
              : (fa ? `✏️ کلید را دوباره بفرست (همین‌جا می‌مانیم؛ چیزی ذخیره نشد).` : `✏️ send the key again — nothing was stored.`)) +
            (fa ? `\n\n<i>برای انصراف: /cancel</i>` : `\n\n<i>/cancel to stop</i>`),
          kb(
            [{ text: "🔄 " + (fa ? "آدرس را عوض کن" : "Change URL"), cb: `keys:p:${state.provider}` }],
            [{ text: "❌ " + (fa ? "انصراف" : "Cancel"), cb: "keys:home" }],
          ),
        );
      }
      if (test.ok && (state.provider === "custom" || state.provider === "local") && !test.model) {
        // ask for the model before storing, exactly as the provider prompt said
        state.savedKey = text;
        state.stage = "model";
        state.models = (test.models ?? []).slice(0, 40);
        await s.set("keys:pending", JSON.stringify(state));
        return h.reply(
          (fa
            ? "✅ اتصال برقرار شد. حالا <b>نام مدل</b> را بفرست (مثلاً <code>openai</code> یا <code>llama-3.3-70b</code>)."
            : "✅ reachable. Now send the <b>model name</b>.") +
            (state.models.length
              ? `\n\n<i>${fa ? "مدل‌های دیده‌شده" : "seen models"}: ${state.models.slice(0, 12).map((m: string) => `<code>${m}</code>`).join(" · ")}</i>`
              : ""),
          kb([[{ text: "◀️", cb: "keys:add" }]]),
        );
      }
      await keysFeature.accept(h, state, text);
    };
  }
  /* ------------------------------------------------------------------ *
   * The section the user is standing in decides what their text means.
   * One mode, one handler — never a leftover flag from another screen.  *
   * ------------------------------------------------------------------ */
  const mode = await readMode(s);
  if (mode) {
    await touchMode(s, mode);   // being used keeps a section alive
    const sec = mode.data?.section ? String(mode.data.section) : "";
    switch (mode.kind) {
      case "repochat": {
        const full = String(mode.data?.full ?? "");
        // no target yet → the message the user types *is* the repository
        if (!full) return async (t: string) => {
          const ref = parseRepoRef(t);
          if (!ref) return assistant.translatePick(h, t);   // search it, one tap away
          await setMode(h.session, "repochat", { full: ref });
          return assistant.repoChat(h, ref);
        };
        return (t) => assistant.repoChat(h, full, t);
      }
      case "ask": return (t) => assistant.ask(h, t);
      case "tr": return (t) => assistant.translateReadme(h, t.trim());
      case "wf": return async (t: string) => {
        if (await deferFeature(h, "workflow", t, "🧩 ورک‌فلو در صف ساخته می‌شود…")) return;
        return assistant.workflow(h, t);
      };
      case "appgen": return async (t: string) => { await clearMode(h.session); return appGen.build(h, t); };
      case "hub_gitlab": return async (t: string) => { await clearMode(h.session); return multiHub.gitlabScout(h, t); };
      case "hub_post": return async (t: string) => { await clearMode(h.session); return multiHub.buildChannelPost(h, t); };
      case "hub_py": return async (t: string) => { await clearMode(h.session); return multiHub.runPyCode(h, t); };
      /* Mission planning, code synthesis, review and workflow building each
         exceed one reply window, and they are reached by *typing* — the same trap
         as the button, one screen further in. Queued from here too, so the answer
         arrives instead of the sentence never being finished. */
      case "hos:mission": return async (t: string) => {
        const mission = t.trim().slice(0, 1200);
        if (await deferFeature(h, "mission", mission, `🧪 <b>مأموریت در صف ترجمه است</b>\n\n<blockquote>${tgEscape(mission.slice(0, 160))}</blockquote>\nنقشهٔ اجرا تا چند ثانیه دیگر همین‌جا می‌آید.`)) return;
        return hubOS.compileMission(h, mission);
      };
      case "hos:conn:add": return async (t: string) => hubOS.connectorAdd(h, String(mode.data?.kind ?? ""), t.trim());
      // the mission wizard's second question: which repositories is this about
      case "hos:wfrepo": return async (t: string) => hubOS.setRepos(h, String(mode.data?.wfId ?? ""), t.trim());
      case "hos:search": return async (t: string) => hubOS.search(h, t);
      case "hos:edit": return async (t: string) => hubOS.applyEdit(h, String(mode.data?.id ?? ""), t);
      case "hos:media": return async (t: string) => hubOS.buildMedia(h, t);
      case "hos:deploy": return async (t: string) => hubOS.deployRun(h, t);
      case "hos:guide": return async () => hubOS.guide(h);
      case "arch": return async (t: string) => { await clearMode(h.session); return archExplainer.explain(h, t); };
      case "code": return async (t: string) => {
        if (await deferFeature(h, "code", t, "🧠 کد در صف ساخته می‌شود…")) return;
        return assistant.code(h, t);
      };
      case "review": return async (t: string) => {
        if (await deferFeature(h, "review", t, "🔎 بازبینی در صف اجرا شد…")) return;
        return assistant.review(h, t);
      };
      case "sec:scan": return (t) => security.scan(h, t.trim());
      case "sec:secrets": return (t) => security.secrets(h, t.trim());
      case "adm:broadcast": return (t) => admin.broadcast(h, t);
      case "cmp": return (t) => scout.compare(h, String(mode.data?.a ?? ""), t.trim());
      case "dvu:cron": return (t) => devutils.cron(h, t.trim());
      case "dvu:regex": return (t) => devutils.runRegex(h, t.trim());
      case "dvu:cidr": return (t) => devutils.cidr(h, t.trim());
      case "dvu:jwt": return (t) => devutils.jwt(h, t.trim());
      case "dvu:b64": return (t) => devutils.b64(h, t);
      case "dvu:hash": return (t) => devutils.hash(h, t);
      case "dvu:time": return (t) => devutils.time(h, t.trim());
      case "dvu:json": return (t) => devutils.json(h, t);
      case "dvu:semver": return (t) => devutils.semver(h, t.trim());
      case "dvu:color": return (t) => devutils.color(h, t.trim());
      case "u:ip": return (t) => tools.intel(h, t.trim());
      case "u:asn": return (t) => tools.asn(h, t.trim());
      default: void sec; break;
    }
  }

  /* Waiting for a pasted GitHub token: hand the text to the link flow, never
     to search. (Armed by /login or the «توکن را گرفتم» button.) */
  const armedToken = await s.get("me:token").catch(() => null);
  if (armedToken && (armedToken === true || Date.now() - Number(armedToken) < 30 * 60_000)) {
    return (t) => completeLink(h, t.trim());
  }

  /* Old sessions carry one-shot flags ("wf", "code", …) written by the
     previous build. They are not read any more — that is exactly the bug
     the owner hit: a flag from yesterday answered today's question. */
  return null;
}

// ── commands ───────────────────────────────────────────────────────────────
async function routeCommand(cmd: string, arg: string, h: H, env: Env, ctx: Ctx) {
  if (cmd === "/keys" || cmd === "/api-keys") return keysFeature.home(h);
  if (cmd === "/connect" || cmd === "/link") return githubOverview(h);
  if (cmd === "/login") return githubTokenPrompt(h);
  if (cmd === "/logout") return githubUnlink(h);
  const fa = h.loc === "fa";
  await h.store.event(h.u.id, "command", cmd);

  switch (cmd) {
    case "/start": {
      // deep links: s_/d_/t_/c_ + owner/repo open the right screen
      if (arg === "k_keys") return keysFeature.home(h);
      if (arg === "hub" || arg === "cloud") return hubOS.home(h);
      if (arg.startsWith("repo_")) {
        const target = arg.slice(5).replace("_", "/");
        return repoCard(h, target);
      }
      const deep = arg.match(/^([sdtc])_(.+)$/);
      if (deep) {
        const full = normRepo(deep[2]);
        if (deep[1] === "s") return scout.open(h, full, 0);
        if (deep[1] === "d") return downloader(h).choose(h, full);
        if (deep[1] === "t") return assistant.translateReadme(h, full);
        if (deep[1] === "c") return assistant.dossier(h, full);
      }
      // referral?
      if (arg.startsWith("ref_")) {
        await h.env.DB.prepare(`UPDATE users SET referral_by=(SELECT id FROM users WHERE referral_code=?) WHERE id=? AND referral_by IS NULL`)
          .bind(arg.slice(4), h.u.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        const referrer = await h.env.DB.prepare(`SELECT id FROM users WHERE referral_code=?`).bind(arg.slice(4)).first<{ id: number }>().catch(() => null);
        if (referrer?.id) {
          await h.store.addXp(referrer.id, 50, "referral");
          await h.tg.sendMessage(referrer.id, `🎁 ${fa ? "یک دوست با لینک تو آمد! +۵۰ XP" : "A friend joined via your link! +50 XP"}`, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        }
      }
      // a command, not a page turn: send a fresh card (with the artwork)
      return settings.home(h, undefined, { force: true });
    }
    case "/reset": case "/cancel": case "/esc": {
      // any user can escape a half-finished wizard or a stale step: nothing the
      // bot asked for is more important than getting back to a known state
      await h.session.clear();
      return h.reply(
        fa
          ? "🧹 <b>حالت پاک شد</b>\nهر پرسش نیمه‌تمام (جست‌وجو، اهدای کلید، بازبینی، ورک‌فلو…) کنار گذاشته شد. از صفر شروع کن."
          : "🧹 <b>Reset</b> — any half-finished step was dropped. Start fresh.",
        kb([{ text: "🔎 " + (fa ? "جست‌وجوی پروژه" : "Project search"), cb: "n:search" }]),
        !!h.cbId,
      );
    }
    case "/help": case "/h": return settings.help(h);
    case "/about": return settings.about(h);
    case "/language": case "/lang": return settings.lang(h);

    case "/search": case "/s":
      if (!arg) return search.hub(h);
      if (!(await h.store.quota(h.u.id)).ok) return quotaBlocked(h);
      return search.run(h, arg);

    case "/trending": case "/t": return trendingMenuOrBoard(h, arg);
    case "/browse": case "/b": return arg ? browse.list(h, enc(arg)) : browse.menu(h);
    case "/gems": return discover.gems(h);
    case "/random": return discover.random(h);
    case "/map": return discover.map(h);
    case "/feed": return profile.feed(h);

    case "/scout": case "/deep":
      if (!arg) return scout.home(h);
      return scout.open(h, normRepo(arg), 0);
    case "/compare": case "/vs": {
      const [a2, b2] = arg.split(/\s+/).map(normRepo);
      if (!a2) return scout.compare(h, "");
      return scout.compare(h, a2, b2);
    }
    case "/changelog": {
      if (!arg) return h.reply(fa ? "قالب: /changelog owner/repo" : "usage: /changelog owner/repo");
      const full = normRepo(arg);
      const data = await fetchScoutRaw(h, full);
      if (!data) return h.reply(fa ? "❌ پیدا نشد." : "❌ not found");
      const text = await h.ai.changelog((data.r.commitHistory?.target?.history?.nodes ?? []).map((c: any) => ({ message: c.messageHeadline })), h.loc);
      return h.reply(`📰 <b>${full}</b>\n\n${text.slice(0, 3600)}`);
    }
    case "/chart": return discover.chart(h, normRepo(arg));
    case "/files":
      return arg.trim()
        ? discover.files(h, normRepo(arg))
        : h.reply(
            "📂 <b>فایل‌های مخزن</b>\nفرمت: <code>/files owner/repo</code> · مثلاً <code>/files facebook/react</code>\n" +
              "<i>درخت فایل‌ها را با پوشه‌بندی نشان می‌دهم؛ روی پوشه بزن تا داخلش را ببینی.</i>",
            kb([{ text: "🛰 کاوش مخزن", cb: "s:home" }, ]),
          );
    case "/card": case "/share":
      return arg.trim()
        ? discover.shareCard(h, normRepo(arg))
        : h.reply(
            "🖼 <b>کارت اشتراک‌گذاری مخزن</b>\nفرمت: <code>/card owner/repo</code> · مثلاً <code>/card vuejs/core</code>\n" +
              "<i>یک کارت تصویری آمادهٔ فرستادن در چت می‌سازم.</i>",
            kb([{ text: "🔎 جست‌وجو", cb: "s:home" }, ]),
          );
    case "/similar": return discover.similar(h, normRepo(arg));

    case "/dl": case "/download": {
      const parts = arg.split(/\s+/).filter(Boolean);
      const full = normRepo(parts[0] ?? "");
      if (!full) return h.reply(fa ? "قالب: <code>/dl owner/repo [@ref] [zip|tar]</code>" : "usage: /dl owner/repo [@ref] [zip|tar]");
      const ref = parts.find((p) => p.startsWith("@"))?.slice(1);
      const fmtp = (parts.find((p) => p === "tar" || p === "zip") as "tar" | "zip") ?? "zip";
      if (!ref) return downloader(h).choose(h, full);
      return downloader(h).run(h, full, fmtp, ref);
    }
    case "/pkgconvert": case "/pkg": {
      const [from, to] = arg.split(/\s+/);
      if (!from) return tools.pkg(h);
      return tools.convert(h, from, to ?? "rpm");
    }
    case "/tools": return tools.home(h);
    case "/ip": return arg ? tools.intel(h, arg) : tools.ipIntelPrompt(h);
    case "/asn": return arg ? tools.asn(h, arg) : tools.asnPrompt(h);
    case "/scan": return arg ? security.scan(h, normRepo(arg)) : security.home(h);
    case "/secrets": return arg ? security.secrets(h, normRepo(arg)) : security.askRepo(h, "secrets");
    case "/security": return arg ? security.scan(h, normRepo(arg)) : security.home(h);
    case "/cve": return security.recent(h);
    case "/dev": return devutils.home(h);
    case "/cron": return arg ? devutils.cron(h, arg) : devutils.cron(h);
    case "/cidr": return arg ? devutils.cidr(h, arg) : devutils.cidr(h);
    case "/hash": return arg ? devutils.hash(h, arg) : devutils.hash(h, "");
    case "/jwt": return arg ? devutils.jwt(h, arg) : devutils.jwt(h);

    case "/ai": case "/analyze": return arg ? assistant.dossier(h, normRepo(arg)) : assistant.home(h);
    case "/ask": return arg ? assistant.ask(h, arg) : assistant.home(h);
    case "/repochat": case "/chat": return assistant.repoChat(h, arg ? normRepo(arg) : "");
    case "/translate": case "/tr":
      if (!arg) return assistant.home(h);
      return assistant.translateReadme(h, normRepo(arg));
    case "/workflow": case "/wf": return assistant.workflow(h, arg || undefined);
    case "/code": return assistant.code(h, arg || undefined);
    case "/review": return assistant.review(h, arg || undefined);

    case "/profile": case "/me": return profile.home(h);
    case "/dashboard": case "/stats": return profile.dash(h);
    case "/favorites": case "/fav": case "/f": return profile.favs(h);
    case "/subs": case "/subscriptions": return profile.subs(h);
    case "/interests": return profile.interests(h);
    case "/leaderboard": case "/top": return profile.board(h);
    case "/refer": case "/invite": return profile.referral(h);
    case "/plan": return profile.plans(h);

    case "/netradar": case "/vpn": case "/proxy": return netRadar.home(h);
    case "/arch": case "/architecture": return archExplainer.explain(h, arg);
    case "/appgen": case "/createapp": return appGen.prompt(h);
    // "/hub" is the universal hub (events → workflows → approval → publish).
    // The older cloud/DevOps utilities keep their own name, so nothing is lost
    // and the command menu is not lying about where "hub" goes.
    case "/hub": return hubOS.home(h);
    case "/cloud": return multiHub.home(h);
    case "/gitlab": { await setMode(h.session, "hub_gitlab"); return multiHub.gitlabPrompt(h); }
    case "/postmaker": { await setMode(h.session, "hub_post"); return multiHub.postMakerPrompt(h); }
    case "/py": case "/python": { await setMode(h.session, "hub_py"); return multiHub.pySandboxPrompt(h); }
    case "/contribute": return contribute.home(h);
    case "/issues": return contribute.issues(h);
    case "/firstpr": return contribute.firstpr(h);
    // audio was removed from this bot on purpose; say so instead of going silent
    case "/podcast": case "/pod": return h.reply(h.loc === "fa"
      ? "🎙 پادکست و هر خروجی صوتی از این ربات حذف شد. جایش: <code>/trending</code> برای داغ‌ترین‌ها و <code>/scout owner/repo</code> برای پروندهٔ کامل."
      : "🎙 Podcast and every audio output were removed from this bot. Try <code>/trending</code> or <code>/scout owner/repo</code> instead.");

    case "/admin":
      if (!isAdmin(h.env, h.u.id)) return security.home(h);
      return admin.home(h);
    case "/flag": {
      if (!isAdmin(h.env, h.u.id))
        return h.reply("⛔ این دستور فقط برای مدیر ربات است.", kb([]));
      const [k, v] = arg.split(/\s+/);
      if (!k)
        return h.reply(
          "🚩 <b>پرچم‌های ربات</b> (فقط مدیر)\n<code>/flag &lt;نام&gt; on</code> · <code>/flag &lt;نام&gt; off</code>\n" +
            "<i>برای دیدن فهرست پرچم‌ها: <code>/flags</code></i>",
          kb([{ text: "🚩 پرچم‌ها", cb: "adm:flags" }, ]),
        );
      return admin.setFlag(h, k, v ?? "on");
    }
    case "/id": return showIds(h);
    case "/inline": {
      const username = botUsername(h.env);

      return h.reply(
        fa
          ? `🔎 <b>حالت inline</b>\n\nدر هر چتی بنویس:\n<code>@${tgEscape(username)} react state</code>\n\n` +
            `اگر کار نکرد، از @BotFather → <code>/setinline</code> حالت inline را برای @${tgEscape(username)} فعال کن.`
          : `Inline mode: type <code>@${tgEscape(username)} react state</code> in any chat. Enable it via @BotFather → /setinline if needed.`,
        kb([[{ text: "🐙 " + (fa ? "کارت مخزن" : "Repo card"), cb: "n:search" }]]),
      );
    }

    default:
      return h.reply(
        `🤔 ${fa ? "دستور ناشناخته" : "Unknown command"}: <code>${cmd}</code>\n${fa ? "برای فهرست کامل" : "see"} /help`,
        kb([[{ text: "📚 /help", cb: "h:main" }]]),
      );
  }
}

// helpers used by commands
function enc(s: string) { return encodeURIComponent(s).replace(/%/g, "_").slice(0, 40); }
/** Reverse of enc(): restore the percent-escapes and decode. */
function decode(s: string) {
  try { return decodeURIComponent(String(s ?? "").replace(/_/g, "%")); } catch { return String(s ?? ""); }
}
function normRepo(s: string) {
  return String(s ?? "").replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "").trim();
}
async function quotaBlocked(h: H) {
  const fa = h.loc === "fa";
  await h.reply(
    `🚦 <b>${fa ? "سهمیه امروز تمام شد" : "Daily quota reached"}</b>\n\n${fa
      ? "سهمیه رایگان روزانه به پایان رسید. فردا صفر می‌شود، یا پلن Pro بگیر."
      : "Free daily quota used up."}`,
    kb([[{ text: "⚡ " + (fa ? "پلن‌ها" : "Plans"), cb: "me:plan" }]]),
  );
}
function downloader(h: H) {
  return new Downloader(Number(h.env.MAX_TG_UPLOAD_MB || 49));
}
async function trendingMenuOrBoard(h: H, arg: string) {
  const trending = new TrendingFeature(new TrendingEngine(h.env));
  if (!arg) return trending.menu(h);
  const period = (["daily", "weekly", "monthly", "all"].find((p) => arg.includes(p)) as any) ?? "daily";
  const lang = arg.split(/\s+/).find((x) => ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C++", "PHP", "Ruby"].includes(x)) ?? "all";
  return trending.board(h, period, lang);
}
async function fetchScoutRaw(h: H, full: string) {
  const [o, n] = full.split("/");
  if (!o || !n) return null;
  const { GithubGraphQL, toRepoMeta } = await import("./github/graphql");
  const data = await new GithubGraphQL(h.env, h.userToken ?? h.env.GITHUB_TOKEN).deepScout(o, n).catch(() => null);
  if (!data?.repository) return null;
  return { meta: toRepoMeta(data), r: data.repository };
}

// ── callbacks ──────────────────────────────────────────────────────────────
async function routeCallback(q: CallbackQuery, env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard, guard?: ProgressGuard) {
  const data = String(q.data ?? "");
  if (!data) return;
  const [ns, action = "", rest = ""] = data.split(":");
  const arg = rest;
  const args = rest ? rest.split(",") : [];
  const h = await buildH({ from: q.from, chat: q.message?.chat ?? { id: q.from.id }, message_id: q.message?.message_id }, env, ctx, tg, store, ai, card, {
    cbId: q.id, text: arg, args, msg: q.message ?? undefined, guard,
  });
  const fa = h.loc === "fa";
  await store.event(q.from.id, "callback", `${ns}:${action}`);

  /* Pressing a button means the user chose something else, so the section they
     were typing into is over — unless the button belongs to that very section
     (the key-donation wizard, for instance). This is what stops a leftover
     "workflow" section from answering a question typed inside repo chat. */
  const mode = await readMode(h.session);
  if (mode) {
    if (modeKeeps(mode.kind, data)) await touchMode(h.session, mode);
    else await clearMode(h.session);
  }
  // walking away from the token prompt disarms it, so a later search query is
  // never mistaken for a pasted token
  if (!data.startsWith("me:")) await h.session.set("me:token", false).catch(() => null);

  const trending = new TrendingFeature(new TrendingEngine(env));
  const dl = downloader(h);

  try {
    switch (ns) {
      case "noop": return h.toast("");

      // ── global navigation ──
      case "m":
        if (action === "home" || action === "start") return settings.home(h);
        // «فعلاً نه» on the onboarding card: the menu, even without GitHub —
        // otherwise the skip button would bounce straight back to the card
        if (action === "menu") return settings.home(h, undefined, { force: true });
        // page 2 of the main menu
        if (action === "2") return settings.home2(h);
        break;
      case "h":
        if (action === "main") return settings.help(h);
        break;
      case "lang":
        if (action === "menu") return settings.lang(h);
        if (action === "set") return settings.setLang(h, (args[0] as any) ?? "fa");
        break;

      // ── search ──
      case "n":
        if (action === "search") return search.hub(h);
        if (action === "q") return search.run(h, decode(arg));
        if (action === "page") return search.run(h, decode(args[0] ?? ""), Number(args[1] ?? 0));
        if (action === "mode") return search.run(h, decode(args[1] ?? ""), 0, args[0] as any);
        if (action === "advanced") return search.run(h, decode(args[0] ?? ""));
        if (action === "filters") return search.filters(h, decode(args[0] ?? ""));
        if (action === "save") return saveSearch(h, decode(args[0] ?? ""));
        break;

      // ── trending ──
      case "t":
        if (action === "menu") return trending.menu(h);
        if (action === "b") return trending.board(h, (args[1] as any) ?? "daily", args[2] ?? "all", Number(args[0] ?? 0));
        if (action === "growth") return trending.growth(h, Number(args[0] ?? 7));
        if (action === "lang") return trending.langMenu(h, args[0] ?? "daily");
        if (action === "new") return trending.newcomers(h);
        if (action === "chart") return trending.chart(h);
        break;

      // ── browse ──
      case "b":
        if (action === "menu") return browse.menu(h);
        if (action === "c") return browse.category(h, args[0] ?? "");
        if (action === "s") return browse.list(h, args[0] ?? "");
        if (action === "l") return browse.list(h, args[1] ?? "", Number(args[0] ?? 0), (args[2] as any) ?? "stars");
        if (action === "orgs") return browse.orgs(h);
        if (action === "users") return browse.users(h, Number(args[0] ?? 0));
        if (action === "org") return browse.org(h, args[0] ?? "");
        if (action === "time") return browse.time(h);
        if (action === "year") return browse.year(h, Number(args[0] ?? 2026));
        if (action === "awesome") return browse.awesome(h, args[0] ?? "sindresorhus/awesome");
        break;

      // ── repo card ──
      case "r":
        if (action === "card") return repoCard(h, arg);
        if (action === "chart") return discover.chart(h, arg);
        if (action === "files") return discover.files(h, args[0] ?? "", args[1] ?? "");
        if (action === "share") return shareRepo(h, arg);
        if (action === "cmpcard") return compareCard(h, args[0] ?? "", args[1] ?? "");
        break;

      // ── deep scout ──
      case "s":
        if (action === "home") return scout.home(h);
        if (action === "go") return scout.open(h, arg, 0);
        if (action === "card") return repoCard(h, arg);
        if (action === "t") return scoutTab(h, Number(args[0] ?? 0), args[1] ?? "");
        if (action === "fromtrending") {
          const rows = await h.store.board("daily", "all", 5);
          if (!rows.length) return h.reply(fa ? "فهرست داغ خالی است." : "trending empty", kb([{ text: "◀️", cb: "s:home" }]), true);
          return scout.open(h, rows[0].full_name, 0);
        }
        if (action === "cmp") return scout.compare(h, arg);
        break;

      // ── AI ──
      case "ai":
        if (action === "repo") {
          // A repo analysis takes ~40 s on a cold repo — longer than the platform
          // gives a webhook. The card answers instantly and the queue edits it
          // when the analysis lands, which is why this button never looks dead.
          const queued = await deferFeature(
            h, "repo", arg,
            `🧠 <b>${tgEscape(arg)}</b>\n\n` +
              (fa ? "تحلیل کامل در صف اجرا شد — تا چند ثانیه دیگر جای همین پیام می‌آید. می‌توانی بروی؛ نتیجه را می‌فرستم."
                  : "Queued — the analysis will replace this message."),
          );
          if (queued) return;
          return assistant.dossier(h, arg);
        }
        if (action === "tr") {
          // «ترجمه README» from the assistant home asks for the repo; the same
          // key on a repo screen translates it directly. Either way the user
          // stays in the translation flow, not in a generic menu.
          if (arg !== "ask") return assistant.translateReadme(h, arg);
          await setMode(h.session, "tr");
          return h.reply(
            fa
              ? `📝 <b>ترجمهٔ README</b>\n\nنام مخزن را بفرست (<code>owner/repo</code>) تا کل README را فارسی کنم — با حفظ ساختار و کدها.\n\n<i>مثال: <code>python-telegram-bot/python-telegram-bot</code></i>`
              : `📝 <b>Translate a README</b>\n\nSend the repo (<code>owner/repo</code>) and I translate the whole README to Persian.`,
            kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
            !!h.cbId,
          );
        }
        if (action === "trmore") {
          // Callback is ai:trmore:<full>:<page>
          const parts = data.split(":");
          const page = Number(parts[parts.length - 1] ?? 1);
          const repo = parts.slice(2, parts.length - 1).join(":");
          return translateMore(h, repo, page);
        }
        if (action === "tre") return translateTo(h, args[0] ?? "", args[1] ?? "en");
        if (action === "trpdf") return translatePdf(h, args[0] ?? "");
        if (action === "cmp") return aiCompare(h, (args[0] ?? "").split("|")[0] ?? "", (args[0] ?? "").split("|")[1] ?? "");
        break;

      // ── assistant ──
      case "a":
        if (action === "home") return assistant.home(h);
        if (action === "new") {
          /* Pressing «گفت‌وگوی جدید» used to redraw the very same menu, which
             reads as "this button does nothing". Now it says what to do next —
             the user is standing in the chat section, so the next message is a
             question and stays one until they press a button. */
          await setMode(h.session, "ask");
          return h.reply(
            `💬 <b>${fa ? "گفت‌وگوی تازه" : "New chat"}</b>\n\n` +
              (fa
                ? `✍️ فقط بنویس — یا با 🎤 ویس بفرست.\n\n` +
                  `مثال‌ها:\n• «یک کتابخانهٔ سبک برای صف در Go»\n• «فرق Bun و Node چیست؟»\n• «برای پروژهٔ پایتونی‌ام چه ابزار CI خوب است؟»`
                : `✍️ Type your question — or send a voice note.`),
            kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
            !!h.cbId,
          );
        }
        if (action === "cont") {
          await setMode(h.session, "ask");
          return h.reply(fa ? "✍️ سؤالت را بنویس…" : "Type your follow-up…", kb([[{ text: "◀️", cb: "a:home" }]]));
        }
        if (action === "q") {
          // «این را از هوش مصنوعی بپرس» — one tap from a search result
          await setMode(h.session, "ask");
          return assistant.ask(h, decode(arg));
        }
        if (action === "clear") {
          await h.store.addMessage(`u${h.u.id}`, "system", "[conversation cleared]");
          return h.reply(fa ? "🧹 حافظه پاک شد." : "🧹 memory cleared", kb([[]]));
        }
        if (action === "repochat") return assistant.repoChat(h, args[0] ?? "");
        if (action === "workflow") return assistant.workflow(h);
        if (action === "wf") return assistant.workflow(h, arg);
        if (action === "code") return assistant.code(h);
        if (action === "review") return assistant.review(h);
        if (action === "askv") return assistant.ask(h, arg);
        if (action === "voice") return assistant.home(h);
        break;

      // ── downloads ──
      case "d":
        if (action === "home") return dl.home(h);
        if (action === "repo") return dl.choose(h, arg);
        if (action === "go") { const [full, fmtp, ref] = arg.split("|"); return dl.run(h, full, (fmtp as any) ?? "zip", ref ?? "main"); }
        if (action === "split") { const [full, fmtp, ref] = arg.split("|"); return dl.run(h, full, (fmtp as any) ?? "zip", ref ?? "main", { split: true }); }
        if (action === "a7z") return dl.offloadToActions(h, arg, "main", 900 * 1024 * 1024);
        if (action === "link") return dl.direct(h, arg);
        if (action === "recent") return dl.recent(h);
        if (action === "forget") return dl.forget(h, arg);
        if (action === "clear") return dl.clearHistory(h);
        if (action === "trending") { const rows = await h.store.board("daily", "all", 5); return dl.choose(h, rows[0]?.full_name ?? "cloudflare/workers-sdk"); }
        if (action === "favs") {
          const { results } = await h.store.favs(h.u.id, 8);
          if (!results?.length) return h.reply(fa ? "علاقه‌مندی‌ای نداری." : "no favourites", kb([{ text: "◀️", cb: "d:home" }]), true);
          return h.reply(fa ? "⭐ یکی را انتخاب کن:" : "Pick one:", kb(...results.map((r: any) => [{ text: `📦 ${r.full_name}`, cb: `d:repo:${r.full_name}` }]), [{ text: "◀️", cb: "d:home" }]), true);
        }
        break;

      // ── tools ──
      case "u":
        if (action === "home") return tools.home(h);
        if (action === "pkg") return tools.pkg(h);
        if (action === "conv") return tools.convert(h, args[0] ?? "deb", args[1] ?? "rpm");
        if (action === "inspect" || action === "convactions") return tools.pkg(h);
        if (action === "ip") { await setMode(h.session, "u:ip"); return h.reply(fa ? "📡 IP یا دامنه را بفرست." : "Send IP or domain.", kb([[{ text: "◀️", cb: "u:home" }]])); }
        if (action === "geo") return tools.intel(h, "8.8.8.8");
        if (action === "dns") { await setMode(h.session, "u:ip"); return h.reply(fa ? "🧭 دامنه را بفرست." : "Send domain."); }
        if (action === "tls") { if (args[0]) return tools.tls(h, args[0]); await setMode(h.session, "u:ip"); return h.reply(fa ? "🔐 دامنه را بفرست." : "Send domain."); }
        if (action === "asn") { if (args[0]) return tools.asn(h, args[0]); await setMode(h.session, "u:asn"); return h.reply(fa ? "🛰 شماره ASN را بفرست (مثل 13335)." : "Send ASN number."); }
        if (action === "dev") return devutils.home(h);
        if (action === "cidr") return devutils.cidr(h);
        if (action === "cron") return devutils.cron(h);
        if (action === "regex") return devutils.regex(h);
        break;

      // ── dev utils ──
      case "dvu":
        if (action === "home") return devutils.home(h);
        if (action === "cron") { if (arg) return devutils.cron(h, arg); await setMode(h.session, "dvu:cron"); return devutils.cron(h); }
        if (action === "regex") { if (arg) return devutils.runRegex(h, arg); await setMode(h.session, "dvu:regex"); return devutils.regex(h); }
        if (action === "cidr") { if (arg) return devutils.cidr(h, arg); await setMode(h.session, "dvu:cidr"); return devutils.cidr(h); }
        if (action === "jwt") { if (arg) return devutils.jwt(h, arg); await setMode(h.session, "dvu:jwt"); return devutils.jwt(h); }
        if (action === "b64" || action === "b64d") {
          if (arg) return devutils.b64(h, arg);
          await setMode(h.session, "dvu:b64");
          return devutils.b64(h);
        }
        if (action === "hash") { if (arg) return devutils.hash(h, arg); await setMode(h.session, "dvu:hash"); return devutils.hash(h, ""); }
        if (action === "id") return devutils.id(h);
        if (action === "time") { if (arg) return devutils.time(h, arg); await setMode(h.session, "dvu:time"); return devutils.time(h); }
        if (action === "json") { if (arg) return devutils.json(h, decode(arg)); await setMode(h.session, "dvu:json"); return devutils.json(h); }
        if (action === "gitignore") return devutils.gitignore(h);
        if (action === "gi") return devutils.gitignoreFor(h, arg);
        if (action === "semver") { if (arg) return devutils.semver(h, arg); await setMode(h.session, "dvu:semver"); return devutils.semver(h); }
        if (action === "sv") return devutils.semver(h, arg);
        if (action === "color") { if (arg) return devutils.color(h, arg); await setMode(h.session, "dvu:color"); return devutils.color(h); }
        break;

      // ── security ──
      case "sec":
        if (action === "home") return security.home(h);
        if (action === "scan") return security.askRepo(h, "scan");
        if (action === "secrets") return security.askRepo(h, "secrets");
        if (action === "repo") return security.scan(h, arg);
        if (action === "watch") return security.watch(h);
        if (action === "recent") return security.recent(h);
        break;

      // ── favourites ──
      case "f":
        if (action === "add") return profile.addFav(h, arg);
        if (action === "list") return profile.favs(h);
        if (action === "rm") return removeFav(h, arg);
        if (action === "export") return profile.exportFavs(h);
        break;

      // ── subscriptions ──
      case "sub":
        if (action === "add") return profile.addSub(h, args[0] ?? "", args[1] ?? "release");
        if (action === "list") return profile.subs(h);
        if (action === "muteall") {
          await h.env.DB.prepare(`UPDATE subscriptions SET muted_until=? WHERE user_id=?`).bind(Date.now() + 7 * 86400000, h.u.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          await h.toast(fa ? "🔇 تا ۷ روز بی‌صدا شد" : "muted 7d");
          return profile.subs(h);
        }
        if (action === "clear") {
          await h.env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`).bind(h.u.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          await h.toast(fa ? "🗑 همه لغو شد" : "all cleared");
          return profile.subs(h);
        }
        break;

      // ── profile / gamification ──
      case "me":
        if (action === "home") return profile.home(h);
        if (action === "dash") return profile.dash(h);
        if (action === "board") return profile.board(h);
        if (action === "ref") return profile.referral(h);
        if (action === "interests") return profile.interests(h);
        if (action === "t") return profile.toggleInterest(h, args[0] ?? "");
        if (action === "plan") return profile.plans(h);
        if (action === "pro") return profile.requestPro(h);
        if (action === "link") return githubLink(h);
        if (action === "token") return githubTokenPrompt(h);
        if (action === "unlink") return githubUnlink(h);
        if (action === "export") return exportMyData(h);
        break;

      // ── contribute ──
      case "c":
        if (action === "home") return contribute.home(h);
        if (action === "issues") return contribute.issues(h, args[0] ?? "good first issue", args[1] && args[1] !== "*" ? args[1] : undefined);
        if (action === "firstpr") return contribute.firstpr(h);
        if (action === "plan") return contribute.plan(h);
        if (action === "welcoming") return contribute.welcoming(h);
        if (action === "licenses") return contribute.licenses(h);
        if (action === "repo") return contribute.repo(h, arg);
        break;

      // ── discover ──
      case "x":
        if (action === "gems") return discover.gems(h, Number(args[0] ?? 0));
        if (action === "random") return discover.random(h);
        if (action === "sim") return discover.similar(h, arg);
        if (action === "map") return discover.map(h);
        break;

      // ── donated AI keys ──
      case "keys":
        if (action === "home") return keysFeature.home(h);
        if (action === "add") return keysFeature.add(h);
        if (action === "p") return keysFeature.ask(h, args[0] ?? "");
        if (action === "mine") return keysFeature.mine(h);
        if (action === "del") return keysFeature.del(h, Number(args[0] ?? 0));
        if (action === "test") return keysFeature.test(h);
        if (action === "clean") return keysFeature.clean(h);
        if (action === "m") {
          // one tap on a model we discovered during onboarding: store the key
          // that was already tested, now with a model the server accepts
          const pending: any = await h.session.get("keys:pending");
          const state = typeof pending === "string" ? JSON.parse(pending) : (pending ?? {});
          if (!state?.baseUrl || !state?.savedKey) return keysFeature.home(h);
          return keysFeature.accept(h, { ...state, model: decodeURIComponent(args[0] ?? "") }, state.savedKey);
        }
        break;

      // ── my GitHub account (public + private, with the user's own token) ──
      case "gh":
        // linked → the full dashboard; not linked → the one-tap token onboarding
        if (action === "home") return githubOverview(h);
        if (action === "repos") return accountFeature.repos(h, Number(args[0] ?? 0));
        if (action === "private") return accountFeature.privateRepos(h);
        if (action === "orgs") return accountFeature.orgs(h);
        if (action === "starred") return accountFeature.starred(h, Number(args[0] ?? 0));
        if (action === "stats") return accountFeature.stats(h);
        break;

      // ── audio: gone by owner instruction, kept only as a one-line signpost ──
      case "pod":
        return h.toast(fa ? "🎙 صدا حذف شد" : "🎙 audio removed", true);

      // ── feed ──
      case "feed":
        if (action === "show") return profile.feed(h);
        break;

      // ── net radar ──
      case "nr":
        if (action === "home") return netRadar.home(h);
        if (action === "subs") return netRadar.freeSubs(h);
        if (action === "app") return netRadar.app(h, args[0] ? args.join(":") : arg);
        if (action === "dl") {
          const parts = data.split(":");
          const assetId = Number(parts[parts.length - 1]);
          const repo = parts.slice(2, parts.length - 1).join(":");
          return netRadar.downloadAsset(h, repo, assetId);
        }
        break;

      // ── architecture ──
      case "arch":
        if (action === "ask") {
          await setMode(h.session, "arch");
          return h.reply(fa ? "🗺 نام یا آدرس مخزن را بفرست تا معماری‌اش را تحلیل کنم:" : "Send repo for architecture analysis:", kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]));
        }
        if (action === "view") {
          const repo = data.split(":").slice(2).join(":");
          return archExplainer.explain(h, repo);
        }
        break;

      // ── app generator ──
      case "appgen":
        if (action === "prompt") {
          await setMode(h.session, "appgen");
          return appGen.prompt(h);
        }
        break;

      // ── multi-cloud and ai hub ──
      case "hub":
        if (action === "home") return multiHub.home(h);
        if (action === "gitlab") {
          await setMode(h.session, "hub_gitlab");
          return multiHub.gitlabPrompt(h);
        }
        if (action === "cloud") return multiHub.cloudMonitor(h);
        if (action === "postmaker") {
          await setMode(h.session, "hub_post");
          return multiHub.postMakerPrompt(h);
        }
        if (action === "repost") {
          const q = decodeURIComponent(args[0] ?? "");
          return multiHub.buildChannelPost(h, q);
        }
        if (action === "pyrun") {
          await setMode(h.session, "hub_py");
          return multiHub.pySandboxPrompt(h);
        }
        break;

      // ── Universal Hub OS: the event bus, connectors, content graph ──
      case "hos":
        if (action === "home") return hubOS.home(h);
        if (action === "mission") return hubOS.missionPrompt(h);
        if (action === "books") return hubOS.books(h);
        if (action === "book") return hubOS.installBook(h, arg);
        if (action === "conn") return hubOS.connectors(h);
        if (action === "connadd") return hubOS.connectorAddPrompt(h, arg);
        if (action === "conntest") return hubOS.connectorTest(h, arg || "all");
        if (action === "conndel") return hubOS.connectorDeletePrompt(h, arg);
        if (action === "conndel2") return hubOS.deleteConnector(h, arg);
        if (action === "poll") return hubOS.connectorPoll(h, arg);
        if (action === "wf") return hubOS.workflows(h);
        if (action === "wfv") return hubOS.workflowView(h, arg);
        if (action === "wftog") return hubOS.toggleWorkflow(h, arg);
        if (action === "wfdel") return hubOS.workflowDeletePrompt(h, arg);
        if (action === "wfdel2") return hubOS.deleteWorkflow(h, arg);
        if (action === "dedupe") return hubOS.dedupePrompt(h, arg);
        if (action === "dedupe2") return hubOS.dedupe(h, arg);
        if (action === "wfrun") return hubOS.runWorkflowById(h, arg);
        if (action === "wire") return hubOS.wiring(h, arg, true);
        if (action === "wiring") return hubOS.wiring(h, arg, false);
        if (action === "whook") return hubOS.hookHelp(h, arg);
        if (action === "repo") return hubOS.repoPrompt(h, arg);
        if (action === "queue") return hubOS.queue(h);
        if (action === "view") return hubOS.viewContent(h, arg);
        if (action === "ok") return hubOS.approve(h, arg);
        if (action === "edit") return hubOS.editPrompt(h, arg);
        if (action === "no") return hubOS.reject(h, arg);
        if (action === "graph") return hubOS.graph(h);
        if (action === "events") return hubOS.events(h);
        if (action === "runs") return hubOS.runs(h);
        if (action === "selftest") return hubOS.selfTest(h);
        if (action === "know") return hubOS.knowledge(h);
        if (action === "ents") return hubOS.entities(h);
        if (action === "search") return hubOS.searchPrompt(h);
        if (action === "files") return hubOS.filePrompt(h);
        if (action === "media") return hubOS.mediaPrompt(h);
        if (action === "integ") return hubOS.integrations(h);
        if (action === "deploy") return hubOS.deployPrompt(h);
        if (action === "guide") return hubOS.guide(h);
        if (action === "auto") {
          // the screen's own two buttons: `hos:auto:on|off`
          if (arg === "on" || arg === "off") return hubOS.setAutonomy(h, arg === "on" ? "auto" : "manual");
          return hubOS.autonomy(h);
        }
        if (action === "setauto") return hubOS.setAutonomy(h, arg === "auto" ? "auto" : "manual");
        break;
      // ── admin ──
      case "adm":
        if (action === "home") return admin.home(h);
        if (action === "prog" || action === "pror") {
          // Only an admin may settle a plan request; anyone else gets nothing.
          if (!isAdmin(env, h.u.id)) return h.toast(fa ? "دسترسی نداری" : "not allowed", true);
          const uid = Number(args[0] ?? 0);
          await env.DB.prepare(`DELETE FROM flags WHERE key=?`).bind(`pro:req:${uid}`).run().catch(() => null);
          if (action === "prog") {
            await env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
              .bind(`plan:${uid}`, "pro", Date.now()).run().catch(() => null);
            await env.DB.prepare(`UPDATE users SET daily_queries=0 WHERE id=?`).bind(uid).run().catch(() => null);
          }
          await h.tg.sendMessage(uid, action === "prog"
            ? `💎 <b>Pro فعال شد</b>\n\nسقف روزانه‌ات برداشته شد و کارهای سنگین برایت باز است. از همین حالا کار می‌کند — چیزی برای تنظیم نیست.`
            : `🆓 <b>درخواست Pro فعلاً تأیید نشد</b>\n\nهمهٔ قابلیت‌ها با سقف رایگان در دسترس‌اند. هر وقت خواستی دوباره از «⚡ پلن‌ها» درخواست بده.`,
            { parse_mode: "HTML" }).catch(() => null);
          return h.toast(action === "prog" ? "✅ Pro فعال شد" : "🗑 رد شد", true);
        }
        if (action === "pros") {
          if (!isAdmin(env, h.u.id)) return h.toast(fa ? "دسترسی نداری" : "not allowed", true);
          const { results } = await env.DB.prepare(
            `SELECT f.key, f.value, u.username, u.first_name FROM flags f LEFT JOIN users u ON u.id = CAST(REPLACE(f.key,'pro:req:','') AS INTEGER)
             WHERE f.key LIKE 'pro:req:%' ORDER BY f.updated_at DESC LIMIT 20`,
          ).all<any>().catch(() => ({ results: [] as any[] }));
          const rows = results ?? [];
          return h.reply(
            `💎 <b>${fa ? "درخواست‌های Pro" : "Pro requests"}</b> — <b>${rows.length}</b>\n\n` +
              (rows.length
                ? rows.map((r: any) => `• ${tgEscape(r.username ? "@" + r.username : r.first_name ?? "?")} · <code>${String(r.key).replace("pro:req:", "")}</code> · ${new Date(Number(r.value)).toISOString().slice(0, 10)}`).join("\n")
                : (fa ? "<i>درخواستی در صف نیست.</i>" : "<i>none</i>")),
            kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "adm:home" }]]),
            !!h.cbId,
          );
        }
        if (action === "flags") return admin.flags(h);
        if (action === "flag") return admin.setFlag(h, args[0] ?? "", args[1] ?? "on");
        if (action === "broadcast") return admin.broadcast(h);
        if (action === "aitest") return admin.aitest(h);
        if (action === "podcast") return h.toast(fa ? "🎙 حذف شد" : "🎙 removed", true);
        if (action === "snapshot") {
          const eng = new TrendingEngine(h.env);
          const n = await eng.snapshot((await eng.rank("daily", "all", 30)).map((r: any) => r.full_name));
          return h.reply(`📊 ${fa ? "اسنپ‌شات گرفته شد" : "snapshot taken"}: ${n} repos`, kb([[{ text: "◀️", cb: "adm:home" }]]), true);
        }
        if (action === "cleanup") {
          const r1 = await h.env.DB.prepare(`DELETE FROM events WHERE ts < ?`).bind(Date.now() - 90 * 86400000).run().catch(() => null);
          const r2 = await h.env.DB.prepare(`DELETE FROM repo_snapshots WHERE day < date('now','-1 year')`).run().catch(() => null);
          return h.reply(`🧹 ${fa ? "پاکسازی انجام شد" : "cleaned"}: events=${(r1 as any)?.meta?.changes ?? "?"}, snaps=${(r2 as any)?.meta?.changes ?? "?"}`, kb([[{ text: "◀️", cb: "adm:home" }]]));
        }
        break;
    }
    await h.toast("…");
  } catch (e: any) {
    console.error("callback error", e?.stack ?? e);
    await h.toast("⚠️ " + String(e?.message ?? e).slice(0, 120), true);
  }
}

// callback sub-handlers that need extra logic
async function repoCard(h: H, full: string) {
  const gh = new GithubRest(h.env);
  const m = await gh.repo(full, 600).catch(() => null);
  if (!m) return h.toast(h.loc === "fa" ? "❌ پیدا نشد" : "❌ not found", true);
  const meta = { ...m, full_name: m.full_name, stars: m.stargazers_count, forks: m.forks_count, watchers: m.watchers_count, issues: m.open_issues_count, languages: [], topics: m.topics ?? [], health: 0, redFlags: [], raw: m };
  const rendered = await h.card.render(meta, { loc: h.loc });
  return h.replyRich(rendered.rich ?? rendered.text, rendered.keyboard, true);
}

async function scoutTab(h: H, tab: number, full: string) {
  const data = await fetchScoutRaw(h, full);
  if (!data) return h.toast("❌", true);
  const text = await scout.tab(h, data, tab);
  /* The tab bodies are written as escaped Telegram HTML; the converter gives
     them document shape (heading, lists, pre sparklines) without re-escaping
     the tags the screen itself wrote. All twelve tabs become documents with
     this one line. */
  const { telegramHtmlToRich } = await import("./tg/rich");
  return h.replyRich(telegramHtmlToRich(text), scout.tabsKeyboard(h, full, tab), true);
}

async function translateMore(h: H, full: string, page: number) {
  /* A README is read page by page now: page N is decoded, translated and cached
     on its own, so turning a page costs one page instead of a whole document —
     which is what the CPU limit allowed. The reader keeps both directions
     («قبلی» / «ادامه») all the way to the end. */
  return assistant.readmeMore(h, full, page);
}
async function translateMoreLegacy(h: H, full: string, page: number) {
  const source = ((await h.session.get(`tr:${full}`)) ?? (await h.env.STATE.get(`trl:${full}:${h.loc}`))) as string | null;
  if (!source) return h.toast(h.loc === "fa" ? "دوباره ترجمه کن" : "re-translate first", true);
  /* The same pagination the first page used: page N of the pager and page N of the
     document are the same text, so pressing «ادامه» never re-flows the README. */
  const { paginateMd } = await import("./hub/richdoc");
  const pages = paginateMd(source.slice(0, 24000), (await import("./hub/richdoc")).README_PAGE_CHARS);
  const idx = Math.max(0, Math.min(page, pages.length - 1));
  const nav: any[] = [];
  if (idx > 0) nav.push({ text: "⬅️ " + (h.loc === "fa" ? "قبلی" : "Prev"), cb: `ai:trmore:${full}:${idx - 1}` });
  if (idx + 1 < pages.length) nav.push({ text: (h.loc === "fa" ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:${idx + 1}` });

  return h.replyRich(
    await (await import("./features/assistant")).readmePage(full, pages[idx], idx, pages.length),
    kb(
      nav,
      [
        { text: "🖨 PDF", cb: `ai:trpdf:${full}` },
        { text: "◀️ " + (h.loc === "fa" ? "بازگشت" : "Back"), cb: `s:card:${full}` },
      ]
    ),
    true,
  );
}

async function translateTo(h: H, full: string, loc: string) {
  const gh = new GithubRest(h.env);
  const raw = await gh.readme(full, 3600).catch(() => null);
  if (!raw?.content) return h.toast("❌", true);
  const md = atob(raw.content.replace(/\n/g, "")).slice(0, 14000);
  const out = await h.ai.translate(md, loc === "en" ? "en" : loc, "README");
  return h.reply(out.slice(0, 3900), kb([[{ text: "◀️ " + (h.loc === "fa" ? "بازگشت" : "Back"), cb: `ai:tr:${full}` }]]), true);
}

async function translatePdf(h: H, full: string) {
  const cache = await h.env.STATE.get(`trl:${full}:${h.loc}`);
  const text = cache ?? (await (async () => {
    const gh = new GithubRest(h.env);
    const raw = await gh.readme(full, 3600).catch(() => null);
    if (!raw?.content) return "";
    return h.ai.translate(atob(raw.content.replace(/\n/g, "")).slice(0, 14000), h.loc === "fa" ? "fa" : "en", "README");
  })());
  if (!text) return h.toast("❌", true);
  const html = `<!doctype html><html dir="${h.loc === "fa" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${full}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;max-width:820px;margin:40px auto;line-height:1.9;color:#111}
h1{border-bottom:2px solid #eee;padding-bottom:8px}pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto;direction:ltr;text-align:left}
code{background:#f1f3f5;padding:2px 5px;border-radius:4px}.meta{color:#666;font-size:13px}</style></head>
<body><h1>${full}</h1><div class="meta">GitHub Lens Ultra — ${new Date().toISOString().slice(0, 10)}</div><pre style="white-space:pre-wrap">${escapeHtml(text)}</pre></body></html>`;
  await h.tg.sendDocument(h.chatId, `${full.replace("/", "-")}-${h.loc}.html`, new TextEncoder().encode(html),
    `🖨 ${h.loc === "fa" ? "نسخه قابل چاپ (HTML → PDF با Ctrl+P)" : "printable HTML"}`);
}

async function aiCompare(h: H, a: string, b: string) {
  const fa = h.loc === "fa";
  const [ma, mb] = await Promise.all([h.store.repoFresh(a, 3600), h.store.repoFresh(b, 3600)]);
  if (!ma || !mb) return h.toast("❌", true);
  await h.loading(fa ? "🧠 تحلیل مقایسه‌ای…" : "🧠 comparing…");
  const verdict = await h.ai.chat(
    `Compare these two repositories for a developer choosing between them. Write in Persian, 180-260 words, with sections: «کدام برای چه کسی»، «تفاوت‌های کلیدی»، «حکم نهایی». Use real data only.
A: ${ma.full_name} — ${ma.description} — ⭐${ma.stars} — ${ma.language} — license ${ma.license} — last push ${ma.pushed_at} — health ${ma.health_score}
B: ${mb.full_name} — ${mb.description} — ⭐${mb.stars} — ${mb.language} — license ${mb.license} — last push ${mb.pushed_at} — health ${mb.health_score}`,
    { tier: "smart", max_tokens: 900, cacheKey: `aicmp:${a}:${b}:${ma.stars}:${mb.stars}`, cacheTtl: 604800, userId: h.u.id, feature: "compare" },
  );
  return h.reply(`⚖️ <b>${a}</b> vs <b>${b}</b>\n\n${verdict.slice(0, 3600)}`, kb(
    [{ text: `① ${a.slice(0, 26)}`, cb: `s:go:${a}` }, { text: `② ${b.slice(0, 26)}`, cb: `s:go:${b}` }],
    [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:cmp:${a}` }],
  ), true);
}

async function compareCard(h: H, a: string, b: string) {
  const url = `${h.env.WORKER_URL}/api/compare-card?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  return h.reply(`🖼 <b>${a}</b> vs <b>${b}</b>\n\n<a href="${url}">${h.loc === "fa" ? "کارت مقایسه آنلاین" : "online compare card"}</a>`,
    kb([{ text: "🔗 " + (h.loc === "fa" ? "باز کردن" : "Open"), url }], [{ text: "◀️", cb: `s:cmp:${a}` }]), true);
}

async function shareRepo(h: H, full: string) {
  const shareText = `${full} — ⭐ on GitHub Lens Ultra`;
  return h.reply(
    `🔗 <b>${full}</b>\n\n${h.loc === "fa" ? "ارسال به دوستان:" : "Share:"}`,
    kb(
      [{ text: "🐙 GitHub", url: `https://github.com/${full}` },
       { text: "📤 Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(`https://github.com/${full}`)}&text=${encodeURIComponent(shareText)}` }],
      [{ text: "🖼 " + (h.loc === "fa" ? "کارت تصویری" : "Image card"), cb: `r:card:${full}` }],
      [{ text: "◀️ " + (h.loc === "fa" ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
    ),
    true,
  );
}

async function saveSearch(h: H, q: string) {
  const fa = h.loc === "fa";
  const u = await h.store.user(h.u.id);
  const saved: string[] = (() => { try { return JSON.parse((u as any)?.skills ?? "[]"); } catch { return []; } })();
  // store saved searches inside skills-adjacent KV for simplicity & privacy
  const key = `saved:${h.u.id}`;
  const list: { q: string; at: number }[] = (await h.env.STATE.get(key, "json")) ?? [];
  if (!list.some((x) => x.q === q)) list.unshift({ q, at: Date.now() });
  await h.env.STATE.put(key, JSON.stringify(list.slice(0, 20)));
  await h.toast(fa ? "🔔 ذخیره شد" : "saved");
  return h.reply(
    `🔔 <b>${fa ? "جست‌وجو ذخیره شد" : "Search saved"}</b>\n<code>${q}</code>\n\n` +
      (fa ? "هر روز صبح اگر پروژه جدیدی مطابق این جست‌وجو پیدا شد، خبرت می‌کنم." : "We'll notify you about new matches."),
    kb(
      [{ text: "🎯 " + (fa ? "اجرای دوباره" : "Run again"), cb: `n:q:${encodeURIComponent(q).replace(/%/g, "_").slice(0, 40)}` }],
      [{ text: "🔔 " + (fa ? "فید شخصی" : "My feed"), cb: "feed:show" }, { text: "◀️", cb: "n:search" }],
    ),
    !!h.cbId,
  );
}

async function removeFav(h: H, full: string) {
  await h.store.unfav(h.u.id, full);
  await h.toast(h.loc === "fa" ? "🗑 حذف شد" : "removed");
  return profile.favs(h);
}

async function exportMyData(h: H) {
  const [u, favs, subs, events] = await Promise.all([
    h.store.user(h.u.id),
    h.store.favs(h.u.id, 500),
    h.store.subsOf(h.u.id),
    h.env.DB.prepare(`SELECT kind, name, ts FROM events WHERE user_id=? ORDER BY ts DESC LIMIT 1000`).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] })),
  ]);
  const payload = {
    exported_at: new Date().toISOString(),
    profile: { id: u?.id, username: u?.username, locale: u?.locale, plan: u?.plan, xp: u?.xp, level: u?.level, badges: u?.badges, interests: u?.interests },
    favourites: favs.results ?? [],
    subscriptions: subs.results ?? [],
    recent_activity: events.results ?? [],
    note: "GDPR-style export. Nothing else about you is stored.",
  };
  await h.tg.sendDocument(h.chatId, `ghlens-my-data.json`, new TextEncoder().encode(JSON.stringify(payload, null, 2)), "📤 " + (h.loc === "fa" ? "خروجی داده‌های شما" : "your data export"));
}

// ── inline mode ────────────────────────────────────────────────────────────
async function routeInline(q: InlineQuery, env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain) {
  const query = q.query.trim();
  if (query.length < 2) {
    return tg.answerInlineQuery(q.id, [{
      type: "article", id: "help",
      title: "GitHub Lens Ultra — type a repo or topic",
      description: "e.g. cloudflare/workers-sdk · react state management · python http client",
      input_message_content: { message_text: "🔍 GitHub Lens Ultra — کشف هوشمند اوپن‌سورس", parse_mode: "HTML" },
    } as any]);
  }
  const gh = new GithubRest(env);
  const results: any[] = [];

  // direct repo hit
  if (/^[\w.-]+\/[\w.-]+$/.test(query)) {
    const m = await gh.repo(query, 600).catch(() => null);
    if (m) {
      results.push({
        type: "article", id: `repo:${m.full_name}`,
        title: `📦 ${m.full_name} — ⭐ ${m.stargazers_count}`,
        description: `${m.language ?? "—"} · ${(m.description ?? "No description").slice(0, 80)}`,
        thumbnail_url: m.owner?.avatar_url,
        input_message_content: {
          message_text:
            `📦 <b><a href="https://github.com/${m.full_name}">${m.full_name}</a></b>\n\n` +
            `${m.description ? `<i>${m.description}</i>\n\n` : ""}` +
            `⭐ <b>${m.stargazers_count.toLocaleString()}</b> ستاره · 🍴 <b>${m.forks_count.toLocaleString()}</b> فورک · 🧩 <b>${m.language ?? "نامشخص"}</b>\n\n` +
            `🔍 کاوش عمیق، دانلود مستقیم سورس و ترجمه با @Gitguts_bot`,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛰 باز کردن در ربات", url: `https://t.me/Gitguts_bot?start=repo_${m.full_name.replace("/", "_")}` },
              { text: "🌐 مشاهده گیت‌هاب", url: m.html_url },
            ]
          ]
        },
      } as any);
    }
  }

  // search results
  const res = await gh.searchRepos(query, "stars", "desc", 10).catch(() => null);
  for (const r of res?.items ?? []) {
    const updated = (r.pushed_at ?? "").slice(0, 10);
    const topics = (r.topics ?? []).slice(0, 4).map((t: string) => `#${t}`).join(" ");
    results.push({
      type: "article", id: `r:${r.full_name}`,
      title: `⭐ ${r.stargazers_count.toLocaleString()} | ${r.full_name}`,
      description: `${r.language ? `[${r.language}] ` : ""}${(r.description ?? "بدون توضیح").slice(0, 80)}`,
      thumbnail_url: r.owner?.avatar_url,
      input_message_content: {
        message_text:
          `📦 <b><a href="https://github.com/${r.full_name}">${r.full_name}</a></b>\n\n` +
          `📝 <b>توضیحات:</b>\n<i>${tgEscape(r.description || "بدون توضیحات ثبت‌شده")}</i>\n\n` +
          `📊 <b>آمار و وضعیت:</b>\n` +
          `• ⭐ <b>ستاره‌ها:</b> ${r.stargazers_count.toLocaleString()}\n` +
          `• 🍴 <b>فورک‌ها:</b> ${r.forks_count.toLocaleString()}\n` +
          `• 🧩 <b>زبان اصلی:</b> <code>${r.language ?? "چندزبانه"}</code>\n` +
          `• 🕒 <b>آخرین بروزرسانی:</b> <code>${updated}</code>\n` +
          (topics ? `\n🏷 <b>برچسب‌ها:</b>\n<code>${topics}</code>\n` : "") +
          `\n────────────\n` +
          `🤖 <i>تحلیل هوشمند، ترجمه README و دانلود سورس با @Gitguts_bot</i>`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛰 کاوش و دانلود در ربات", url: `https://t.me/Gitguts_bot?start=repo_${r.full_name.replace("/", "_")}` },
            { text: "🌐 صفحه گیت‌هاب", url: r.html_url },
          ]
        ]
      },
    } as any);
  }

  // trending shortcut
  results.push({
    type: "article", id: "trending",
    title: "🔥 داغ‌ترین‌های امروز گیت‌هاب",
    description: "GitHub Lens Ultra trending board",
    input_message_content: { message_text: `🔥 داغ‌ترین‌های امروز — GitHub Lens Ultra\n${env.WORKER_URL}`, parse_mode: "HTML" },
  } as any);

  return tg.answerInlineQuery(q.id, results.slice(0, 20), 20);
}

// ── misc ───────────────────────────────────────────────────────────────────
/** /id — the user's own Telegram identifiers (needed to become admin). */
async function showIds(h: H) {
  const fa = h.loc === "fa";
  const user = await h.store.user(h.u.id);
  await h.reply(
    `🆔 <b>${fa ? "شناسه‌های تو" : "Your identifiers"}</b>\n\n` +
      `👤 ${fa ? "آیدی کاربری تلگرام" : "telegram user id"}: <code>${h.u.id}</code>\n` +
      `💬 ${fa ? "آیدی این چت" : "chat id"}: <code>${h.chatId}</code>\n` +
      (h.u.username ? `📛 @${tgEscape(h.u.username)}\n` : "") +
      (user?.referral_code ? `🎁 ${fa ? "کد معرفی" : "referral"}: <code>${tgEscape(user.referral_code)}</code>\n` : "") +
      `\n<i>${fa
        ? "برای دسترسی ادمین، عدد «آیدی کاربری» را در متغیر ADMIN_IDS فایل wrangler.jsonc بگذار و دوباره دیپلوی کن."
        : "Put the user id into ADMIN_IDS in wrangler.jsonc and redeploy for admin access."}</i>`,
    kb(
      [{ text: "👤 " + (fa ? "پروفایل" : "Profile"), cb: "me:home" }, { text: "🛠 " + (fa ? "جعبه‌ابزار" : "Toolbox"), cb: "u:home" }],
      
    ),
    !!h.cbId,
  );
}

/**
 * Deep self-test — proves every subsystem really works, on the live account.
 * Gated behind the webhook secret because it spends AI neurons.
 */
function safeJsonField(raw: string, key: string): string | null {
  try { return (JSON.parse(raw) as any)?.[key] ?? null; } catch { return null; }
}

async function deepHealth(env: Env) {
  // surface the AI circuit breaker: "ai: true" only means the binding exists
  const aiHalt = await env.CACHE.get("ai:halt").catch(() => null);
  const aiFailure = await env.CACHE.get("ai:last-failure").catch(() => null);
  const t0 = Date.now();
  const out: Record<string, any> = { version: "1.0.0", at: new Date().toISOString(), checks: {} as any };
  const C = out.checks as Record<string, any>;

  // 1. D1 write + read
  try {
    const probe = `health:${Date.now()}`;
    await env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`).bind("__health", probe, Date.now()).run();
    const row = await env.DB.prepare(`SELECT value FROM flags WHERE key='__health'`).first<{ value: string }>();
    C.d1 = { ok: row?.value === probe, tables: (await env.DB.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'`).first<{ c: number }>())?.c ?? 0 };
  } catch (e: any) { C.d1 = { ok: false, error: String(e.message).slice(0, 120) }; }

  // 2. KV write + read (both namespaces) + blob round-trip
  try {
    const k = `health:${Date.now()}`;
    await env.CACHE.put(k, "cache-ok", { expirationTtl: 60 });
    await env.STATE.put(k, "state-ok", { expirationTtl: 60 });
    const blob = new TextEncoder().encode("blob-round-trip");
    const store = new (await import("./core/blobstore")).BlobStore(env);
    await store.put(`health/${k}.bin`, blob, { contentType: "application/octet-stream" });
    const back = await store.get(`health/${k}.bin`);
    const text = back ? new TextDecoder().decode(await back.arrayBuffer()) : "";
    C.kv = { ok: (await env.CACHE.get(k)) === "cache-ok" && (await env.STATE.get(k)) === "state-ok", storage_backend: store.backend, blob_roundtrip: text === "blob-round-trip" };
  } catch (e: any) { C.kv = { ok: false, error: String(e.message).slice(0, 120) }; }

  // 3. Telegram
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`).then((r) => r.json() as any);
    const hook = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`).then((r) => r.json() as any);
    C.telegram = { ok: !!res?.ok, username: res?.result?.username, webhook: hook?.result?.url ?? "" };
  } catch (e: any) { C.telegram = { ok: false, error: String(e.message).slice(0, 120) }; }

  // 4. GitHub API + rate limit
  try {
    const authed = !!env.GITHUB_TOKEN;
    const rl = await fetch("https://api.github.com/rate_limit", {
      headers: { ...(authed ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}), accept: "application/vnd.github+json", "user-agent": "GitHubLensUltra" },
    }).then((r) => r.json() as any);
    const core = rl?.resources?.core;
    const ok = !!core;
    C.github = {
      ok,
      authenticated: authed,
      core_remaining: core?.remaining,
      search_remaining: rl?.resources?.search?.remaining,
      graphql_remaining: rl?.resources?.graphql?.remaining,
      ...(ok ? {} : {
        error: String(rl?.message ?? "rate_limit call failed").slice(0, 140),
        hint: authed ? undefined : "GITHUB_TOKEN is not set: run `bash scripts/finish-migration.sh --pat ghp_…` to lift the limit from 60 to 5000 requests/hour",
      }),
    };
  } catch (e: any) { C.github = { ok: false, error: String(e.message).slice(0, 140) }; }

  // 5. Workers AI text generation (tier "fast")
  try {
    const ai = new (await import("./ai/brain")).AiBrain(env);
    const t = Date.now();
    const answer = await ai.chat("Reply with exactly: LENS-OK", { tier: "fast", max_tokens: 12, cacheKey: `health:${Date.now()}` });
    C.ai_text = { ok: /LENS-OK|LENS/i.test(answer), ms: Date.now() - t, sample: answer.slice(0, 40) };
    if (!C.ai_text.ok) {
      C.ai_text.halted = !!aiHalt;
      C.ai_text.reason = aiFailure ? safeJsonField(aiFailure, "reason") : null;
      if (aiHalt) C.ai_text.hint = "free neurons spent — clears at 00:00 UTC, or set OPENAI_COMPAT_KEY, or POST /health?ai=reset";
    }
  } catch (e: any) { C.ai_text = { ok: false, error: String(e.message).slice(0, 140) }; }

  // 6. Embeddings (1024-dim bge-m3) — stored in D1, so search works without
  //    a Vectorize index; the key is named for what it means, not the product.
  try {
    const ai = new (await import("./ai/brain")).AiBrain(env);
    const v = await ai.embedOne("test");
    C.embeddings = { ok: v.length > 100, dimensions: v.length };
    if (env.INDEX) {
      try {
        const q = await env.INDEX.query(v, { topK: 1 } as any);
        C.semantic_search = { ok: true, matches: q.matches?.length ?? 0, backend: "vectorize" };
      } catch (e: any) { C.semantic_search = { ok: false, error: String(e.message).slice(0, 120) }; }
    } else {
      C.semantic_search = { ok: true, backend: "d1-cosine", note: "vectors live in D1; no Vectorize index needed" };
    }
  } catch (e: any) { C.embeddings = { ok: false, error: String(e.message).slice(0, 120) }; }

  // 7. Queue producer
  try {
    await env.JOBS.send({ type: "refresh_meta", full_name: "cloudflare/workers-sdk" } as any);
    C.queue = { ok: true };
  } catch (e: any) { C.queue = { ok: false, error: String(e.message).slice(0, 120) }; }

  // 8. Durable Object
  try {
    const id = env.SESSION.idFromName("health-check");
    const stub: any = env.SESSION.get(id);
    await stub.bump("health", 1);
    C.durable_object = { ok: true };
  } catch (e: any) { C.durable_object = { ok: false, error: String(e.message).slice(0, 120) }; }

  // There is no check 9: the whole audio chain was removed by owner
  // instruction, so there is nothing speech-shaped left to probe.

  out.ms = Date.now() - t0;
  out.pass = Object.values(C).filter((c: any) => c && c.ok === false).length === 0;
  return out;
}

async function healthWithCron(env: Env) {
  return { scheduler: await cronHeartbeat(env) };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
/** Last scheduler heartbeat, written by runCron (best effort, no throw). */
async function cronHeartbeat(env: Env) {
  try {
    const row = await env.DB.prepare(`SELECT value, updated_at FROM flags WHERE key='cron:last'`)
      .first<{ value: string; updated_at: number }>();
    if (!row) return null;
    const err = await env.DB.prepare(`SELECT value FROM flags WHERE key='cron:error'`)
      .first<{ value: string }>().catch(() => null);
    return { ran: row.value, minutes_ago: Math.round((Date.now() - row.updated_at) / 60000), last_error: err?.value ?? null };
  } catch {
    return null;
  }
}

function bindingsReport(env: Env) {
  return {
    d1: !!env.DB, kv_cache: !!env.CACHE, kv_state: !!env.STATE,
    r2: !!env.FILES, storage_backend: env.FILES ? "r2" : "kv",
    queue: !!env.JOBS, ai: !!env.AI, vectorize: !!env.INDEX, analytics: !!env.ANALYTICS,
    browser: !!env.BROWSER, do: !!env.SESSION,
    secrets: {
      BOT_TOKEN: !!env.BOT_TOKEN, GITHUB_TOKEN: !!env.GITHUB_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: !!env.TELEGRAM_WEBHOOK_SECRET,
      GITHUB_WEBHOOK_SECRET: !!env.GITHUB_WEBHOOK_SECRET,
      HELPER_REPO_TOKEN: !!env.HELPER_REPO_TOKEN,
    },
  };
}
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * The worker's front door.
 *
 * It is the page a stranger lands on when someone shares the deployment, so it
 * has exactly one job: say what the bot is, prove it is alive, and hand over the
 * bot link. Everything here is server-rendered and dependency-free — no CDN, no
 * fonts, no build step — and the two images are pulled from the repository so
 * the deployment gains a face without shipping a static-asset pipeline.
 */
function landing(env: Env) {
  const bot = botUsername(env);
  const repo = "Alisarani7021/ghlens-ultra";
  const raw = `https://raw.githubusercontent.com/${repo}/main/docs/assets`;
  const health = `${env.WORKER_URL ?? ""}/health`;
  const year = new Date().getFullYear();

  const fa = [
    ["جستوجوی معنایی", "بدون کلیدواژه: «یک کتابخانهٔ سبک برای صف در Go» را می‌فهمد. بردارها در D1، بدون سرویس بیرونی."],
    ["کاوش ۱۲ تبی", "رشد، ضریب اتوبوس، نرخ مرج، دارایی‌های انتشار، CI و امنیت — از یک کوئری GraphQL."],
    ["هوش مصنوعی چندمدلی", "۱۱ مدل در سه رده + ردهٔ چندمدلی (موازی، داور، سنتز). چت با مخزن همراه با استناد."],
    ["دانلود و امنیت", "دانلود مستقیم با تقسیم جریانی · اسکن وابستگی با OSV · شکار کلید لو‌رفته · هشدار CVE."],
    ["هاب رویدادمحور", "رویداد می‌گیرد، ورک‌فلو اجرا می‌کند، پیش‌نویس پست می‌سازد و فقط با تأیید تو منتشر می‌کند."],
    ["۵ زبان، ۹۳ فرمان", "فارسی · انگلیسی · عربی · روسی · چینی — رابط، خطاها و راهنما، همه ترجمه‌شده."],
  ] as const;

  const en = [
    ["Semantic search", "No keywords needed — embeddings live in D1, so it works without a vector service."],
    ["12-tab dossier", "Growth, bus factor, merge rate, release assets, CI and security from one GraphQL query."],
    ["Multi-model AI", "11 models in three tiers plus a jury tier. Repo chat answers with citations."],
    ["Download &amp; audit", "Streaming split downloads · OSV dependency scans · leaked-key hunt · CVE alerts."],
    ["Event-driven hub", "Takes events, runs workflows, drafts the post — and publishes only when you approve."],
    ["5 languages, 93 commands", "Persian · English · Arabic · Russian · Chinese, UI and errors included."],
  ] as const;

  const card = (list: readonly (readonly [string, string])[]) =>
    list.map(([t, d]) =>
      `<div class="feat"><b>${t}</b><span>${d}</span></div>`).join("");

  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GitHub Lens Ultra — ربات کشف و تحلیل اوپن‌سورس</title>
<meta name="description" content="ربات تلگرامِ کاوش، تحلیل، ترجمه، امنیت و دانلود اوپن‌سورس + هاب رویدادمحور — کاملاً روی Cloudflare.">
<meta property="og:title" content="GitHub Lens Ultra">
<meta property="og:description" content="کاوش، تحلیل، ترجمه و دانلود اوپن‌سورس در تلگرام — با هاب رویدادمحور و دروازهٔ تأیید انسانی.">
<meta property="og:image" content="${raw}/hero.jpg">
<meta name="theme-color" content="#070b14">
<style>
:root{--bg:#070b14;--fg:#e8f0fa;--mut:#93a4bd;--acc:#4de2ff;--acc2:#a6ff6b;--line:#1b2637;--card:#0d1524}
*{box-sizing:border-box}
body{margin:0;background:
  radial-gradient(900px 520px at 88% -8%,rgba(77,226,255,.16),transparent 62%),
  radial-gradient(760px 520px at 6% 8%,rgba(166,255,107,.12),transparent 60%),var(--bg);
  color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;line-height:1.85;
  min-height:100vh;padding:28px 18px 40px}
.wrap{max-width:900px;margin:0 auto}
.hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.mark{width:76px;height:76px;border-radius:22px;border:1px solid var(--line);background:#0b1220;object-fit:cover}
h1{margin:0;font-size:clamp(26px,5vw,40px);letter-spacing:-.4px}
h1 span{background:linear-gradient(96deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{margin:2px 0 0;color:var(--mut);font-size:15px}
.banner{margin:26px 0 22px;border-radius:20px;border:1px solid var(--line);width:100%;display:block;
  box-shadow:0 26px 60px rgba(0,0,0,.5)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:12px;margin:22px 0 26px}
.feat{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.02));border:1px solid var(--line);
  border-radius:16px;padding:15px 16px}
.feat b{display:block;color:var(--acc);font-size:15px;margin-bottom:4px}
.feat span{color:var(--mut);font-size:13.5px;line-height:1.75}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}
a.btn{flex:1 1 240px;text-align:center;padding:15px 20px;border-radius:14px;text-decoration:none;font-weight:800;font-size:16px;
  background:linear-gradient(96deg,var(--acc),var(--acc2));color:#04141a;transition:transform .15s}
a.btn.alt{background:var(--card);border:1px solid var(--line);color:var(--fg)}
a.btn:active{transform:scale(.98)}
.foot{color:#6d7c92;font-size:13px;border-top:1px solid var(--line);padding-top:16px;display:flex;flex-wrap:wrap;gap:8px 18px}
a{color:var(--acc)}
code{background:#0b1220;border:1px solid var(--line);padding:1px 6px;border-radius:6px;font-size:12.5px}
.en{direction:ltr;text-align:left;margin-top:26px;color:var(--mut);font-size:13.5px}
.en b{color:var(--fg)}
</style></head><body><div class="wrap">

<div class="hero">
  <img class="mark" src="${raw}/avatar-web.png" alt="GitHub Lens Ultra" loading="lazy">
  <div>
    <h1>GitHub <span>Lens Ultra</span></h1>
    <p class="tag">کاوش، تحلیل، ترجمه، امنیت و دانلود اوپن‌سورس — به‌همراه هاب رویدادمحور با دروازهٔ تأیید انسانی.</p>
  </div>
</div>

<img class="banner" src="${raw}/hero.jpg" alt="GitHub Lens Ultra — an open-source observatory" loading="lazy">

<div class="grid">${card(fa)}</div>

<img class="banner" src="${raw}/sections.jpg" alt="بخش‌های بیشتر ربات" loading="lazy">

<div class="row">
  <a class="btn" href="https://t.me/${bot}">🚀 باز کردن ربات در تلگرام</a>
</div>

<div class="foot">
  <span>✅ سرویس‌ورکر فعال — <a href="${health}">${health}</a></span>
  <span>🗄 ۳۳ جدول D1 · ⚙️ ۹۳ فرمان · ✅ ۲۶۲ تست</span>
  <span>💻 <a href="https://github.com/${repo}">github.com/${repo}</a></span>
  <span>© ${year}</span>
</div>

<div class="en">
  <b>GitHub Lens Ultra</b> — an open-source observatory for Telegram: semantic search, 12-tab repository dossiers,
  multi-model AI with cited repo chat, streaming downloads with OSV security scans, and an event-driven hub that
  drafts channel posts and waits for a human. Entirely on Cloudflare Workers.
  <br>93 commands · 33 D1 tables · 345 tests · 5 languages · <a href="https://t.me/${bot}">open the bot</a>
</div>

</div></body></html>`;
}

// ─── GitHub token storage (AES-GCM, never plaintext in D1) ─────────────────

/** Derive a 256-bit key from the deployment secret (HKDF-SHA256). */
export async function signState(env: Env, userId: number): Promise<string> {
  const payload = `${userId}.${Date.now()}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "").slice(0, 32);
  return `${payload}.${b64}`;
}

export async function verifyState(env: Env, state: string): Promise<number | null> {
  const [uid, ts, sig] = state.split(".");
  if (!uid || !ts || !sig) return null;
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;      // 15 minute window
  const expect = await signState(env, Number(uid));
  return expect.split(".")[2] === sig ? Number(uid) : null;
}

/** GET /user with a token → login name, or null when the token is rejected. */
export async function whoamiWithToken(token: string): Promise<{ login: string; scopes: string | null; remaining?: number } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "GitHubLensUltra/1.0" },
  });
  if (!res.ok) return null;
  const u: any = await res.json();
  return { login: u.login, scopes: res.headers.get("x-oauth-scopes"), remaining: Number(res.headers.get("x-ratelimit-remaining") ?? 0) };
}

/** Save a verified token for the user (encrypted) and reply with the result. */
export async function completeLink(h: H, token: string): Promise<void> {
  const fa = h.loc === "fa";
  const me = await whoamiWithToken(token);
  if (!me) {
    return void (await h.reply(
      fa ? "❌ توکن نامعتبر است یا منقضی شده. دوباره بساز و بفرست (/login)." : "❌ Invalid or expired token.",
      kb([[{ text: "🔁 " + (fa ? "تلاش دوباره" : "Retry"), cb: "me:token" }], [{ text: "◀️", cb: "me:home" }]]),
    ));
  }
  const enc = await encryptToken(h.env, token);
  await h.env.DB.prepare(
    `UPDATE users SET github_login=?, github_token_enc=?, github_token_at=? WHERE id=?`,
  ).bind(me.login, enc, Date.now(), h.u.id).run();
  // forget the wizard state and the user's message is theirs to delete
  await h.session?.set("me:token", false);
  await h.reply(
    `✅ <b>${fa ? "حساب گیت‌هاب وصل شد" : "GitHub linked"}</b> — <a href="https://github.com/${tgEscape(me.login)}">@${tgEscape(me.login)}</a>\n\n` +
      (fa
        ? `سقف درخواست تو الان <b>${me.remaining ?? 5000}</b> در ساعت است و همهٔ قابلیت‌ها باز شد.\n\n` +
          `👉 <b>حالا یک بار دیگر /start را بزن</b> تا همه‌چیز کامل بالا بیاید.\n` +
          `<i>برای امنیت، پیام حاوی توکن را پاک کن (نگه‌دار → Delete). خروج: /logout</i>`
        : `Your limit is now ${me.remaining ?? 5000}/hour and everything is unlocked.\n\n` +
          `👉 <b>Press /start once more</b> so the whole thing comes up.\n` +
          `<i>Delete the message with your token. /logout to disconnect.</i>`),
    kb(
      [{ text: "🚀 " + (fa ? "دوباره /start" : "Press /start again"), cb: "m:start" }],
      
    ),
    true,
  );
  // the old bottom keyboard has no business surviving the new flow
  const strip = await h.tg.sendMessage(h.chatId, "🧹", { reply_markup: { remove_keyboard: true } as any }).catch(() => null);
  const stripId = (strip as any)?.result?.message_id ?? (strip as any)?.message_id;
  if (stripId) await h.tg.deleteMessage(h.chatId, stripId).catch(() => null);
}

/** Kept as named aliases so existing call sites keep working. */
export const encryptToken = (env: Env, plain: string) => encryptSecret(env, plain, "github-token");
export const decryptToken = (env: Env, packedB64: string) => decryptSecret(env, packedB64, "github-token");
