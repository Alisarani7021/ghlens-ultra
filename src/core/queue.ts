import type { Ctx, Env, Job } from "../env";
import { Store } from "./db";
import { Telegram } from "../tg/api";
import { AiBrain } from "../ai/brain";
import { GithubRest } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { SecurityEngine } from "../github/osv";
import { VectorIndex } from "../ai/vector";
import { fmt } from "../features/cards";
import { RepoCard } from "../features/cards";

/**
 * Queue consumer — every job that must not block a Telegram update handler.
 * Retries are handled by Cloudflare (max_retries 3 → DLQ). Each job is
 * idempotent by design (UPSERTs + content-addressed R2 keys).
 */
export async function consumeQueue(batch: MessageBatch<Job>, env: Env, ctx: Ctx) {
  const store = new Store(env);
  const tg = new Telegram(env);
  const ai = new AiBrain(env);
  const gh = new GithubRest(env);

  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      switch (job.type) {
        /* Deferred model work.
           A webhook handler has ~30 s and a heavy request does not fit: the repo
           analyst needs ~40 s on a bad minute, code review and mission planning
           need similar. The button therefore answers in a second, the work is
           queued, and the card the user is looking at is edited when it lands —
           which is the difference between a button that ships and a button that
           looks dead. */
        case "ai.defer": {
          const store2 = new Store(env);
          const tg2 = new Telegram(env);
          const ai2 = new AiBrain(env);
          const card2 = new RepoCard(env, store2);
          const where = job.message_id
            ? (text: string, kb?: any) => tg2.editMessageText(job.chat_id, job.message_id!, text, { parse_mode: "HTML", reply_markup: kb } as any)
            : (text: string, kb?: any) => tg2.sendMessage(job.chat_id, text, { parse_mode: "HTML", reply_markup: kb } as any);
          /* The queue's own budget. Generous on purpose: this is the path that
             exists because the request path is too short. */
          const guard = { chatId: job.chat_id, loading: false, settled: true, startedAt: Date.now(), budgetMs: 180_000 };
          const { buildH, runDeferredFeature } = await import("../index");
          const h = await buildH(
            // no invented name: the stored one belongs to the person who pressed
            // the button, and a queued job has no business touching it
            { from: { id: job.user_id, is_bot: false } as any, chat: { id: job.chat_id } as any, message_id: job.message_id },
            env, ctx, tg2, store2, ai2, card2, { text: job.arg, guard, editTarget: job.message_id },
          );
          try {
            await runDeferredFeature(job.feature, h, job.arg);
          } catch (e: any) {
            const msg = String(e?.message ?? e).slice(0, 240);
            console.error("ai-defer-failed", msg);
            await where(`⚠️ این کار در صف کامل نشد.\n<blockquote>${msg}</blockquote>\nیک بار دیگر بزن؛ اگر تکرار شد مدل را در «🧠 هوش مصنوعی → وضعیت» ببین.`)
              .catch(() => null);
          }
          break;
        }
        case "index_repo": {
          const meta = await store.repoFresh(job.full_name, 300);
          if (!meta) break;
          const readme = await gh.readme(job.full_name, 604800).catch(() => null);
          const digest = readme?.content ? atob(readme.content.replace(/\n/g, "")).replace(/[#*`>-]/g, " ").replace(/\s+/g, " ").slice(0, 600) : "";
          const vi = new VectorIndex(env, ai);
          await vi.upsertRepos([VectorIndex.docFromMeta({
            full_name: meta.full_name, description: meta.description, language: meta.language,
            languages: safeJson(meta.languages), topics: safeJson(meta.topics), license: meta.license,
            stars: meta.stars, health: meta.health_score, pushed_at: meta.pushed_at ? new Date(meta.pushed_at).toISOString() : null,
          }, digest)]);
          break;
        }

        case "refresh_meta": {
          await store.repoFresh(job.full_name, 0);
          break;
        }

        case "download": {
          const row = await env.DB.prepare(`SELECT * FROM downloads WHERE id=?`).bind(job.download_id).first<any>().catch(() => null);
          if (!row) break;
          await env.DB.prepare(`UPDATE downloads SET status='ready' WHERE id=?`).bind(job.download_id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          break;
        }

        case "notify_subscribers": {
          const { results } = await store.watchersOf(job.full_name);
          const payload = job.payload as any;
          for (const r of results ?? []) {
            const want: string[] = safeJson(r.events) as any;
            if (!want.includes(job.event)) continue;
            if ((r.muted_until ?? 0) > Date.now()) continue;
            await tg.sendMessage(r.user_id, payload.text, { parse_mode: "HTML", reply_markup: payload.markup }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          }
          break;
        }

        case "snapshot": {
          const engine = new TrendingEngine(env);
          const { results } = await env.DB.prepare(`SELECT DISTINCT full_name FROM subscriptions LIMIT 400`)
            .all<{ full_name: string }>().catch(() => ({ results: [] as any[] }));
          const names = (results ?? []).map((r) => r.full_name);
          if (names.length) await engine.snapshot(names.slice(0, 40));
          break;
        }

        case "scan_security": {
          const sec = new SecurityEngine(env, gh);
          const result = await sec.scanRepo(job.full_name, { maxManifests: 2 });
          const critical = (result.counts.CRITICAL ?? 0) + (result.counts.HIGH ?? 0);
          if (critical > 0) {
            const { results } = await store.watchersOf(job.full_name);
            for (const r of results ?? []) {
              await tg.sendMessage(r.user_id,
                `🛡 <b>${job.full_name}</b> — <b>${critical}</b> آسیب‌پذیری بحرانی/بالا در وابستگی‌ها\n` +
                  result.vulns.filter((v) => v.severity === "CRITICAL" || v.severity === "HIGH").slice(0, 3)
                    .map((v) => `• <code>${v.package}</code> — ${v.summary.slice(0, 90)}`).join("\n"),
                { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
            }
          }
          break;
        }

        case "broadcast": {
          await tg.sendMessage(job.from, job.text, { parse_mode: "HTML", reply_markup: job.button ? { inline_keyboard: [[{ text: job.button.text, url: job.button.url }]] } : undefined }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          break;
        }

        case "digest": {
          const { results } = await env.DB.prepare(`SELECT id FROM users WHERE banned=0 LIMIT 200`).all<{ id: number }>().catch(() => ({ results: [] as any[] }));
          for (const u of results ?? []) {
            await tg.sendMessage(u.id, `📰 ${job.kind} digest — ${new Date().toISOString().slice(0, 10)}`, { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          }
          break;
        }

        case "action_job": {
          const row = await env.DB.prepare(`SELECT * FROM action_jobs WHERE id=?`).bind(job.job_id).first<any>().catch(() => null);
          if (!row) break;
          const payload = JSON.parse(row.payload);
          await tg.sendMessage(row.user_id,
            `🏭 <b>کار Actions به پایان رسید</b>\n\n📦 <b>${payload.full ?? ""}</b>\n🔗 لینک‌ها در ریلیز مخزن کمکی آماده است.`,
            { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          await env.DB.prepare(`UPDATE action_jobs SET status='done' WHERE id=?`).bind(job.job_id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
          break;
        }

        default:
          console.warn("unknown job", (job as any).type);
      }
      msg.ack();
    } catch (e: any) {
      console.error("job failed", job, e?.message);
      // let Cloudflare retry → after max_retries it lands in the DLQ
      msg.retry({ delaySeconds: Math.min(60, 5 * (msg.attempts || 1)) });
    }
  }
}

function safeJson(s: string | null | undefined): any[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
