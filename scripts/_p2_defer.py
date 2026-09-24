import pathlib, sys

def edit(path, old, new, n=1):
    p = pathlib.Path(path); s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}: {old[:70]!r}"); sys.exit(1)
    p.write_text(s.replace(old, new, n)); print(f"ok {path} «{old.strip()[:46]}…»")

# ── the job ────────────────────────────────────────────────────────────────
edit("src/env.ts",
'''  | { type: "digest"; kind: "daily" | "weekly"; user_id?: number };''',
'''  | { type: "digest"; kind: "daily" | "weekly"; user_id?: number }
  /* A model call that does not fit in the platform's reply window. The queue
     consumer has minutes, not seconds, so the work happens there and the answer
     arrives by editing the card the user is already looking at. */
  | { type: "ai.defer"; feature: "repo" | "code" | "review" | "workflow" | "ask" | "mission";
      arg: string; chat_id: number; message_id?: number; user_id: number; trace: string };''')

# ── the consumer ───────────────────────────────────────────────────────────
edit("src/core/queue.ts",
'''      switch (job.type) {''',
'''      switch (job.type) {
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
            { from: { id: job.user_id, is_bot: false, first_name: "?" } as any, chat: { id: job.chat_id } as any, message_id: job.message_id },
            env, ctx, tg2, store2, ai2, card2, { text: job.arg, guard },
          );
          try {
            await runDeferredFeature(job.feature, h, job.arg);
          } catch (e: any) {
            const msg = String(e?.message ?? e).slice(0, 240);
            console.error("ai-defer-failed", msg);
            await where(`⚠️ این کار در صف کامل نشد.\\n<blockquote>${msg}</blockquote>\\nیک بار دیگر بزن؛ اگر تکرار شد مدل را در «🧠 هوش مصنوعی → وضعیت» ببین.`)
              .catch(() => null);
          }
          break;
        }''')

# ── index: export buildH + a dispatcher for deferred features + the queue hook ──
edit("src/index.ts", "async function buildH(", "export async function buildH(")

edit("src/index.ts",
'''/**
 * GitHub account linking.''',
'''/**
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
  env: Env,
  ctx: Ctx,
  feature: "repo" | "code" | "review" | "workflow" | "ask" | "mission",
  arg: string,
  note: string,
): Promise<boolean> {
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
 * GitHub account linking.''')

# ── the two heavy callbacks go through the queue ───────────────────────────
edit("src/index.ts",
'''        if (action === "repo") return assistant.dossier(h, arg);''',
'''        if (action === "repo") {
          // A repo analysis takes ~40 s on a cold repo — longer than the platform
          // gives a webhook. The card answers instantly and the queue edits it
          // when the analysis lands, which is why this button never looks dead.
          const queued = await deferFeature(
            h, env, ctx, "repo", arg,
            `🧠 <b>${tgEscape(arg)}</b>\\n\\n` +
              (fa ? "تحلیل کامل در صف اجرا شد — تا چند ثانیه دیگر جای همین پیام می‌آید. می‌توانی بروی؛ نتیجه را می‌فرستم."
                  : "Queued — the analysis will replace this message."),
          );
          if (queued) return;
          return assistant.dossier(h, arg);
        }''')

edit("src/index.ts",
'''        if (action === "code") return assistant.code(h, arg);''',
'''        if (action === "code") {
          const queued = await deferFeature(h, env, ctx, "code", arg, fa ? "🧠 کد در صف ساخته می‌شود…" : "queued");
          if (queued) return;
          return assistant.code(h, arg);
        }''')

print("deferral wired")
