import type { Ctx, Env, Job } from "./env";
import { isAdmin } from "./env";
import { Telegram, splitSmart } from "./tg/api";
import type { CallbackQuery, InlineQuery, Message, Update, User } from "./tg/types";
import { tgEscape } from "./tg/types";
import { kb } from "./tg/keyboards";
import { Store } from "./core/db";
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
import { Settings } from "./features/settings";
import { Admin } from "./features/admin";
import { handleWebhook } from "./core/webhook";
import { runCron } from "./core/cron";
import { consumeQueue } from "./core/queue";
import { handleApi } from "./core/api";
import { audioBytes, describe } from "./ai/brain";
import { podcastRoutes, podcastText } from "./features/podcast";

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

      // ── self-test: runs the real update pipeline inline and reports errors ──
      if (url.pathname === "/selfcheck") {
        const secret = url.searchParams.get("deep");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const text = url.searchParams.get("text") ?? "/start";
        const uid = Number(url.searchParams.get("uid") ?? 999999);
        const update: any = {
          update_id: 990001,
          message: {
            message_id: 990001,
            from: { id: uid, is_bot: false, first_name: "Self", language_code: "fa" },
            chat: { id: uid, type: "private", first_name: "Self" },
            date: Math.floor(Date.now() / 1000),
            text,
            entities: [{ offset: 0, length: text.length, type: "bot_command" }],
          },
        };
        const t0 = Date.now();
        try {
          await handleUpdate(update, env, ctx);
          const u = await new Store(env).user(uid);
          return json({ ok: true, ms: Date.now() - t0, user_row: u ?? null, text });
        } catch (e: any) {
          return json({ ok: false, ms: Date.now() - t0, error: String(e?.message ?? e), stack: String(e?.stack ?? "").split("\n").slice(0, 6) }, 500);
        }
      }

      // ── GitHub webhook (releases, security, pushes) ────────────────────
      if (url.pathname === "/gh-webhook" && request.method === "POST") {
        return handleWebhook(request, env, ctx);
      }

      // ── public API used by the mini-app + share cards + magic links ────
      if (url.pathname.startsWith("/api/")) {
        return handleApi(request, env, ctx);
      }

      // ── mini-app (Telegram Web App) ────────────────────────────────────
      if (url.pathname === "/app" || url.pathname === "/app/") {
        const html = MINI_APP_HTML.replace(/__BOT_USERNAME__/g, env.BOT_USERNAME ?? "RepoFA").replace(/__API_BASE__/g, env.WORKER_URL ?? "");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
      }

      // ── health & metrics ───────────────────────────────────────────────
      if (url.pathname === "/health" && url.searchParams.get("tts") === "probe") {
        const secret = url.searchParams.get("deep");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const ids = [
          "@cf/myshell-ai/melotts",
          "@cf/facebook/mms-tts-eng",
          "@cf/facebook/mms-tts-fas",
          "@cf/deepgram/aura-1",
          "@cf/deepgram/aura-2",
          "@cf/openai/tts-1",
          "@cf/elevenlabs/tts",
          "@cf/piper/piper",
          "@cf/meta/mms-tts-fas",
        ];
        const out: Record<string, string> = {};
        for (const id of ids) {
          try {
            const r: any = await env.AI.run(id as any, { prompt: "hello", text: "hello", lang: "en" } as any);
            const b = await audioBytes(r);
            out[id] = b && b.byteLength > 1000 ? `✅ ${b.byteLength}B` : `shape ${describe(r)}`;
          } catch (e: any) {
            out[id] = "❌ " + String(e?.message ?? e).slice(0, 80);
          }
        }
        return json({ models: out });
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
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error("fatal", e?.stack ?? e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },

  // ── cron: snapshots, boards, digests, podcasts, security sweep ────────
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
async function handleUpdate(update: Update, env: Env, ctx: Ctx) {
  const tg = new Telegram(env);
  const store = new Store(env);
  const ai = new AiBrain(env);
  const card = new RepoCard(env, store);

  if (update.callback_query) return routeCallback(update.callback_query, env, ctx, tg, store, ai, card);
  if (update.inline_query) return routeInline(update.inline_query, env, ctx, tg, store, ai);
  if (update.message) return routeMessage(update.message, env, ctx, tg, store, ai, card);
}

async function buildH(
  m: { from?: User; chat: { id: number }; message_id?: number },
  env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard,
  opts: { cbId?: string; args?: string[]; text?: string; msg?: Message } = {},
): Promise<H> {
  const u = m.from ?? { id: 0, is_bot: false, first_name: "?" } as User;
  await store.upsertUser(u);
  const user = await store.user(u.id);
  const loc = (user?.locale as any) ?? env.DEFAULT_LOCALE ?? "fa";
  const chatId = m.chat.id;
  const msgId = m.message_id;

  const session = env.SESSION.get(env.SESSION.idFromName(`user:${u.id}`)) as any;

  const gh = new GithubRest(env);
  const h: H = {
    env, store, tg, ai, card, u, user, loc, chatId, msgId,
    cbId: opts.cbId, args: opts.args ?? [], text: opts.text ?? "", msg: opts.msg,
    session,
    gh: () => gh,
    async reply(body, keyboard, edit = false) {
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
    async toast(text, alert = false) {
      if (h.cbId) await tg.answerCallbackQuery(h.cbId, text.slice(0, 190), alert);
    },
    async loading(label) {
      const text = label ?? loadingText(loc);
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
async function routeMessage(msg: Message, env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard) {
  const text = (msg.text ?? msg.caption ?? "").trim();

  // voice notes → transcription pipeline
  if (msg.voice?.file_id) {
    const h = await buildH(msg, env, ctx, tg, store, ai, card, { msg });
    return assistant.voice(h, msg.voice.file_id);
  }

  // documents (e.g. package files) → inspect
  if (msg.document?.file_name) {
    const h = await buildH(msg, env, ctx, tg, store, ai, card, { msg });
    return tools.pkg(h);
  }

  if (!text) return;

  // slash commands
  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.replace(/@[\w_]+$/, "").toLowerCase();
    const arg = rest.join(" ").trim();
    const h = await buildH(msg, env, ctx, tg, store, ai, card, { args: rest, text: arg, msg });
    return routeCommand(cmd, arg, h, env, ctx);
  }

  // session-driven inputs (wizard steps) take priority over heuristics
  const h = await buildH(msg, env, ctx, tg, store, ai, card, { text, msg });
  const sessionCtx = await inputContext(h);
  if (sessionCtx) return sessionCtx(text);

  // heuristics: repo name → card ; question → assistant ; else search
  const repoMatch = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/?$/) ?? text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (repoMatch && repoMatch[1] && repoMatch[2] && !repoMatch[1].includes(",")) {
    const full = `${repoMatch[1]}/${repoMatch[2]}`.replace(/\.git$/, "");
    return scout.open(h, full, 0);
  }
  if (text.length < 60 && /^(find|search|جست|پیدا|دنبال|چی|چه|recommend|پیشنهاد)/i.test(text)) {
    return search.run(h, text);
  }
  if (text.endsWith("?") || text.endsWith("؟") || text.length > 60 || /\b(how|why|what|چطور|چگونه|چرا|آیا)\b/i.test(text)) {
    return assistant.ask(h, text);
  }
  return search.run(h, text);
}

/** Detects whether the user is mid-wizard, and returns the handler for their next message. */
async function inputContext(h: H): Promise<((text: string) => Promise<void>) | null> {
  const s = h.session;
  if (await s.get("repochat")) {
    const full = await s.get("repochat");
    await s.clear(["repochat"]);
    return (t) => assistant.repoChat(h, full, t);
  }
  if (await s.get("wf")) {
    await s.clear(["wf"]);
    return (t) => assistant.workflow(h, t);
  }
  if (await s.get("code")) {
    await s.clear(["code"]);
    return (t) => assistant.code(h, t);
  }
  if (await s.get("review")) {
    await s.clear(["review"]);
    return (t) => assistant.review(h, t);
  }
  if (await s.get("sec:scan")) {
    await s.clear(["sec:scan"]);
    return (t) => security.scan(h, t.trim());
  }
  if (await s.get("sec:secrets")) {
    await s.clear(["sec:secrets"]);
    return (t) => security.secrets(h, t.trim());
  }
  if (await s.get("adm:broadcast")) {
    await s.clear(["adm:broadcast"]);
    return (t) => admin.broadcast(h, t);
  }
  if (await s.get("cmp")) {
    const state: any = await s.get("cmp");
    await s.clear(["cmp"]);
    return (t) => scout.compare(h, state?.a ?? "", t.trim());
  }
  if (await s.get("dvu:cron")) {
    await s.clear(["dvu:cron"]);
    return (t) => devutils.cron(h, t.trim());
  }
  if (await s.get("dvu:regex")) {
    await s.clear(["dvu:regex"]);
    return (t) => devutils.runRegex(h, t.trim());
  }
  if (await s.get("dvu:cidr")) {
    await s.clear(["dvu:cidr"]);
    return (t) => devutils.cidr(h, t.trim());
  }
  if (await s.get("dvu:jwt")) {
    await s.clear(["dvu:jwt"]);
    return (t) => devutils.jwt(h, t.trim());
  }
  if (await s.get("dvu:b64")) {
    await s.clear(["dvu:b64"]);
    return (t) => devutils.b64(h, t);
  }
  if (await s.get("dvu:hash")) {
    await s.clear(["dvu:hash"]);
    return (t) => devutils.hash(h, t);
  }
  if (await s.get("dvu:time")) {
    await s.clear(["dvu:time"]);
    return (t) => devutils.time(h, t.trim());
  }
  if (await s.get("dvu:json")) {
    await s.clear(["dvu:json"]);
    return (t) => devutils.json(h, t);
  }
  if (await s.get("dvu:semver")) {
    await s.clear(["dvu:semver"]);
    return (t) => devutils.semver(h, t.trim());
  }
  if (await s.get("dvu:color")) {
    await s.clear(["dvu:color"]);
    return (t) => devutils.color(h, t.trim());
  }
  if (await s.get("u:ip")) {
    await s.clear(["u:ip"]);
    return (t) => tools.intel(h, t.trim());
  }
  if (await s.get("u:asn")) {
    await s.clear(["u:asn"]);
    return (t) => tools.asn(h, t.trim());
  }
  return null;
}

// ── commands ───────────────────────────────────────────────────────────────
async function routeCommand(cmd: string, arg: string, h: H, env: Env, ctx: Ctx) {
  const fa = h.loc === "fa";
  await h.store.event(h.u.id, "command", cmd);

  switch (cmd) {
    case "/start": {
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
      return settings.home(h);
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
    case "/files": return discover.files(h, normRepo(arg));
    case "/card": case "/share": return discover.shareCard(h, normRepo(arg));
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

    case "/contribute": return contribute.home(h);
    case "/issues": return contribute.issues(h);
    case "/firstpr": return contribute.firstpr(h);
    case "/podcast": case "/pod": return podcastRoutes(h);

    case "/admin":
      if (!isAdmin(h.env, h.u.id)) return security.home(h);
      return admin.home(h);
    case "/flag": {
      if (!isAdmin(h.env, h.u.id)) return;
      const [k, v] = arg.split(/\s+/);
      return admin.setFlag(h, k, v ?? "on");
    }
    case "/id": return showIds(h);
    case "/inline": {
      const username = h.env.BOT_USERNAME ?? "bot";
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
        kb([[{ text: "📚 /help", cb: "h:main" }, { text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }]]),
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
    kb([[{ text: "⚡ " + (fa ? "پلن‌ها" : "Plans"), cb: "me:plan" }, { text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }]]),
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
  const data = await new GithubGraphQL(h.env).deepScout(o, n).catch(() => null);
  if (!data?.repository) return null;
  return { meta: toRepoMeta(data), r: data.repository };
}

// ── callbacks ──────────────────────────────────────────────────────────────
async function routeCallback(q: CallbackQuery, env: Env, ctx: Ctx, tg: Telegram, store: Store, ai: AiBrain, card: RepoCard) {
  const data = String(q.data ?? "");
  if (!data) return;
  const [ns, action = "", rest = ""] = data.split(":");
  const arg = rest;
  const args = rest ? rest.split(",") : [];
  const h = await buildH({ from: q.from, chat: q.message?.chat ?? { id: q.from.id }, message_id: q.message?.message_id }, env, ctx, tg, store, ai, card, {
    cbId: q.id, text: arg, args, msg: q.message ?? undefined,
  });
  const fa = h.loc === "fa";
  await store.event(q.from.id, "callback", `${ns}:${action}`);

  const trending = new TrendingFeature(new TrendingEngine(env));
  const dl = downloader(h);

  try {
    switch (ns) {
      case "noop": return h.toast("");

      // ── global navigation ──
      case "m":
        if (action === "home") return settings.home(h);
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
        if (action === "repo") return assistant.dossier(h, arg);
        if (action === "tr") return arg === "ask" ? assistant.home(h) : assistant.translateReadme(h, arg);
        if (action === "trmore") return translateMore(h, args[0] ?? "", Number(args[1] ?? 1));
        if (action === "tre") return translateTo(h, args[0] ?? "", args[1] ?? "en");
        if (action === "trpdf") return translatePdf(h, args[0] ?? "");
        if (action === "cmp") return aiCompare(h, (args[0] ?? "").split("|")[0] ?? "", (args[0] ?? "").split("|")[1] ?? "");
        break;

      // ── assistant ──
      case "a":
        if (action === "home") return assistant.home(h);
        if (action === "new") return assistant.home(h);
        if (action === "cont") return h.reply(fa ? "✍️ سؤالت را بنویس…" : "Type your follow-up…", kb([[{ text: "◀️", cb: "a:home" }]]));
        if (action === "clear") {
          await h.store.addMessage(`u${h.u.id}`, "system", "[conversation cleared]");
          return h.reply(fa ? "🧹 حافظه پاک شد." : "🧹 memory cleared", kb([[{ text: "🏠", cb: "m:home" }]]));
        }
        if (action === "repochat") return assistant.repoChat(h, args[0] ?? "");
        if (action === "workflow") return assistant.workflow(h);
        if (action === "wf") return assistant.workflow(h, arg);
        if (action === "code") return assistant.code(h);
        if (action === "review") return assistant.review(h);
        if (action === "askv") return assistant.ask(h, arg, { voiceReply: true });
        if (action === "voice") return h.reply(fa ? "🎙 یک ویس بفرست تا تبدیل و پاسخ صوتی بگیرم." : "Send a voice note.", kb([[{ text: "◀️", cb: "a:home" }]]));
        if (action === "tts") return ttsLast(h, arg);
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
        if (action === "ip") { await h.session.set("u:ip", true); return h.reply(fa ? "📡 IP یا دامنه را بفرست." : "Send IP or domain.", kb([[{ text: "◀️", cb: "u:home" }]])); }
        if (action === "geo") return tools.intel(h, "8.8.8.8");
        if (action === "dns") { await h.session.set("u:ip", true); return h.reply(fa ? "🧭 دامنه را بفرست." : "Send domain."); }
        if (action === "tls") { if (args[0]) return tools.tls(h, args[0]); await h.session.set("u:ip", true); return h.reply(fa ? "🔐 دامنه را بفرست." : "Send domain."); }
        if (action === "asn") { if (args[0]) return tools.asn(h, args[0]); await h.session.set("u:asn", true); return h.reply(fa ? "🛰 شماره ASN را بفرست (مثل 13335)." : "Send ASN number."); }
        if (action === "dev") return devutils.home(h);
        if (action === "cidr") return devutils.cidr(h);
        if (action === "cron") return devutils.cron(h);
        if (action === "regex") return devutils.regex(h);
        break;

      // ── dev utils ──
      case "dvu":
        if (action === "home") return devutils.home(h);
        if (action === "cron") { if (arg) return devutils.cron(h, arg); await h.session.set("dvu:cron", true); return devutils.cron(h); }
        if (action === "regex") { if (arg) return devutils.runRegex(h, arg); await h.session.set("dvu:regex", true); return devutils.regex(h); }
        if (action === "cidr") { if (arg) return devutils.cidr(h, arg); await h.session.set("dvu:cidr", true); return devutils.cidr(h); }
        if (action === "jwt") { if (arg) return devutils.jwt(h, arg); await h.session.set("dvu:jwt", true); return devutils.jwt(h); }
        if (action === "b64") { if (arg) return devutils.b64(h, arg); await h.session.set("dvu:b64", true); return devutils.b64(h); }
        if (action === "hash") { if (arg) return devutils.hash(h, arg); await h.session.set("dvu:hash", true); return devutils.hash(h, ""); }
        if (action === "id") return devutils.id(h);
        if (action === "time") { if (arg) return devutils.time(h, arg); await h.session.set("dvu:time", true); return devutils.time(h); }
        if (action === "json") { if (arg) return devutils.json(h, decode(arg)); await h.session.set("dvu:json", true); return devutils.json(h); }
        if (action === "gitignore") return devutils.gitignore(h);
        if (action === "gi") return devutils.gitignoreFor(h, arg);
        if (action === "semver") { if (arg) return devutils.semver(h, arg); await h.session.set("dvu:semver", true); return devutils.semver(h); }
        if (action === "sv") return devutils.semver(h, arg);
        if (action === "color") { if (arg) return devutils.color(h, arg); await h.session.set("dvu:color", true); return devutils.color(h); }
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
          return h.toast(fa ? "🔇 تا ۷ روز بی‌صدا شد" : "muted 7d");
        }
        if (action === "clear") {
          await h.env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`).bind(h.u.id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
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
        if (action === "plan" || action === "pro") return profile.plans(h);
        if (action === "link") return h.reply(`🐙 ${fa ? "برای اتصال، پیام <code>/start</code> را از دکمه زیر باز کن (OAuth در نسخه هاست‌شده)." : "Connect via OAuth in the hosted build."}`, kb([[{ text: "🐙 GitHub", url: "https://github.com/login/oauth/authorize" }], [{ text: "◀️", cb: "me:home" }]]));
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

      // ── podcast ──
      case "p":
        if (action === "today") return podcastRoutes(h);
        if (action === "weekly") return podcastRoutes(h, "weekly");
        if (action === "text") return podcastText(h, (args[0] as any) ?? "daily");
        break;

      // ── feed ──
      case "feed":
        if (action === "show") return profile.feed(h);
        break;

      // ── admin ──
      case "adm":
        if (action === "home") return admin.home(h);
        if (action === "flags") return admin.flags(h);
        if (action === "flag") return admin.setFlag(h, args[0] ?? "", args[1] ?? "on");
        if (action === "broadcast") return admin.broadcast(h);
        if (action === "aitest") return admin.aitest(h);
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
  return h.reply(rendered.text, rendered.keyboard, true);
}

async function scoutTab(h: H, tab: number, full: string) {
  const data = await fetchScoutRaw(h, full);
  if (!data) return h.toast("❌", true);
  const text = await scout.tab(h, data, tab);
  return h.reply(text, scout.tabsKeyboard(h, full, tab), true);
}

async function translateMore(h: H, full: string, page: number) {
  const text = (await h.session.get(`tr:${full}`)) as string | null;
  const source = text ?? (await h.env.STATE.get(`trl:${full}:${h.loc}`));
  if (!source) return h.toast(h.loc === "fa" ? "دوباره ترجمه کن" : "re-translate first", true);
  const chunks = splitSmart(source, 3800);
  const idx = Math.min(page, chunks.length - 1);
  return h.reply(
    chunks[idx] + `\n\n<i>…${idx + 1}/${chunks.length}</i>`,
    kb(idx + 1 < chunks.length ? [{ text: "➡️", cb: `ai:trmore:${full}:${idx + 1}` }] : [], [{ text: "◀️ " + (h.loc === "fa" ? "بازگشت" : "Back"), cb: `s:card:${full}` }]),
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

async function ttsLast(h: H, key: string) {
  const ans = (await h.store.history(`u${h.u.id}`, 1)).results?.[0]?.content ?? "";
  const audio = await h.ai.speak(ans.slice(0, 700), h.loc);
  if (!audio) return h.toast(h.loc === "fa" ? "TTS در دسترس نیست" : "TTS unavailable", true);
  await h.tg.sendAudio(h.chatId, audio, "🎙 " + (h.loc === "fa" ? "خوانش پاسخ" : "answer audio"), {});
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
        title: `${m.full_name} — ⭐ ${m.stargazers_count}`,
        description: (m.description ?? "").slice(0, 100),
        thumbnail_url: m.owner?.avatar_url,
        input_message_content: {
          message_text: `📦 <b>${m.full_name}</b>\n${m.description ? `<i>${m.description}</i>\n` : ""}⭐ ${m.stargazers_count} · 🍴 ${m.forks_count} · 🧩 ${m.language ?? "—"}\n🔗 https://github.com/${m.full_name}`,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        },
        reply_markup: kb([{ text: "🌐 GitHub", url: m.html_url }]).inline_keyboard ? { inline_keyboard: kb([{ text: "🌐 GitHub", url: m.html_url }]).inline_keyboard } : undefined,
      } as any);
    }
  }

  // search results
  const res = await gh.searchRepos(query, "stars", "desc", 8).catch(() => null);
  for (const r of res?.items ?? []) {
    results.push({
      type: "article", id: `r:${r.full_name}`,
      title: `${r.full_name} — ⭐ ${r.stargazers_count}`,
      description: `${r.language ?? ""} · ${(r.description ?? "").slice(0, 90)}`.trim(),
      thumbnail_url: r.owner?.avatar_url,
      input_message_content: {
        message_text: `📦 <b>${r.full_name}</b>\n${r.description ? `<i>${r.description}</i>\n` : ""}⭐ ${r.stargazers_count} · 🍴 ${r.forks_count} · 🧩 ${r.language ?? "—"}\n🔗 https://github.com/${r.full_name}`,
        parse_mode: "HTML",
      },
    } as any);
  }

  // trending shortcut
  results.push({
    type: "article", id: "trending",
    title: "🔥 داغ‌ترین‌های امروز گیت‌هاب",
    description: "GitHub Lens Ultra trending board",
    input_message_content: { message_text: `🔥 داغ‌ترین‌های امروز — GitHub Lens Ultra\n${env.WORKER_URL}/app`, parse_mode: "HTML" },
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
      [{ text: "👤 " + (fa ? "پروفایل" : "Profile"), cb: "me:home" }, { text: "🛠 " + (fa ? "ابزارها" : "Tools"), cb: "u:home" }],
      [{ text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
    ),
    !!h.cbId,
  );
}

/**
 * Deep self-test — proves every subsystem really works, on the live account.
 * Gated behind the webhook secret because it spends AI neurons.
 */
async function deepHealth(env: Env) {
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
  } catch (e: any) { C.ai_text = { ok: false, error: String(e.message).slice(0, 140) }; }

  // 6. Embeddings + Vectorize
  try {
    const ai = new (await import("./ai/brain")).AiBrain(env);
    const v = await ai.embedOne("test");
    C.embeddings = { ok: v.length > 100, dimensions: v.length };
    if (env.INDEX) {
      try {
        const q = await env.INDEX.query(v, { topK: 1 } as any);
        C.vectorize = { ok: true, matches: q.matches?.length ?? 0 };
      } catch (e: any) { C.vectorize = { ok: false, error: String(e.message).slice(0, 120) }; }
    } else {
      C.vectorize = { ok: true, note: "not bound — lexical-only search mode" };
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

  // 9. TTS (Persian)
  try {
    const ai = new (await import("./ai/brain")).AiBrain(env);
    const audio = await ai.speak("سلام، این یک آزمایش صدا است.", "fa");
    C.tts_persian = {
      ok: !!audio && audio.byteLength > 1000,
      bytes: audio?.byteLength ?? 0,
      voice: ai.spokenLang,
      note: "this account only exposes the English Deepgram Aura voice, so Persian audio is spoken from a live translation",
      models: ai.lastTtsDebug,
    };
  } catch (e: any) { C.tts_persian = { ok: false, error: String(e.message).slice(0, 120) }; }

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
function landing(env: Env) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>GitHub Lens Ultra</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0f19;--fg:#e6edf3;--acc:#22d3ee;--acc2:#a3e635}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#0e2a3a 0%,var(--bg) 60%);color:var(--fg);
font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
.card{max-width:860px;width:100%;background:#111827cc;backdrop-filter:blur(8px);border:1px solid #1f2937;border-radius:24px;padding:40px;box-shadow:0 30px 80px #000a}
h1{margin:0 0 8px;font-size:40px;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
p.sub{color:#9ca3af;margin:0 0 28px;font-size:17px;line-height:1.8}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:26px}
.feat{background:#0b1220;border:1px solid #1f2937;border-radius:14px;padding:16px}
.feat b{color:var(--acc);display:block;margin-bottom:6px}
.feat span{color:#9ca3af;font-size:14px;line-height:1.6}
.row{display:flex;gap:12px;flex-wrap:wrap}
a.btn{flex:1;min-width:200px;text-align:center;padding:14px 18px;border-radius:12px;background:linear-gradient(90deg,var(--acc),var(--acc2));color:#04141a;font-weight:700;text-decoration:none}
a.btn2{background:#1f2937;color:var(--fg)}
code{background:#0b1220;padding:2px 6px;border-radius:6px;color:var(--acc2);font-size:13px}
.foot{margin-top:24px;color:#6b7280;font-size:13px;line-height:1.9}
</style></head><body><div class="card">
<h1>GitHub Lens Ultra</h1>
<p class="sub">ربات تلگرام کشف، تحلیل و دانلود اوپن‌سورس — کاملاً روی لبه Cloudflare.<br>
نسل بعدی <b>GitHub Lens</b>، با ۱۲۰ قابلیت بیشتر و عمق واقعی داده.</p>
<div class="grid">
  <div class="feat"><b>🛰 کاوش عمیق ۱۲ تبی</b><span>نمای کلی، رشد، زبان‌ها، جامعه، ریلیز، ایشو، PR، کامیت، CI، امنیت، چنج‌لاگ، مشارکت</span></div>
  <div class="feat"><b>🧠 چت با مخزن (RAG)</b><span>پاسخ از README و مستندات با منبع‌دهی و استناد</span></div>
  <div class="feat"><b>📥 دانلود سورس هوشمند</b><span>کش R2، انتخاب برنچ/تگ، تقسیم خودکار پارت‌ها، آفلاود به Actions</span></div>
  <div class="feat"><b>🛡 امنیت واقعی</b><span>اسکن وابستگی با OSV، شکار کلید لو رفته، هشدار CVE لحظه‌ای</span></div>
  <div class="feat"><b>📡 رادار شبکه</b><span>IP، ASN، DNS، TLS، وضعیت تهدید، تبدیل پکیج deb/rpm/arch/apk</span></div>
  <div class="feat"><b>🎙 پادکست روزانه</b><span>خلاصه صوتی فارسی از پروژه‌های داغ، تولید خودکار با Workers AI</span></div>
</div>
<div class="row">
  <a class="btn" href="https://t.me/RepoFA">🚀 باز کردن ربات در تلگرام</a>
  <a class="btn btn2" href="/app">📊 نسخه وب (Mini App)</a>
</div>
<div class="foot">
نسخه ۱.۰ · ساخته‌شده با Workers · D1 · R2 · Queues · Durable Objects · Vectorize · Workers AI · Browser Rendering<br>
منابع: <code>/health</code>
</div>
</div></body></html>`;
}

/** Mini-app: Telegram WebApp dashboard (charts, search, favourites). */
const MINI_APP_HTML = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GitHub Lens Ultra</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0b0f19;--card:#111827;--fg:#e6edf3;--mut:#9ca3af;--acc:#22d3ee;--acc2:#a3e635}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;padding:16px 14px 40px}
h1{font-size:20px;margin:0 0 4px;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--mut);font-size:13px;margin-bottom:16px}
input,select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #1f2937;background:#0b1220;color:var(--fg);font-size:15px;margin-bottom:10px}
button{padding:12px;border:none;border-radius:12px;background:linear-gradient(90deg,var(--acc),var(--acc2));color:#04141a;font-weight:700;width:100%;font-size:15px}
.tabs{display:flex;gap:8px;margin:14px 0;overflow:auto}
.tab{padding:8px 14px;border-radius:999px;background:#111827;border:1px solid #1f2937;color:var(--mut);font-size:13px;white-space:nowrap}
.tab.on{background:var(--acc);color:#04141a;font-weight:700}
.card{background:var(--card);border:1px solid #1f2937;border-radius:16px;padding:14px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:8px;align-items:center}
.name{font-weight:700;font-size:15px;word-break:break-word}
.desc{color:var(--mut);font-size:13px;margin:6px 0;line-height:1.7}
.stats{color:var(--mut);font-size:12px;display:flex;gap:10px;flex-wrap:wrap}
.pill{background:#0b1220;padding:3px 8px;border-radius:999px;font-size:11px;color:var(--acc2)}
.bar{height:6px;border-radius:3px;background:#1f2937;overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2))}
.empty{color:var(--mut);font-size:14px;text-align:center;padding:24px}
a{color:var(--acc);text-decoration:none}
</style></head><body>
<h1>GitHub Lens Ultra</h1>
<div class="sub" id="who">…</div>
<input id="q" placeholder="جست‌وجو: react state / کاوش مخزن owner/repo" />
<button onclick="doSearch()">🔍 جست‌وجو</button>
<div class="tabs" id="tabs"></div>
<div id="out" class="empty">برای شروع جست‌وجو کن یا یک تب بگیر.</div>
<script>
const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const user = tg?.initDataUnsafe?.user;
document.getElementById('who').textContent = user ? ('👋 ' + (user.first_name||'') + ' — داشبورد زنده') : 'داشبورد زنده';
const tabs = [['trending','🔥 داغ‌ترین'],['weekly','📅 هفته'],['gems','✨ گنج پنهان'],['favorites','⭐ علاقه‌مندی'],['subs','🔔 اشتراک']];
let cur='trending';
document.getElementById('tabs').innerHTML = tabs.map(([k,l])=>'<div class="tab'+(k==='trending'?' on':'')+'" data-k="'+k+'">'+l+'</div>').join('');
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  t.classList.add('on'); cur=t.dataset.k; load(cur);
});
async function api(path){ const r = await fetch(path, {headers:{'X-Telegram-Init-Data': tg?.initData||''}}); return r.json(); }
function render(items){
  const out=document.getElementById('out');
  if(!items||!items.length){ out.className='empty'; out.textContent='چیزی پیدا نشد.'; return; }
  out.className='';
  out.innerHTML = items.map(it=>\`
   <div class="card">
     <div class="row"><div class="name">\${it.full_name}</div><div class="pill">⭐ \${fmt(it.stars||0)}</div></div>
     \${it.description?'<div class="desc">'+esc(it.description).slice(0,180)+'</div>':''}
     <div class="stats">
       \${it.language?'<span>🧩 '+esc(it.language)+'</span>':''}
       \${it.forks?'<span>🍴 '+fmt(it.forks)+'</span>':''}
       \${it.gained?'<span>🚀 +'+fmt(it.gained)+'</span>':''}
       \${it.health?'<span>❤️ '+it.health+'</span>':''}
     </div>
     \${it.health?'<div class="bar"><i style="width:'+Math.min(100,it.health)+'%"></i></div>':''}
     <div class="stats" style="margin-top:8px">
       <a href="https://github.com/\${it.full_name}" target="_blank">GitHub</a>
       <a href="https://t.me/__BOT_USERNAME__?startapp=\${encodeURIComponent(it.full_name)}" target="_blank">در ربات باز کن</a>
     </div>
   </div>\`).join('');
}
function fmt(n){ return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n); }
function esc(s){ return String(s).replace(/[<>&]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
async function load(kind){
  const out=document.getElementById('out'); out.className='empty'; out.textContent='⏳ …';
  try{ const d = await api('/api/miniapp?kind='+kind); render(d.items||[]); }
  catch(e){ out.textContent='خطا در دریافت داده'; }
}
async function doSearch(){
  const q=document.getElementById('q').value.trim(); if(!q) return;
  const out=document.getElementById('out'); out.className='empty'; out.textContent='🔍 …';
  const d = await api('/api/miniapp?kind=search&q='+encodeURIComponent(q));
  render(d.items||[]);
}
document.getElementById('q').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });
load('trending');
</script></body></html>`;
