import type { Env } from "../env";
import { type HubEvent, type ConnectorKind, hubId, newTrace } from "./event";

/**
 * The connector fabric.
 *
 *         NEW SERVICE  →  CONNECTOR  →  EVENTS + ACTIONS  →  UNIVERSAL BUS
 *
 * Every outside service is described by the same small interface, so adding a
 * tenth one never touches the engine. A connector does three things at most:
 *
 *   test()  — prove the config actually works, and say what it can see
 *   poll()  — turn "what changed over there?" into events on the bus
 *   act()   — perform an outbound action (publish, upload, comment…)
 *
 * Connectors hold **no secrets of their own**: credentials live in the worker's
 * secret store / the key vault and are read from `env` at call time. A
 * connector config that lands in D1 is settings only.
 */
export interface ConnectorCtx {
  env: Env;
  owner_id: number;
  /** free-form, non-secret settings for this connector instance */
  config: Record<string, any>;
  /** opaque bookmark from the previous poll (last id / timestamp) */
  cursor?: string | null;
}

export interface ConnectorResult {
  events: HubEvent[];
  /** new cursor to persist, when the connector is pollable */
  cursor?: string;
}

export interface Connector {
  kind: ConnectorKind;
  label: string;
  /** event types this connector can put on the bus */
  emits: string[];
  /** actions workflows may invoke on it */
  actions: string[];
  /** human-readable description of what config it needs */
  configHint: string;
  test?(ctx: ConnectorCtx): Promise<{ ok: boolean; detail: string; title?: string }>;
  poll?(ctx: ConnectorCtx): Promise<ConnectorResult>;
  act?(ctx: ConnectorCtx, action: string, args: Record<string, any>): Promise<any>;
  /** parse a raw inbound body into events (webhook-shaped connectors) */
  ingest?(ctx: ConnectorCtx, body: any): Promise<HubEvent[]>;
}

function ev(source: string, type: string, payload: Record<string, any>, owner_id?: number): HubEvent {
  return { id: hubId("evt"), type, source, payload, ts: Date.now(), trace: newTrace(), owner_id };
}

/** GitHub REST without the heavy client — connectors stay dependency-light. */
async function gh(env: Env, path: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ghlens-hub",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return res.json();
}

/**
 * Minimal RSS 2.0 / Atom reader.
 *
 * A full XML parser is ~40KB for a job this small, and feeds are the one place
 * where being liberal in what we accept pays off: Blogger, Ghost, Medium and
 * half the world's WordPress installs each emit slightly different tag casing.
 * So we take the fields we need and ignore everything else.
 */
export function parseFeed(xml: string, limit = 20): Array<{ title: string; link: string; guid: string; date?: string; summary?: string }> {
  const items: Array<{ title: string; link: string; guid: string; date?: string; summary?: string }> = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const block of blocks.slice(0, limit)) {
    const pick = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? stripCdata(m[1]) : "";
    };
    // Atom uses <link href="…"/> while RSS uses <link>…</link>
    const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "";
    const link = pick("link") || href;
    const title = pick("title");
    if (!title && !link) continue;
    items.push({
      title: decodeEntities(title),
      link: decodeEntities(link),
      guid: pick("guid") || pick("id") || link || title,
      date: pick("pubDate") || pick("published") || pick("updated"),
      summary: decodeEntities(pick("description") || pick("summary") || pick("content")).slice(0, 600),
    });
  }
  return items;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable identity for a feed entry — the GUID, or the link if the feed is lazy. */
export const feedIdentity = (i: { guid: string; link: string; title: string }) => i.guid || i.link || i.title;

// ── the registry ───────────────────────────────────────────────────────────

export const CONNECTORS: Record<string, Connector> = {
  /**
   * GitHub — the connector the whole project grew out of, now just one of them.
   * Polls releases (and optionally commits) for a list of repositories.
   */
  github: {
    kind: "github",
    label: "GitHub",
    emits: ["github.release.published", "github.release.prerelease", "github.push.commits", "github.issue.opened"],
    actions: ["list_releases", "get_repo", "get_readme"],
    configHint: 'repos: ["owner/name", …]  ·  watch: ["release","commit","issue"]',
    async test(ctx) {
      if (!ctx.env.GITHUB_TOKEN) return { ok: false, detail: "توکن گیت‌هاب تنظیم نشده (GITHUB_TOKEN)" };
      try {
        const r = await gh(ctx.env, "/rate_limit");
        const core = r?.resources?.core;
        return { ok: true, detail: `سهمیه: ${core?.remaining ?? "?"}/${core?.limit ?? "?"} تا ${new Date((core?.reset ?? 0) * 1000).toISOString().slice(11, 16)} UTC` };
      } catch (e: any) {
        return { ok: false, detail: String(e?.message ?? e) };
      }
    },
    async poll(ctx) {
      const repos: string[] = Array.isArray(ctx.config.repos) ? ctx.config.repos : [];
      const watch: string[] = Array.isArray(ctx.config.watch) ? ctx.config.watch : ["release"];
      const out: HubEvent[] = [];
      let newest = ctx.cursor ?? "";
      for (const full of repos.slice(0, 25)) {
        try {
          if (watch.includes("release")) {
            const releases: any[] = await gh(ctx.env, `/repos/${full}/releases?per_page=5`);
            let meta: any = null;
            for (const r of releases) {
              if (ctx.cursor && Date.parse(r.published_at ?? 0) <= Date.parse(ctx.cursor)) continue;
              /* The repository's live numbers, fetched once per poll and only
                 when there is a new release to report: the post shows ⭐/🍴/🐞
                 instead of the grey line it used to show. */
              if (!meta) meta = await gh(ctx.env, `/repos/${full}`).catch(() => null);
              out.push(ev("github", r.prerelease ? "github.release.prerelease" : "github.release.published", {
                identity: `${full}@${r.tag_name}`,
                repo: full,
                tag: r.tag_name,
                name: r.name ?? r.tag_name,
                body: (r.body ?? "").slice(0, 4000),
                url: r.html_url,
                published_at: r.published_at,
                prerelease: !!r.prerelease,
                author: r.author?.login ?? "",
                meta: meta
                  ? {
                      stars: meta.stargazers_count,
                      forks: meta.forks_count,
                      issues: meta.open_issues_count,
                      language: meta.language,
                      license: meta.license?.spdx_id ?? meta.license?.name ?? "",
                      description: meta.description ?? "",
                      topics: meta.topics ?? [],
                    }
                  : undefined,
                assets: (r.assets ?? []).map((a: any) => ({
                  name: a.name, size: a.size, downloads: a.download_count,
                  url: a.browser_download_url, type: a.content_type,
                })),
              }, ctx.owner_id));
              if (r.published_at > newest) newest = r.published_at;
            }
          }
          if (watch.includes("commit")) {
            const commits: any[] = await gh(ctx.env, `/repos/${full}/commits?per_page=5`);
            for (const c of commits) {
              if (ctx.cursor && Date.parse(c.commit?.author?.date ?? 0) <= Date.parse(ctx.cursor)) continue;
              out.push(ev("github", "github.push.commits", {
                identity: `${full}@${c.sha}`,
                repo: full, sha: c.sha,
                message: (c.commit?.message ?? "").split("\n")[0].slice(0, 200),
                author: c.commit?.author?.name ?? "",
                url: c.html_url,
                date: c.commit?.author?.date,
              }, ctx.owner_id));
            }
          }
        } catch (e: any) {
          console.error("hub-github-poll", full, String(e?.message ?? e));
        }
      }
      return { events: out, cursor: newest || undefined };
    },
  },

  /** RSS / Atom — 1000 feeds, one reader. */
  rss: {
    kind: "rss",
    label: "RSS / Atom",
    emits: ["rss.item.new"],
    actions: [],
    configHint: 'url: "https://…/feed.xml"  ·  limit: 20',
    async test(ctx) {
      const url = ctx.config.url;
      if (!url) return { ok: false, detail: "آدرس فید تنظیم نشده" };
      try {
        const xml = await (await fetch(url, { headers: { "user-agent": "ghlens-hub" } })).text();
        const items = parseFeed(xml, 3);
        return { ok: items.length > 0, detail: items.length ? `${items.length} آیتم خوانده شد — آخرین: ${items[0].title.slice(0, 60)}` : "فید خالی یا نامعتبر" };
      } catch (e: any) {
        return { ok: false, detail: String(e?.message ?? e) };
      }
    },
    async poll(ctx) {
      const url = ctx.config.url;
      if (!url) return { events: [] };
      const xml = await (await fetch(url, { headers: { "user-agent": "ghlens-hub" } })).text();
      const items = parseFeed(xml, Math.min(Number(ctx.config.limit) || 20, 50));
      const out: HubEvent[] = [];
      for (const i of items) {
        const id = feedIdentity(i);
        if (ctx.cursor && id === ctx.cursor) break;
        out.push(ev("rss", "rss.item.new", {
          identity: id, title: i.title, link: i.link, guid: i.guid,
          date: i.date, summary: i.summary, feed: url,
        }, ctx.owner_id));
      }
      return { events: out.reverse(), cursor: items[0] ? feedIdentity(items[0]) : undefined };
    },
  },

  /**
   * HTTP — the escape hatch that stops the platform being bounded by how many
   * connectors were written. Any API, polled, with the response normalised
   * into an event when a JSON path changes.
   */
  http: {
    kind: "http",
    label: "HTTP / هر API",
    emits: ["http.response.received", "http.value.changed"],
    actions: ["request"],
    configHint: 'url · method · headers · watchPath (مثل "data.0.version")',
    async test(ctx) {
      const url = ctx.config.url;
      if (!url) return { ok: false, detail: "آدرس تنظیم نشده" };
      try {
        const res = await fetch(url, { headers: ctx.config.headers ?? {}, method: ctx.config.method ?? "GET" });
        return { ok: res.ok, detail: `HTTP ${res.status} ${res.headers.get("content-type") ?? ""}` };
      } catch (e: any) {
        return { ok: false, detail: String(e?.message ?? e) };
      }
    },
    async poll(ctx) {
      const url = ctx.config.url;
      if (!url) return { events: [] };
      const res = await fetch(url, { headers: ctx.config.headers ?? {}, method: ctx.config.method ?? "GET" });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = await res.json().catch(() => null);
      const value = ctx.config.watchPath ? pluck(body, ctx.config.watchPath) : null;
      // When watchPath is set we only emit on *change* — that turns any endpoint
      // into a pollable trigger without asking the owner to write comparison logic.
      if (ctx.config.watchPath && String(value) === (ctx.cursor ?? "")) return { events: [] };
      return {
        events: [ev("http", ctx.config.watchPath ? "http.value.changed" : "http.response.received", {
          identity: `${url}#${Date.now()}`,
          url, value, body,
        }, ctx.owner_id)],
        cursor: ctx.config.watchPath ? String(value) : undefined,
      };
    },
    async act(ctx, action, args) {
      if (action !== "request") return null;
      const url = args.url ?? ctx.config.url;
      const res = await fetch(url, {
        method: args.method ?? ctx.config.method ?? "GET",
        headers: { ...(ctx.config.headers ?? {}), ...(args.headers ?? {}) },
        ...(args.body ? { body: typeof args.body === "string" ? args.body : JSON.stringify(args.body) } : {}),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, ok: res.ok, json, text: text.slice(0, 2000) };
    },
  },

  /**
   * Telegram — the connector that makes the hub useful to everyone else.
   * Reads nothing (bots cannot enumerate their chats), but acts: this is the
   * only place that publishes, so every post in the platform has one origin.
   */
  telegram: {
    kind: "telegram",
    label: "تلگرام",
    emits: [],
    actions: ["publish", "send_draft"],
    configHint: 'channel: "@my_channel" | "-100…"',
    async test(ctx) {
      const channel = ctx.config.channel;
      if (!channel) return { ok: false, detail: "کانال تنظیم نشده" };
      const api = (m: string, q = "") =>
        fetch(`https://api.telegram.org/bot${ctx.env.BOT_TOKEN}/${m}${q}`).then((r) => r.json()).catch(() => null);

      /* getChat alone answers for any *public* channel, member or not — which is
         how this test reported «دسترسی تأیید شد» for a channel the bot could not
         post in. The only honest check is the bot's own membership: a bot can
         publish to a channel if and only if it is an administrator there with
         can_post_messages. */
      const chat: any = await api("getChat", `?chat_id=${encodeURIComponent(channel)}`);
      if (!chat?.ok) return { ok: false, detail: `کانال پیدا نشد: ${chat?.description ?? "خطای شبکه"}` };

      const me: any = await api("getMe");
      const member: any = me?.ok
        ? await api("getChatMember", `?chat_id=${encodeURIComponent(channel)}&user_id=${me.result.id}`)
        : null;
      const status = member?.result?.status;
      const canPost = member?.result?.can_post_messages !== false;
      const title = chat.result?.title ?? channel;

      if (status === "administrator" && canPost) {
        return { ok: true, title: String(title), detail: `دسترسی تأیید شد — «${title}» (ادمین، اجازهٔ ارسال)` };
      }
      if (status === "administrator") {
        return { ok: false, title: String(title), detail: `ربات ادمین «${title}» است ولی اجازهٔ «ارسال پیام» ندارد — در تنظیمات ادمین تیکش را بزن` };
      }
      return {
        ok: false,
        title: String(title),
        detail: `ربات در «${title}» ادمین نیست — در کانال: تنظیمات → ادمین‌ها → افزودن ادمین → @${me?.result?.username ?? "Gitguts_bot"} با اجازهٔ ارسال پیام`,
      };
    },
    async act(ctx, action, args) {
      const channel = args.channel ?? ctx.config.channel;
      if (!channel) throw new Error("no channel configured");
      /* A rich post — headings, a download table, an open changelog — when the
         caller built one. Telegram's rich messages are the difference between a
         release note and a wall of text; if the channel or the API refuses it we
         fall back to the same content as a normal message, so a post is never
         lost to a formatting preference. */
      if (args.rich) {
        const { richToLegacy } = await import("../tg/rich");
        const richBody = {
          chat_id: channel,
          rich_message: { html: String(args.rich), is_rtl: true },
          ...(args.markup ? { reply_markup: args.markup } : {}),
        };
        const rr: any = await fetch(`https://api.telegram.org/bot${ctx.env.BOT_TOKEN}/sendRichMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(richBody),
        }).then((r) => r.json()).catch(() => null);
        if (rr?.ok) return { message_id: rr.result?.message_id, chat: channel, action, format: "rich" };
        console.error("rich-publish-fallback", String(rr?.description ?? "send failed").slice(0, 160));
        args = { ...args, rich: undefined, text: args.text ?? richToLegacy(String(args.rich)) };
      }
      const msg = {
        chat_id: channel,
        text: args.text ?? "",
        parse_mode: "HTML",
        disable_web_page_preview: args.preview === true ? false : true,
        ...(args.markup ? { reply_markup: args.markup } : {}),
      };
      const res: any = await fetch(`https://api.telegram.org/bot${ctx.env.BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg),
      }).then((r) => r.json());
      if (!res?.ok) {
        // Telegram's own words are accurate but not actionable. The two failures
        // that actually happen here are "not an admin" and "wrong channel", and
        // both have a next step the owner can take in ten seconds.
        const d = String(res?.description ?? "send failed");
        const why = /not enough rights|CHAT_ADMIN_REQUIRED|administrator/i.test(d)
          ? "ربات در این کانال ادمین نیست — در کانال: تنظیمات → ادمین‌ها → افزودن ادمین → @Gitguts_bot با اجازهٔ ارسال پیام"
          : /chat not found|chat_id is empty/i.test(d)
            ? "کانال پیدا نشد — نام کاربری یا آیدی را در کانکتورها درست کن"
            : d;
        throw new Error(`telegram: ${why}`);
      }
      return { message_id: res.result?.message_id, chat: channel, action };
    },
  },
};

/**
 * Read a connector's config from whatever the owner typed. Channels arrive in
 * every shape a human writes them — @name, a bare name, t.me/name,
 * https://t.me/name, //t.me/name (copied straight from a browser address bar),
 * or a numeric id — and they all mean the same channel; the first shape the
 * old parser did not know was exactly the one the owner pasted, and the
 * connector answered «کانال پیدا نشد» for a channel that existed.
 */
export function configFor(kind: string, input: string, msg?: any): Record<string, any> {
  const value = (raw: string) => raw.trim()
    .replace(/^[a-zA-Z_]+\s*:\s*(?!\/\/)/, "")   // `channel: x` — but never a URL's https:
    .replace(/^[\'"\u00AB\`]+|[\'"\u00BB\`]+$/g, "")            // the hint's quotes
    .trim();

  // commas and newlines separate fields; `|` separates alternatives — never data
  const parts = input.split(/[,\n|]/).map(value).filter(Boolean);

  // a forwarded post carries the channel's numeric id, so nothing needs typing
  const fwd = msg?.forward_from_chat ?? msg?.forward_origin?.chat;
  if (kind === "telegram" && fwd?.type === "channel" && fwd.id) return { channel: String(fwd.id) };

  if (kind === "telegram") {
    const chan = (x: string) => {
      const s = x.trim().replace(/^(?:https?:)?\/*(?:t\.me|telegram\.me)\//i, "");
      if (/^-?\d{6,}$/.test(s)) return s;                 // a numeric id stays itself
      const name = s.replace(/^[@\/]+/, "").split(/[\/?#\s]/)[0].trim();
      return /^[A-Za-z0-9_]{3,}$/.test(name) ? `@${name}` : "";
    };
    const looks = /t\.me|telegram\.me|^-?\d{5,}$|^@|^[A-Za-z0-9_]{3,}$/i;
    const picked = parts.find((x) => looks.test(x)) ?? "";
    return { channel: chan(picked) };
  }
  if (kind === "github") {
    return {
      repos: parts.map((x) => x.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, ""))
        .filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x)).slice(0, 25),
    };
  }
  // rss + http: the first thing that is a URL wins, labels and quotes ignored
  return { url: parts.find((x) => /^https?:\/\//i.test(x)) ?? parts[0] ?? "" };
}

export const connector = (kind: string): Connector | null => CONNECTORS[kind] ?? null;
export const connectorKinds = () => Object.keys(CONNECTORS);

/** `a.b.0.c` → body.a.b[0].c — used by the HTTP connector's watchPath. */
export function pluck(obj: any, path: string): any {
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}
