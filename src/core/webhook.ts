import type { Ctx, Env } from "../env";
import { Telegram } from "../tg/api";
import { Store } from "./db";
import { GithubRest } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { SecurityEngine } from "../github/osv";
import { fmt } from "../features/cards";
import { tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * GitHub webhooks → instant Telegram notifications.
 * Handles: release, push, issues, pull_request, security_advisory,
 * star, fork, workflow_run, ping. Verified with HMAC-SHA256.
 *
 * This is what makes subscriptions feel alive: the original bot could only
 * poll; Lens Ultra reacts in milliseconds.
 */
export async function handleWebhook(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery") ?? crypto.randomUUID();

  if (env.GITHUB_WEBHOOK_SECRET) {
    const ok = await verify(raw, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!ok) return new Response("bad signature", { status: 401 });
  }

  let payload: any = null;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const store = new Store(env);
  const full = payload?.repository?.full_name as string | undefined;
  await env.DB.prepare(`INSERT OR REPLACE INTO webhook_log (delivery, event, repo, payload, ts) VALUES (?,?,?,?,?)`)
    .bind(delivery, event, full ?? null, raw.slice(0, 20000), Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

  ctx.waitUntil((async () => {
    try {
      switch (event) {
        case "ping": return;
        case "release": {
          if (payload.action !== "published" && payload.action !== "released") return;
          const tag = payload.release?.tag_name ?? "";
          const name = payload.release?.name ?? tag;
          const body = (payload.release?.body ?? "").slice(0, 700);
          const assets = (payload.release?.assets ?? []).slice(0, 4).map((a: any) => `• ${a.name} (${(a.size / 1048576).toFixed(1)}MB)`).join("\n");
          const text =
            `🚀 <b>${tgEscape(full ?? "")}</b> — ${event === "release" ? "نسخه جدید" : event}\n\n` +
            `🏷 <b>${tgEscape(name)}</b>${payload.release?.prerelease ? " 🧪 prerelease" : ""}\n` +
            (body ? `<i>${tgEscape(body)}</i>\n\n` : "") +
            (assets ? `${assets}\n\n` : "") +
            `<a href="${payload.release?.html_url}">صفحه ریلیز</a>`;
          const markup = kb(
            [{ text: "⬇️ " + "دانلود سورس", cb: `d:go:${full}|zip|${encodeURIComponent(tag)}` }, { text: "🚀 دارایی‌ها", cb: `d:link:${full}` }],
            [{ text: "📰 چنج‌لاگ", cb: `ai:tr:ask` }, { text: "🛰 کاوش", cb: `s:go:${full}` }],
          );
          await notifySubscribers(env, store, full!, ["release"], text, markup);
          await env.DB.prepare(`UPDATE watch_state SET last_release=?, last_tag=?, last_checked=? WHERE full_name=?`)
            .bind(tag, tag, Date.now(), full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          return;
        }
        case "push": {
          const commits = payload.commits ?? [];
          if (!commits.length || commits.length > 25) return;
          const branch = (payload.ref ?? "").replace("refs/heads/", "");
          const head = payload.head_commit ?? commits[0];
          if (/^(chore|docs|style)\b/i.test(head?.message ?? "")) return; // noise filter
          const text =
            `📦 <b>${tgEscape(full ?? "")}</b> @ <code>${tgEscape(branch)}</code>\n\n` +
            commits.slice(0, 5).map((c: any) => `• <code>${tgEscape((c.id ?? "").slice(0, 7))}</code> ${tgEscape(truncate(c.message.split("\n")[0], 90))} — ${tgEscape(c.author?.name ?? "")}`).join("\n") +
            `\n\n👤 ${tgEscape(payload.pusher?.name ?? "")} · ${commits.length} کامیت`;
          await notifySubscribers(env, store, full!, ["commits"], text, kb(
            [{ text: "🕒 " + "کامیت‌ها", cb: `s:t:7,${full}` }],
            [{ text: "🛰 کاوش", cb: `s:go:${full}` }],
          ));
          return;
        }
        case "issues": {
          if (payload.action !== "opened") return;
          const issue = payload.issue;
          const labels = (issue.labels ?? []).map((l: any) => l.name);
          const interesting = labels.some((l: string) => /good first issue|help wanted|bug|security/i.test(l));
          if (!interesting) return;
          const text =
            `🎯 <b>فرصت جدید در ${tgEscape(full ?? "")}</b>\n\n` +
            `#${issue.number} — ${tgEscape(truncate(issue.title, 140))}\n` +
            `🏷 ${labels.slice(0, 4).map((l: string) => `<code>${tgEscape(l)}</code>`).join(" ")}\n\n` +
            `<a href="${issue.html_url}">مشاهده ایشو</a>`;
          await notifySubscribers(env, store, full!, ["issues"], text, kb(
            [{ text: "🌱 " + "شروع کن", url: issue.html_url }, { text: "🧩 مشارکت", cb: `c:repo:${full}` }],
          ));
          return;
        }
        case "pull_request": {
          if (payload.action !== "opened") return;
          const pr = payload.pull_request;
          const text =
            `🔀 <b>PR جدید در ${tgEscape(full ?? "")}</b>\n\n` +
            `#${pr.number} — ${tgEscape(truncate(pr.title, 140))}\n` +
            `👤 ${tgEscape(pr.user?.login ?? "")} · +${pr.additions}/-${pr.deletions} · 📄 ${pr.changed_files}\n\n` +
            `<a href="${pr.html_url}">مشاهده PR</a>`;
          await notifySubscribers(env, store, full!, ["pull_requests"], text, kb(
            [{ text: "🔍 بازبینی AI", cb: "a:review" }, { text: "🌐 باز کردن", url: pr.html_url }],
          ));
          return;
        }
        case "security_advisory": {
          const adv = payload.security_advisory;
          const text =
            `🛡 <b>هشدار امنیتی</b>\n\n<b>${tgEscape(adv?.severity ?? "")}</b> — ${tgEscape(adv?.summary ?? "")}\n` +
            `<code>${tgEscape(adv?.ghsa_id ?? "")}</code>\n\n${tgEscape((adv?.description ?? "").slice(0, 300))}\n\n` +
            `<a href="${adv?.html_url ?? ""}">جزئیات</a>`;
          // broadcast to everyone watching security (global advisory, no repo scope)
          const { results } = await env.DB.prepare(
            `SELECT DISTINCT user_id FROM subscriptions WHERE events LIKE '%security%' LIMIT 500`,
          ).all<{ user_id: number }>().catch(() => ({ results: [] as any[] }));
          const tg = new Telegram(env);
          for (const r of results ?? []) {
            await tg.sendMessage(r.user_id, text, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          }
          return;
        }
        case "workflow_run": {
          if (payload.action !== "completed") return;
          const conclusion = payload.workflow_run?.conclusion;
          if (conclusion === "success") return;
          const text =
            `🏗 <b>CI ${conclusion === "failure" ? "شکست خورد" : conclusion}</b> در <b>${tgEscape(full ?? "")}</b>\n\n` +
            `⚙️ ${tgEscape(payload.workflow_run?.name ?? "")}\n🌿 <code>${tgEscape(payload.workflow_run?.head_branch ?? "")}</code>\n\n` +
            `<a href="${payload.workflow_run?.html_url ?? ""}">لاگ اجرا</a>`;
          await notifySubscribers(env, store, full!, ["ci"], text, kb([[{ text: "🌐 لاگ", url: payload.workflow_run?.html_url ?? "https://github.com" }]]));
          return;
        }
        case "star": {
          if (payload.action !== "created") return;
          // milestone announcements at 1k/5k/10k/50k stars
          const stars = payload.repository?.stargazers_count ?? 0;
          if (![1000, 5000, 10000, 25000, 50000, 100000].includes(stars)) return;
          const text = `🎉 <b>${tgEscape(full ?? "")}</b> به <b>${fmt(stars)}</b> ستاره رسید!`;
          await notifySubscribers(env, store, full!, ["stars"], text, kb([[{ text: "🛰 کاوش", cb: `s:go:${full}` }]]));
          return;
        }
        case "create":
        case "delete":
        case "fork":
        case "watch":
          return; // recorded in webhook_log only
        default:
          return;
      }
    } catch (e) {
      console.error("webhook handler failed", event, e);
    }
  })());

  return new Response("ok");
}

async function notifySubscribers(env: Env, store: Store, full: string, events: string[], text: string, markup: any) {
  const { results } = await store.watchersOf(full);
  const tg = new Telegram(env);
  const now = Date.now();
  for (const row of results ?? []) {
    const want: string[] = (() => { try { return JSON.parse(row.events); } catch { return ["release"]; } })();
    if (!events.some((e) => want.includes(e))) continue;
    if ((row.muted_until ?? 0) > now) continue;
    await tg.sendMessage(row.user_id, text, { parse_mode: "HTML", reply_markup: markup, disable_notification: false }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  await env.ANALYTICS?.writeDataPoint({ blobs: ["webhook_notify", full, events.join("|")], doubles: [results?.length ?? 0] });
}

/** HMAC-SHA256 verification (constant-time compare). */
async function verify(body: string, signature: string, secret: string) {
  if (!signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
