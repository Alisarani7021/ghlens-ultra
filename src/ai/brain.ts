import type { Env } from "../env";
import { KeyPool } from "./keypool";

/**
 * Workers AI gateway — one entry point for every model call.
 *
 *  • automatic model fallback chain (70B → 8B → 3B) so the bot never dies on capacity
 *  • KV + in-isolate memo cache keyed by prompt hash (translation/summary are idempotent)
 *  • per-user/day token meter in D1 (cost control)
 *  • optional OpenAI-compatible gateway passthrough (OpenRouter / AI Gateway)
 *  • strict JSON mode helper for structured extraction
 */
export type AiModel =
  | "@cf/meta/llama-3.1-8b-instruct-fp8"
  | "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  | "@cf/meta/llama-3.2-3b-instruct"
  | "@cf/meta/llama-4-scout-17b-16e-instruct"
  | "@cf/qwen/qwen2.5-coder-32b-instruct"
  | "@cf/qwen/qwen3-30b-a3b-fp8"
  | "@cf/openai/gpt-oss-120b"
  | "@cf/openai/gpt-oss-20b"
  | "@cf/google/gemma-4-26b-a4b-it"
  | "@cf/mistralai/mistral-small-3.1-24b-instruct"
  | "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";

/**
 * Fallback chains, ordered small → large so a burst of easy requests never
 * burns the daily neuron budget on a 70B model.
 *
 * Every id below answered "quota" (i.e. exists and is allowed on the Workers
 * Free plan) in `/health?ai=probe`; the previous list pointed at
 * `@cf/meta/llama-3.1-8b-instruct`, which Cloudflare deprecated on
 * 2026-05-30, and at a mistral id that never existed — which is why AI silently
 * produced nothing. Re-run the probe before editing this list.
 */
const FALLBACK: Record<string, AiModel[]> = {
  fast: ["@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  smart: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/openai/gpt-oss-120b", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  code: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/meta/llama-3.1-8b-instruct-fp8"],
};

/** Why the last call produced nothing — surfaced to users instead of a shrug. */
export type AiFailure = "quota" | "missing" | "unconfigured" | "pool-cooling" | "timeout" | null;
export type Tier = keyof typeof FALLBACK;

/**
 * How long a whole answer may take, in milliseconds.
 *
 * The Telegram handler runs every update inside `ctx.waitUntil` and Cloudflare
 * only guarantees that work for about thirty seconds after the response has gone
 * out. A model call was allowed 90 seconds on its own and the chain could try
 * four of them, so a slow model did not produce a slow answer — it produced no
 * answer at all, and the "thinking…" message stayed on screen forever.
 */
export const DEFAULT_DEADLINE_MS = 20_000;

export interface ChatOpts {
  /** total wall-clock budget for this answer; default DEFAULT_DEADLINE_MS */
  deadlineMs?: number;
  tier?: Tier;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  cacheKey?: string;
  cacheTtl?: number;
  userId?: number;
  feature?: string;
  json?: boolean;
}

/** Distinguishes "the model said nothing" from "the model never came back". */
const TIMED_OUT = Symbol("ai-timeout");

/** Resolve with TIMED_OUT once `ms` elapse — the call itself cannot be cancelled. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return TIMED_OUT;
  let timer: any;
  const alarm = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([work, alarm]);
  } finally {
    clearTimeout(timer);
  }
}

export class AiBrain {
  private static memo = new Map<string, { until: number; text: string }>();
  /** Set by the last chat() call: null when it produced text. */
  failure: AiFailure = null;
  /**
   * The wall-clock instant this brain must stop talking by (epoch ms, 0 = no
   * limit). `chat()` never waits past it, whatever deadline the caller asks for,
   * and every other method reaches the model through `chat()` — so a single
   * assignment bounds the whole request. This is the mechanism that keeps a
   * `waitUntil` handler inside the platform's ~30 s allowance; it replaced a
   * per-call stop, which two calls in one handler could always outrun.
   */
  hardDeadline = 0;

  /** The deadline actually used: the caller's wish, capped by the request clock. */
  private until(askedMs?: number): number {
    const asked = Math.max(1_500, askedMs ?? DEFAULT_DEADLINE_MS);
    if (!this.hardDeadline) return asked;
    return Math.max(1_500, Math.min(asked, this.hardDeadline - Date.now()));
  }

  constructor(private env: Env) {}

  /** Prompt → text, with cache + fallback chain. */
  async chat(prompt: string, opts: ChatOpts = {}): Promise<string> {
    const tier = opts.tier ?? "fast";
    const deadline = Date.now() + this.until(opts.deadlineMs);
    const left = () => deadline - Date.now();
    const system = opts.system ?? "You are GitHub Lens Ultra, an expert open-source intelligence analyst. Answer precisely and concisely.";
    const cacheKey = opts.cacheKey ? `ai:${tier}:${opts.cacheKey}` : null;

    if (cacheKey) {
      const memo = AiBrain.memo.get(cacheKey);
      if (memo && memo.until > Date.now()) return memo.text;
      const kv = await this.env.CACHE.get(cacheKey).catch(() => null);
      if (kv) {
        AiBrain.memo.set(cacheKey, { until: Date.now() + 60000, text: kv });
        return kv;
      }
    }

    const messages = [
      { role: "system", content: system + (opts.json ? "\nReturn ONLY valid, minified JSON. No markdown fences, no commentary." : "") },
      { role: "user", content: prompt },
    ];

    let text = "";
    const chain = FALLBACK[tier] ?? FALLBACK.fast;

    /* Circuit breaker: after the day's neurons are spent every further call
     * would just fail (and cost latency), so we short-circuit until UTC
     * midnight — unless a gateway with its own quota is configured. */
    const compatReady = !!(this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY);
    /* The breaker must never outrank a donated key. This used to happen: the
     * "pool has keys" flag was only written *after* a successful pool call, so
     * a halted account short-circuited before the pool was ever consulted and
     * a freshly donated key looked like it did nothing at all. */
    const poolReady = compatReady ? true : await this.poolReady();
    if (!compatReady && !poolReady && (await this.env.CACHE.get("ai:halt").catch(() => null))) {
      this.failure = "quota";
      return "";
    }

    /* Donated keys first: pooled, health-ordered, and independent of the
     * account's neuron budget. A key that fails hard is dropped immediately. */
    if (!text) {
      text = await this.tryPool(messages, opts, left());
      if (text) {
        this.failure = null;
        // pooled keys answered → the account-wide breaker is stale, clear it
        await this.env.CACHE.delete("ai:halt").catch(() => null);
        if (cacheKey) await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        if (opts.userId) await this.meter(opts.userId, opts.feature ?? "chat", text.length);
        return text;
      }
    }

    /* A configured OpenAI-compatible gateway is preferred over Workers AI:
     * its quota is separate from the account's neuron budget, so open-source
     * AI keeps working even after the free neurons are spent. */
    if (this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY) {
      text = await this.openaiCompat(messages, opts).catch((e: any) => {
        console.error("ai-compat-failed", String(e?.message ?? e));
        return "";
      });
      if (text) {
        this.failure = null;
        if (cacheKey) await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        return text;
      }
    }
    /* Every failure is recorded. Silently swallowing them hid a deployment-wide
     * Workers AI outage (auth/limit) behind a friendly "no answer" message, so
     * keep the last error and surface it when the whole chain misses. */
    const failures: string[] = [];
    let timedOut = false;
    for (const model of chain) {
      /* Stop before starting a call that cannot finish. A model that never
         answers must not eat the whole budget and take the reply down with it —
         the answer to a slow model is a different model, or an honest notice. */
      const remaining = left();
      if (remaining < 1_500) { timedOut = true; failures.push(`${model}: skipped, ${remaining}ms left`); break; }
      try {
        const res: any = await within(
          this.env.AI.run(model as any, {
            messages,
            max_tokens: opts.max_tokens ?? 1024,
            temperature: opts.temperature ?? 0.35,
          } as any),
          remaining,
        );
        if (res === TIMED_OUT) { timedOut = true; failures.push(`${model}: timed out`); break; }
        text = (res?.response ?? "").toString().trim();
        if (text) break;
        failures.push(`${model}: empty response`);
      } catch (e: any) {
        failures.push(`${model}: ${String(e?.message ?? e).slice(0, 120)}`);
        continue; // capacity/limits → try the next model
      }
    }
    /* One last door before giving up: a donated key that is only waiting out
       its cooldown. A working key should never sit idle while the user stares
       at "AI is down" — the worst case is one more request, the best case is a
       real answer. */
    if (!text && this.poolAttempted) {
      text = await this.tryCooling(messages, opts, left()).catch(() => "");
      if (text) {
        this.failure = null;
        await this.env.CACHE.delete("ai:halt").catch(() => null);
        console.error("ai-answered-from-cooling-key");
        if (cacheKey) await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch(() => null);
        return text;
      }
    }

    if (!text) {
      console.error("ai-chain-exhausted", failures.join(" | "));
      // If donated keys were tried and did not answer, that is the cause the
      // user needs to hear — not the account-wide quota message.
      this.failure = timedOut ? "timeout"
        : this.poolAttempted ? "pool-cooling"
        : failures.some((f) => /4006|neuron/i.test(f)) ? "quota"
        : failures.every((f) => /deprecat|no such model|not allowed|not available/i.test(f)) ? "missing"
        : "unconfigured";
      await this.env.CACHE.put("ai:last-failure", JSON.stringify({ at: Date.now(), reason: this.failure }), { expirationTtl: 3600 })
        .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      if (this.failure === "quota") {
        const left = secondsUntilUtcMidnight();
        await this.env.CACHE.put("ai:halt", String(Date.now()), { expirationTtl: left })
          .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    } else {
      this.failure = null;
    }
    if (!text && this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY) {
      text = await this.openaiCompat(messages, opts).catch(() => "");
    }

    if (text && cacheKey) {
      AiBrain.memo.set(cacheKey, { until: Date.now() + 120000, text });
      await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    if (opts.userId && text) await this.meter(opts.userId, opts.feature ?? "chat", text.length);
    return text;
  }

  /**
   * Spread one job across the pool.
   *
   * The owner asked that donated keys *share* the work, not just queue behind
   * each other: a long README is split into parts and each part is sent through
   * a different key in parallel, so N keys finish the job in roughly 1/N of the
   * time. Keys that fail are dropped mid-flight and their part is retried on the
   * next healthy key (or on Workers AI when it is available).
   */
  async parallel(prompts: string[], opts: ChatOpts = {}): Promise<string[]> {
    // same clock as chat(): parts run in parallel, so each gets the full budget
    const budget = this.until(opts.deadlineMs);
    if (prompts.length === 0) return [];
    if (prompts.length === 1) return [await this.chat(prompts[0]!, opts)];

    const pool = new KeyPool(this.env);
    let keys: { id: number; provider: string; baseUrl: string; model: string; key: string }[] = [];
    try { keys = await pool.candidates(prompts.length); } catch { keys = []; }

    // fewer keys than parts → reuse them round-robin; zero keys → plain chain
    if (keys.length === 0) {
      const out: string[] = [];
      for (const p of prompts) out.push(await this.chat(p, opts));
      return out;
    }

    const usedIds = new Set<number>();
    const runOne = async (prompt: string, k: (typeof keys)[number] | null): Promise<string> => {
      if (!k) return this.chat(prompt, opts);
      try {
        const res = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json" },
          body: JSON.stringify({ model: k.model || "auto", messages: [{ role: "user", content: prompt }], max_tokens: opts.max_tokens ?? 2048, temperature: opts.temperature ?? 0.2 }),
          // never spend more than what is left of the answer's budget
          signal: AbortSignal.timeout(Math.max(1500, Math.min(20000, budget))),
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          await pool.markFail(k.id, body, { status: res.status });
          return "";
        }
        const j: any = await res.json().catch(() => ({}));
        const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (text) { await pool.markOk(k.id, k.model); usedIds.add(k.id); }
        return text;
      } catch (e: any) {
        await pool.markFail(k.id, String(e?.message ?? e).slice(0, 120)).catch(() => null);
        return "";
      }
    };

    const primary = prompts.map((_, i) => keys[i % keys.length]!);
    const first = await Promise.all(prompts.map((p, i) => runOne(p, primary[i]!)));
    const out = [...first];
    /* A failed part is retried on every other key in the pool, in order — the
       OpenRouter behaviour the owner asked for: if one key (or its model) cannot
       do it, the next one tries, and only a pool-wide failure is a failure.
       Long translations are exactly where a single weak key used to leave a
       gap in the middle of the README. */
    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      for (const k of keys) {
        const t = await runOne(prompts[i]!, k);
        if (t) { out[i] = t; break; }
      }
      // last door: the normal chat chain (Workers AI, kept keys, cooling keys)
      if (!out[i]) out[i] = await this.chat(prompts[i]!, opts).catch(() => "");
    }
    return out;
  }

  /** Translate several chunks — one part per pooled key when the pool is big. */
  async translateMany(texts: string[], to = "fa", kind = "readme") {
    const prompts = texts.map((t) => this.translatePrompt(t, to, kind));
    const parts = await this.parallel(prompts, { tier: "smart", max_tokens: 4000, temperature: 0.2, feature: "translate" });
    return parts.map((p) => p ?? "").filter(Boolean);
  }

  /** The prompt used by translate(); split out so parallel() can reuse it. */
  private translatePrompt(text: string, to = "fa", kind = "readme") {
    const clipped = text.slice(0, 22000);
    const langName = to === "fa" ? "fluent Persian (فارسی)" :
                     to === "ar" ? "fluent Arabic (العربية)" :
                     to === "ru" ? "fluent Russian (Русский)" :
                     to === "zh" ? "fluent Simplified Chinese (中文)" :
                     to === "en" ? "fluent English" : to;
    return `Translate the following GitHub ${kind} into ${langName}.\n` +
      `Rules:\n• keep ALL code blocks, commands, file paths, URLs, badges and YAML untouched\n` +
      `• keep markdown structure (headings, lists, tables)\n• translate UI-ish nouns naturally, keep library names in Latin script\n` +
      `• do NOT add commentary, do NOT omit sections\n\n---\n${clipped}`;
  }

  /** Structured extraction: prompt → parsed JSON (with a lenient repair pass). */
  /**
   * Structured output with a self-healing cache.
   *
   * chat() caches whatever text the model produced, including malformed JSON
   * from a weak model. That entry then lives for the whole TTL and every call
   * keeps answering null — which is how a perfectly healthy key still reported
   * "the AI is not available" in search for 24 hours. If parsing fails, drop
   * the entry so the next call asks again.
   */
  async json<T = any>(prompt: string, opts: ChatOpts = {}): Promise<T | null> {
    const raw = await this.chat(prompt, { ...opts, json: true });
    const out = safeJson<T>(raw);
    if (out === null && opts.cacheKey) {
      const cacheKey = `ai:${opts.tier ?? "fast"}:${opts.cacheKey}`;
      await this.env.CACHE.delete(cacheKey).catch(() => null);
    }
    return out;
  }

  /**
   * Is there a usable donated key right now?
   *
   * Cheap path first (KV flag), then the truth (a COUNT on a table with a
   * handful of rows). The flag is a cache, never the source of truth.
   */
  private async poolReady(): Promise<boolean> {
    if (await this.env.CACHE.get("aipool:has").catch(() => null)) return true;
    try {
      const row = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM ai_keys WHERE status IN ('ok','new','warn')")
        .first<{ n: number }>();
      if (Number(row?.n ?? 0) > 0) {
        await this.env.CACHE.put("aipool:has", "1", { expirationTtl: 300 }).catch(() => null);
        return true;
      }
    } catch (e: any) {
      console.error("lens-swallowed", String(e?.message ?? e));
    }
    return false;
  }

  /**
   * Try the donated-key pool. Each key is used with its own base URL and model;
   * failures are accounted per key, and a dead key is deleted on the spot.
   */
  /** Set when the pool was consulted this request (used for honest notices). */
  private poolAttempted = false;

  /**
   * Last resort: the keys that are merely cooling down.
   * Called only when every other engine (Workers AI and the healthy pool) gave
   * up, so a working key is never left unused just because of its timer.
   */
  private async tryCooling(messages: any[], opts: ChatOpts, budget = DEFAULT_DEADLINE_MS): Promise<string> {
    const pool = new KeyPool(this.env);
    const keys = await pool.cooling(2).catch(() => []);
    for (const k of keys) {
      const res = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json" },
        body: JSON.stringify({
          model: k.model,
          messages,
          max_tokens: opts.max_tokens ?? 1024,
          ...(KeyPool.REASONING.test(k.model) ? { reasoning_effort: "low" } : {}),
          temperature: opts.temperature ?? 0.35,
        }),
        signal: AbortSignal.timeout(Math.max(1500, Math.min(20000, budget))),
      }).catch(() => null);
      if (!res?.ok) continue;
      const j: any = await res.json().catch(() => ({}));
      const out = String(j?.choices?.[0]?.message?.content ?? "").trim();
      if (out) { await pool.markOk(k.id, k.model); return out; }
    }
    return "";
  }

  private async tryPool(messages: any[], opts: ChatOpts, budget = DEFAULT_DEADLINE_MS): Promise<string> {
    let keys: { id: number; provider: string; baseUrl: string; model: string; key: string }[] = [];
    try {
      keys = await new KeyPool(this.env).candidates(6);
    } catch (e: any) {
      console.error("keypool-load-failed", String(e?.message ?? e));
      return "";
    }
    this.poolAttempted = true;
    if (!keys.length) {
      await this.env.CACHE.delete("aipool:has").catch(() => null);
      // keys exist but every one is in its post-failure cooldown: say that,
      // instead of blaming the account quota
      const any = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM ai_keys").first<{ n: number }>().catch(() => null);
      if (Number(any?.n ?? 0) > 0) this.failure = "pool-cooling";
      return "";
    }
    await this.env.CACHE.put("aipool:has", "1", { expirationTtl: 300 }).catch(() => null);

    const pool = new KeyPool(this.env);
    let lastPoolError = "";
    /* The caller's budget is the whole answer's budget. A donated key that hangs
       must not outlive it — the timeout here used to be a flat 90 s, which is how
       a six-second answer became a thirty-six-second wait and then silence. */
    const t0 = Date.now();
    const msLeft = () => Math.max(1_500, budget - (Date.now() - t0));
    for (const k of keys) {
      if (budget - (Date.now() - t0) < 1_500) { lastPoolError = "pool: out of time"; break; }
      try {
        const res = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json" },
          body: JSON.stringify({ model: k.model || "auto", messages, max_tokens: opts.max_tokens ?? 1024, temperature: opts.temperature ?? 0.3 }),
          signal: AbortSignal.timeout(msLeft()),
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          // a retired model name is not a dead key: discover the current one,
          // store it and answer with the same key
          if (res.status === 404 && /model/i.test(body)) {
            const fixed_ = await pool.repairModel(k.id, k.baseUrl, k.key).catch(() => null);
            if (fixed_) {
              const retry = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
                method: "POST",
                headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json" },
                body: JSON.stringify({ model: fixed_, messages, max_tokens: opts.max_tokens ?? 1024, temperature: opts.temperature ?? 0.3 }),
                signal: AbortSignal.timeout(msLeft()),
              }).catch(() => null);
              if (retry?.ok) {
                const rj: any = await retry.json().catch(() => ({}));
                const rtext = String(rj?.choices?.[0]?.message?.content ?? "").trim();
                if (rtext) { await pool.markOk(k.id, fixed_); return rtext; }
              }
            }
          }
          const verdict = await pool.markFail(k.id, body, { status: res.status });
          lastPoolError = `${k.provider} ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 120)}`;
          console.error("pool-key-failed", k.id, res.status, verdict);
          // tell the donor their key is gone (best effort, never blocks)
          if (verdict === "deleted") await this.notifyDonor(k.id, res.status, body).catch(() => null);
          continue;
        }
        const j: any = await res.json().catch(() => ({}));
        const out = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (out) {
          await pool.markOk(k.id, k.model);
          return out;
        }
        /* Still empty: this model is wrong for this key, not the key itself.
           Ask the provider for another one, store it, answer with it. */
        const better = await pool.repairModel(k.id, k.baseUrl, k.key, k.model).catch(() => null);
        if (better) {
          const third = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json" },
            body: JSON.stringify({
              model: better,
              messages,
              max_tokens: Math.max(3072, (opts.max_tokens ?? 1024) * 3),
              ...(KeyPool.REASONING.test(better) ? { reasoning_effort: "low" } : {}),
              temperature: opts.temperature ?? 0.35,
            }),
            signal: AbortSignal.timeout(msLeft()),
          }).catch(() => null);
          if (third?.ok) {
            const j3: any = await third.json().catch(() => ({}));
            const out3 = String(j3?.choices?.[0]?.message?.content ?? "").trim();
            if (out3) { await pool.markOk(k.id, better); console.error("ai-key-model-switched", k.id, better); return out3; }
          }
        }
        await pool.markFail(k.id, "empty response", { kind: "model" });
        lastPoolError = `${k.provider}: empty response from ${k.model || "auto"}`;
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 120);
        lastPoolError = `${k.provider}: ${msg}`;
        await pool.markFail(k.id, msg).catch(() => null);
      }
    }
    /* every key was tried and none answered — remember *why* so the notice can
       be honest instead of a vague «محدود شده‌اند» */
    if (lastPoolError) await this.env.CACHE.put("ai:last-pool-error", lastPoolError, { expirationTtl: 1800 }).catch(() => null);
    return "";
  }

  /** Warn the donor that their key left the pool, and why. */
  private async notifyDonor(keyId: number, status: number, body: string) {
    const row = await this.env.DB.prepare(`SELECT owner_id, label, provider FROM ai_keys WHERE id=?`)
      .bind(keyId).first<{ owner_id: number | null; label: string; provider: string }>().catch(() => null);
    const owner = row?.owner_id;
    if (!owner) return;
    let locale = "fa";
    try {
      const u = await this.env.DB.prepare(`SELECT locale FROM users WHERE id=?`).bind(owner).first<{ locale: string }>();
      locale = u?.locale ?? "fa";
    } catch { /* keep default */ }
    const fa = locale === "fa";
    const text = fa
      ? `🔔 <b>کلیدت از استخر خارج شد</b>\n\n` +
        `کلید «${row?.label ?? row?.provider ?? "—"}» جواب نداد (${status}) و چون سوخته/باطل بود همان لحظه حذف شد.\n` +
        `<code>${String(body).slice(0, 160)}</code>\n\n` +
        `اگر کلید تازه‌ای داری، با /keys اهدا کن — با هر کلید، موتور AI ربات برای همه روشن‌تر می‌شود.`
      : `🔔 Your donated key was removed from the pool (HTTP ${status}).`;
    await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: owner, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  }

  private async openaiCompat(messages: any[], opts: ChatOpts) {
    const res = await fetch(`${this.env.OPENAI_COMPAT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.OPENAI_COMPAT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages, max_tokens: opts.max_tokens ?? 1024, temperature: opts.temperature ?? 0.3 }),
    });
    const j: any = await res.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? "";
  }

  private async meter(userId: number, feature: string, chars: number) {
    const day = new Date().toISOString().slice(0, 10);
    await this.env.DB.prepare(
      `INSERT INTO ai_usage (day, user_id, feature, tokens, calls) VALUES (?,?,?,?,1)
       ON CONFLICT(day, user_id, feature) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`,
    ).bind(day, userId, feature, Math.ceil(chars / 4)).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  // ── specialised calls ───────────────────────────────────────────────────

  /** Multilingual → Persian technical translation, format-preserving. */
  translate(text: string, to = "fa", kind = "readme") {
    const clipped = text.slice(0, 22000);
    return this.chat(
      this.translatePrompt(clipped, to, kind),
      {
        tier: "smart",
        max_tokens: 4000,
        temperature: 0.2,
        cacheKey: `tr:${to}:${kind}:${hash(clipped)}`,
        cacheTtl: 2592000,
        feature: "translate",
      },
    );
  }

  /** Repo dossier → structured Persian intelligence brief. */
  analyzeRepo(meta: any) {
    return this.json<{
      what: string; who_for: string; pros: string[]; cons: string[];
      alternatives: string[]; learning_curve: string; production_ready: string;
      security_note: string; one_liner: string; tags_fa: string[];
    }>(
      `Analyse this GitHub repository and answer in Persian (فارسی).\n` +
        `Data: ${JSON.stringify({
          full_name: meta.full_name, description: meta.description, stars: meta.stars, forks: meta.forks,
          issues: meta.issues, open_prs: meta.prs, language: meta.language,
          languages: (meta.languages ?? []).slice(0, 6).map((l: any) => l.name),
          topics: (meta.topics ?? []).slice(0, 12), license: meta.license, archived: meta.archived,
          pushed_at: meta.pushed_at, created_at: meta.created_at, contributors: meta.contributors,
          community_health: meta.community_health, red_flags: meta.redFlags,
          recent_commits: (meta.raw?.commitHistory?.target?.history?.nodes ?? []).slice(0, 10).map((c: any) => c.messageHeadline),
        })}\n` +
        `Return JSON with keys: one_liner (max 90 chars), what (3 sentences), who_for, pros (3-5 bullets), ` +
        `cons (2-4 bullets, be honest about weaknesses), alternatives (up to 3 real competing projects), ` +
        `learning_curve (کم/متوسط/زیاد + یک جمله), production_ready (بله/خیر/با احتیاط + دلیل), ` +
        `security_note, tags_fa (5 Persian tags).`,
      { tier: "smart", max_tokens: 1600, cacheKey: `ana:${meta.full_name}:${meta.stars}`, cacheTtl: 604800 },
    );
  }

  /** Semantic query understanding for search: Persian/English NL → GitHub search query. */
  /**
   * Search planner, with an output sanity gate.
   *
   * Small models sometimes answer in the wrong script entirely (a Vietnamese/
   * Cyrillic mash was cached and every later search used it as its query). A
   * plan is only accepted when the GitHub query is plain ASCII, short, and free
   * of invented qualifiers; otherwise the cache entry is dropped and the
   * offline keyword layer takes over.
   */
  async plan_search(query: string, locale = "fa") {
    const plan = await this.json<{ github_query: string; keywords: string[]; language: string | null; topics: string[]; sort: string; explain_fa: string }>(
      `A user (language: ${locale}) asks: "${query}"\n` +
        `Convert it into a GitHub repository search. Return JSON: github_query (valid GitHub search qualifiers, ` +
        `e.g. "language:typescript stars:>500 topic:state-management"), keywords (array, English), ` +
        `language (or null), topics (array), sort (stars|updated|forks|best-match), explain_fa (one Persian sentence ` +
        `explaining how you understood the request).`,
      { tier: "fast", max_tokens: 500, cacheKey: `plan:${hash(query)}`, cacheTtl: 86400 },
    );
    const cacheKey = `ai:fast:plan:${hash(query)}`;
    if (!plan) return null;
    const q = String(plan.github_query ?? "").trim();
    const badQuery = !q || q.length > 200 || /[^\x20-\x7E]/.test(q) || /\bundefined\b/i.test(q);
    const badExplain = !!plan.explain_fa && /[ăâêôơưđĐ]|[а-яА-Я]/i.test(String(plan.explain_fa));
    if (badQuery || badExplain) {
      console.error("ai-plan-rejected", badQuery ? `query:${q.slice(0, 60)}` : "explain");
      await this.env.CACHE.delete(cacheKey).catch(() => null);
      return null;
    }
    return { ...plan, github_query: q, keywords: Array.isArray(plan.keywords) ? plan.keywords.filter((k) => typeof k === "string" && /^[\x20-\x7E]+$/.test(k)).slice(0, 8) : [] };
  }

  /** Changelog writer: commits → human release notes (fa or en). */
  changelog(commits: { message: string; author?: string }[], locale = "fa") {
    return this.chat(
      `Write concise release notes in ${locale === "fa" ? "Persian" : "English"} from these commits.\n` +
        `Group by: 🚀 Features, 🐛 Fixes, ⚡ Performance, 📝 Docs, 🔧 Chore. Skip noise (typos, merges).\n` +
        `Commits:\n${commits.map((c) => `- ${c.message}`).join("\n").slice(0, 6000)}`,
      { tier: "fast", max_tokens: 800, cacheKey: `chg:${hash(commits.map((c) => c.message).join("|"))}`, cacheTtl: 604800 },
    );
  }

  /** GitHub Actions / workflow generator. */
  workflow(description: string) {
    return this.chat(
      `Write a production-grade GitHub Actions workflow YAML for: "${description}".\n` +
        `Include caching, matrix where useful, least-privilege permissions and comments. Return YAML only.`,
      { tier: "code", max_tokens: 1400, temperature: 0.2 },
    );
  }

  /** Code explainer for a file the user pasted or a repo path. */
  explainCode(code: string, locale = "fa") {
    return this.chat(
      `Explain this code in ${locale === "fa" ? "Persian" : "English"} for a mid-level developer.\n` +
        `Cover: purpose, flow, tricky parts, complexity, and 2 improvement suggestions.\n\n\`\`\`\n${code.slice(0, 9000)}\n\`\`\``,
      { tier: "code", max_tokens: 1400, temperature: 0.3, cacheKey: `exp:${hash(code)}`, cacheTtl: 604800 },
    );
  }

  /** PR review assistant. */
  reviewPR(diff: string, locale = "fa") {
    return this.chat(
      `Review this pull-request diff like a senior engineer. In ${locale === "fa" ? "Persian" : "English"}.\n` +
        `Sections: 🔍 خلاصه تغییرات، ⚠️ ریسکها/باگهای احتمالی، 🧪 تستهای لازم، ✅ پیشنهادهای کد.\n\n${diff.slice(0, 12000)}`,
      { tier: "code", max_tokens: 1600, temperature: 0.3 },
    );
  }

  // ── embeddings ──────────────────────────────────────────────────────────
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20).map((t) => t.slice(0, 6000));
      const res: any = await this.env.AI.run("@cf/baai/bge-m3" as any, { text: batch } as any);
      const vecs: number[][] = res?.data ?? [];
      out.push(...vecs);
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    const v = await this.embed([text]);
    return v[0] ?? new Array(1024).fill(0);
  }

  /** Voice → text. This is the only audio path left: a mic as a keyboard,
   * never a voice the bot speaks with. */
  async transcribe(audio: ArrayBuffer, locale = "fa"): Promise<string> {
    try {
      const res: any = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, {
        audio: [...new Uint8Array(audio)],
        language: locale,
      } as any);
      return (res?.text ?? "").trim();
    } catch {
      return "";
    }
  }
}

/** hash for cache keys (FNV-1a, fast + stable). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

/** Lenient JSON parse: handles fences, trailing commas, single quotes, prefix text. */
export function safeJson<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0));
  if (Number.isFinite(start) && start > 0) s = s.slice(start);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (end > 0) s = s.slice(0, end + 1);
  for (const attempt of [s, s.replace(/,\s*([}\]])/g, "$1"), s.replace(/'/g, '"'), s.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"')]) {
    try { return JSON.parse(attempt) as T; } catch { /* next */ }
  }
  return null;
}

/** Normalise every shape Workers AI returns audio in into raw bytes. */
export async function audioBytes(res: any): Promise<ArrayBuffer | null> {
  if (!res) return null;
  const pick = res.audio ?? res.audio_base64 ?? res;
  if (pick instanceof ReadableStream) return await new Response(pick).arrayBuffer();
  if (pick instanceof ArrayBuffer) return pick;
  if (ArrayBuffer.isView(pick)) return (pick.buffer as ArrayBuffer).slice(pick.byteOffset, pick.byteOffset + pick.byteLength);
  if (Array.isArray(pick)) return new Uint8Array(pick as number[]).buffer;
  if (typeof pick === "string") {
    if (pick.length < 200) return null;
    const b64 = pick.includes(",") ? pick.split(",").pop()! : pick;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    } catch { return null; }
  }
  return null;
}

/** Short human description of an unknown AI result (used in health output). */
export function describe(res: any): string {
  if (res == null) return "null";
  if (typeof res === "string") return `string(${res.length})`;
  if (res instanceof ReadableStream) return "stream";
  if (res instanceof ArrayBuffer) return `ArrayBuffer(${res.byteLength})`;
  if (res instanceof Uint8Array) return `Uint8Array(${res.byteLength})`;
  if (typeof res === "object") return "keys:" + Object.keys(res).slice(0, 6).join("|");
  return typeof res;
}


/**
 * Persian/English explanation for a dead AI path — used wherever a feature
 * would otherwise answer with a shrug. Never invents an apology: it names the
 * cause and the way out.
 */
export async function aiDownNotice(env: Env, loc: string): Promise<string> {
  let reason: AiFailure = null;
  try {
    const raw = await env.CACHE.get("ai:last-failure");
    reason = raw ? (JSON.parse(raw).reason as AiFailure) : null;
  } catch {
    reason = null;
  }
  /* If the breaker is open but the recorded cause was cleared (a new key, a
     reset), the trip itself is the evidence: it is only ever set when the
     day's neurons ran out. Without this the user gets a vague "did not answer"
     while the honest answer is "the free quota is spent, here is the way out". */
  if (!reason && (await env.CACHE.get("ai:halt").catch(() => null))) reason = "quota";
  const fa = loc === "fa";
  if (reason === "quota") {
    return fa
      ? "⚠️ سهمیهٔ رایگان هوش مصنوعی این حساب برای امروز تمام شده (۱۰٬۰۰۰ نورون).\n" +
        "• چند ساعت دیگر یا فردا خودش برمی‌گردد\n" +
        "• یا اپراتور می‌تواند یک کلید سازگار با OpenAI (Groq / OpenRouter / Gemini) بسازد و با <code>OPENAI_COMPAT_KEY</code> وصل کند؛ آن سهمیه جداست.\n" +
        "بقیهٔ ربات بدون AI کار می‌کند."
      : "⚠️ The account's free Workers AI neurons are spent for today. It resets automatically, or add an OpenAI-compatible key (Groq / OpenRouter / Gemini) as OPENAI_COMPAT_KEY. Everything else keeps working.";
  }
  if (reason === "timeout") {
    /* The honest version of "nothing happened": the model was thinking when the
       platform's time for this update ran out. Saying so beats a spinner that
       never stops, and the two fixes are both one tap away. */
    return fa
      ? "⏱ مدل در این نوبت کند بود و در ۲۰ ثانیه جواب نداد — نه اینکه خراب باشد.\n" +
        "• دوباره بپرس (اغلب بار دوم سریع است)\n" +
        "• یا سؤال را کوتاه‌تر/دقیق‌تر بپرس تا سریع‌تر جواب بگیرد\n" +
        "بقیهٔ ربات بی‌ربط به این موضوع کار می‌کند."
      : "⏱ The model was slow and did not answer within 20 seconds this time. Ask again, or ask something shorter — everything else works.";
  }
  if (reason === "pool-cooling") {
    /* Say what actually happened. «همهٔ کلیدها را یکی‌یکی امتحان کردم و این
       خطا آمد» is actionable; «محدود شده‌اند» made a 503 from one custom
       server look like a mysterious provider-wide rate limit. */
    const detail = String((await env.CACHE.get("ai:last-pool-error").catch(() => "")) ?? "").slice(0, 200);
    return fa
      ? "⏳ <b>همهٔ کلیدهای استخر امتحان شدند و هیچ‌کدام جواب نداد</b>\n" +
        (detail ? `آخرین خطا: <code>${detail.replace(/[<>]/g, "")}</code>\n` : "") +
        "• چند دقیقه دیگر خودکار دوباره امتحان می‌شوند\n" +
        "• اگر کلید تازه‌ای اهدا شود، بلافاصله استفاده می‌شود\n" +
        "بقیهٔ ربات (جست‌وجو، مخزن‌ها، ابزارها) کامل کار می‌کند."
      : "⏳ Every donated key was tried and none answered" + (detail ? ` — last error: ${detail}` : "") + ".";
  }
  if (reason === "missing") {
    return fa
      ? "⚠️ مدل‌های هوش مصنوعی این حساب در دسترس نیستند (شناسهٔ مدل منقضی شده)."
      : "⚠️ No available model on this account (stale model ids).";
  }
  return fa
    ? "⚠️ هوش مصنوعی الان پاسخ نداد؛ چند لحظه بعد دوباره تلاش کن."
    : "⚠️ The AI backend did not answer; try again in a moment.";
}


/** Seconds until the Workers AI free-neuron counter resets (UTC midnight). */
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(900, Math.min(86400, Math.floor((next - now.getTime()) / 1000)));
}

/** True while the AI circuit breaker is open (free neurons spent). */
export async function aiHalted(env: Env): Promise<boolean> {
  return !!(await env.CACHE.get("ai:halt").catch(() => null));
}
