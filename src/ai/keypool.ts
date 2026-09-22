import type { Env } from "../env";
import { decryptSecret, encryptSecret } from "../core/crypto";

/**
 * Donated-key pool.
 *
 * Anyone can hand the bot an OpenAI-compatible key (OpenRouter, Groq, xAI,
 * OpenAI, Gemini, a local server …). Keys are pooled — the pool answers with
 * whichever key is healthy, so many small free keys add up to one working AI
 * backend. A key that comes back 401/402/403/429-hard is deleted from the pool
 * immediately: no dead key ever gets retried, and the donor is told why.
 *
 * Only ciphertext is stored (AES-GCM, purpose "ai-key"); the plaintext exists
 * for the duration of a single request.
 */

export type Provider = "openrouter" | "groq" | "openai" | "xai" | "gemini" | "custom" | "local";

export interface ProviderPreset {
  id: Provider;
  label: string;
  baseUrl: string;
  /** Sensible default model; the donor may override it. */
  model: string;
  hint?: string;
  /** Keys for these providers can be validated against /models as well. */
  free?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", hint: "مدل‌های رایگان زیاد دارد؛ با :free انتخاب کن", free: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", hint: "سریع و سخاوتمند در پلن رایگان", free: true },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", hint: "پلن رایگان روزانه دارد", free: true },
  { id: "xai", label: "xAI · Grok", baseUrl: "https://api.x.ai/v1", model: "grok-4", hint: "کلید سهمیه‌دار" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hint: "کلید سهمیه‌دار" },
  { id: "custom", label: "سفارشی (Custom)", baseUrl: "", model: "", hint: "آدرس پایه و نام مدل را خودت بده" },
  { id: "local", label: "Local (Ollama / LM Studio)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", hint: "باید از شبکهٔ ورکر در دسترس باشد" },
];

export const providerPreset = (id: string): ProviderPreset | undefined => PROVIDERS.find((p) => p.id === id);

export interface PoolKey {
  id: number;
  owner_id: number | null;
  label: string;
  provider: string;
  base_url: string;
  model: string;
  enc_key: string;
  status: string;
  ok_count: number;
  fail_count: number;
  last_ok_at: number | null;
  last_fail_at: number | null;
  last_err: string | null;
  created_at: number;
}

/** Plaintext credential for one request. */
export interface LiveKey { id: number; provider: string; baseUrl: string; model: string; key: string }

export class KeyPool {
  constructor(private env: Env) {}

  private static readonly CACHE_KEY = "aipool:keys:v1";

  /** How long a merely-failed key (429, timeout, provider hiccup) stays out. */
  static readonly COOLDOWN_MS = 10 * 60_000;

  /** Pool ordered for use: healthiest first, least-recently-used first. */
  /**
   * Keys that answered recently but are sitting in the cooldown right now.
   * Used as a last resort: if every other engine failed and the only thing
   * standing between the user and an answer is a 10-minute timer, waiting is
   * worse than trying again.
   */
  async cooling(limit = 2): Promise<LiveKey[]> {
    const rows = await this.rows();
    const out: LiveKey[] = [];
    for (const r of rows
      .filter((r) => r.status === "warn" && Number(r.ok_count ?? 0) > 0 &&
        Date.now() - Number(r.last_fail_at ?? 0) <= KeyPool.COOLDOWN_MS)
      .slice(0, limit)) {
      const key = await decryptSecret(this.env, r.enc_key, "ai-key");
      if (key !== null) out.push({ id: r.id, provider: r.provider, baseUrl: r.base_url, model: r.model, key });
    }
    return out;
  }

  async candidates(limit = 8): Promise<LiveKey[]> {
    const cached = await this.env.CACHE.get<PoolKey[]>(KeyPool.CACHE_KEY, "json").catch(() => null);
    const rows = cached ?? (await this.rows()).slice(0, 40);
    if (!cached) await this.env.CACHE.put(KeyPool.CACHE_KEY, JSON.stringify(rows), { expirationTtl: 120 })
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    /* OpenRouter-style rotation: every key is a candidate, healthy ones first.
       A key that was merely rate-limited used to be filtered out for ten
       minutes, so a pool with one donated key answered «کلیدها محدود شده‌اند»
       while the key itself was fine a second later. Now the healthy keys are
       tried in round-robin order and anything parked is tried after them —
       worse case one extra request, best case a real answer. */
    const now = Date.now();
    const age = (r: PoolKey) => Number(r.last_ok_at ?? 0);
    const healthy = rows.filter((r) => r.status === "ok" || r.status === "new").sort((a, b) => age(a) - age(b));
    const parked = rows
      .filter((r) => r.status !== "ok" && r.status !== "new")
      .sort((a, b) => {
        const coolA = now - Number(a.last_fail_at ?? 0) <= KeyPool.COOLDOWN_MS ? 1 : 0;
        const coolB = now - Number(b.last_fail_at ?? 0) <= KeyPool.COOLDOWN_MS ? 1 : 0;
        return coolA - coolB || age(b) - age(a);   // proven keys first among the parked
      });
    const usable = [...healthy, ...parked].slice(0, limit);

    const out: LiveKey[] = [];
    for (const r of usable) {
      const key = await decryptSecret(this.env, r.enc_key, "ai-key");
      // decryptSecret returns null only on a real crypto failure; an empty
      // string is a legitimate "this endpoint needs no key" donor
      if (key !== null) out.push({ id: r.id, provider: r.provider, baseUrl: r.base_url, model: r.model, key });
      else await this.remove(r.id, "decrypt failed");
    }
    return out;
  }

  async rows(): Promise<PoolKey[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM ai_keys ORDER BY (status='ok') DESC, last_ok_at DESC, id DESC LIMIT 200`,
    ).all<PoolKey>().catch(() => ({ results: [] as PoolKey[] }));
    return results ?? [];
  }

  async stats() {
    const r = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok FROM ai_keys`,
    ).first<{ total: number; ok: number }>().catch(() => null);
    return { total: r?.total ?? 0, ok: r?.ok ?? 0 };
  }

  async add(opts: {
    ownerId: number | null; label: string; provider: string; baseUrl: string;
    model: string; key: string; status?: "ok" | "warn" | "new"; lastFailAt?: number;
  }) {
    const enc = await encryptSecret(this.env, opts.key, "ai-key");
    const status = opts.status ?? "ok";
    const res = await this.env.DB.prepare(
      `INSERT INTO ai_keys (owner_id, label, provider, base_url, model, enc_key, status, ok_count, fail_count, last_ok_at, last_fail_at, created_at)
       VALUES (?,?,?,?,?,?, ?, 0, 0, ?, ?, ?)`,
    ).bind(
      opts.ownerId, opts.label.slice(0, 40), opts.provider, opts.baseUrl, opts.model, enc, status,
      status === "ok" ? Date.now() : null, opts.lastFailAt ?? null, Date.now(),
    ).run();
    await this.invalidate();
    return Number((res as any)?.meta?.last_row_id ?? 0);
  }

  async remove(id: number, reason = "removed") {
    await this.env.DB.prepare(`DELETE FROM ai_keys WHERE id=?`).bind(id).run()
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    console.log("keypool-remove", id, reason);
    await this.invalidate();
  }

  async markOk(id: number, model: string) {
    await this.env.DB.prepare(
      `UPDATE ai_keys SET status='ok', ok_count=ok_count+1, last_ok_at=?, last_err=NULL, model=CASE WHEN ?='' THEN model ELSE ? END WHERE id=?`,
    ).bind(Date.now(), model, model, id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
  }

  /**
   * Verdict on a failed call: is the key itself dead, or is the provider busy?
   *
   * This used to be one regex over the whole error string (`/401|403|402|…
   * quota|credit/`), which deleted the owner's healthiest key: a Groq 429 body
   * contains the word "quota", and pressing «تست کل استخر» fed that straight in
   * — 120 successful calls thrown away because the provider was busy for a
   * second.
   *
   * A key is removed ONLY when the provider says in so many words that the key
   * is invalid or the account has no credit, and never on a 429/5xx/timeout.
   * Everything else parks the key on cooldown and the pool moves to the next
   * one. A key that has already answered for us needs two refusals in a row
   * before it is deleted — a single strange 401 is not proof of death.
   */
  async markFail(id: number, err: string, meta: { status?: number; kind?: string } = {}): Promise<"deleted" | "kept"> {
    const text = String(err ?? "").toLowerCase();
    const code = Number(meta.status ?? 0) || Number((text.match(/\b(4\d\d|5\d\d)\b/) ?? [])[1] ?? 0);
    const kind = meta.kind ?? "";
    const busy = code === 429 || code >= 500 || code === 408 || kind === "rate" ||
      /rate.?limit|too many requests|resource[_ ]?exhausted|overloaded|timeout|timed out|fetch failed|empty response/.test(text);
    const authRefusal = /invalid[_ -]?api[_ -]?key|incorrect api key|api key not valid|invalid_api_key|unauthorized|no auth|authentication failed/.test(text) ||
      /\b(revoked|disabled|expired)\b/.test(text) && /key|token/.test(text);
    const creditRefusal = /insufficient|out of credit|no credit|exceeded your current quota|payment required|billing hard limit|credit balance/.test(text);
    const explicit = authRefusal || creditRefusal || kind === "auth" || kind === "quota";
    const row = await this.env.DB.prepare(`SELECT ok_count, fail_count FROM ai_keys WHERE id=?`).bind(id)
      .first<{ ok_count: number; fail_count: number }>().catch(() => null);
    const proven = Number(row?.ok_count ?? 0) > 0;
    const strikes = Number(row?.fail_count ?? 0);
    const statusSaysDead = code === 400 || code === 401 || code === 402 || code === 403;
    const fatal = explicit && !busy && statusSaysDead && (!proven || strikes >= 1);
    if (fatal) {
      await this.remove(id, `${code || "?"} ${err}`.slice(0, 80));
      return "deleted";
    }
    await this.env.DB.prepare(
      `UPDATE ai_keys SET status='warn', fail_count=fail_count+1, last_fail_at=?, last_err=? WHERE id=?`,
    ).bind(Date.now(), err.slice(0, 160), id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
    return "kept";
  }

  /**
   * Repair a stored key whose model name no longer exists.
   *
   * Providers retire model ids (Groq does it constantly). A stored key that
   * suddenly 404s is not a dead key — it is a key with a stale model name. We
   * ask the provider what it serves, verify the first usable chat model, store
   * that name and put the key back in service. Without this, one retirement
   * would silently remove a working key from the pool.
   */
  async repairModel(id: number, baseUrl: string, key: string, avoid?: string): Promise<string | null> {
    const { models } = await KeyPool.listModels(baseUrl, key).catch(() => ({ models: [] as string[] }));
    for (const candidate of models
      .filter((m) => !KeyPool.NOT_CHAT.test(m) && m !== avoid)
      .slice(0, 5)) {
      try {
        const r = await KeyPool.ping(KeyPool.normalizeBase(baseUrl), key, candidate);
        if (!r.ok) continue;
        await this.env.DB.prepare(
          `UPDATE ai_keys SET model=?, status='ok', last_err=NULL WHERE id=?`,
        ).bind(candidate, id).run().catch(() => null);
        await this.invalidate();
        console.error("keypool-model-repaired", id, candidate);
        return candidate;
      } catch { /* next candidate */ }
    }
    return null;
  }

  async invalidate() {
    await this.env.CACHE.delete(KeyPool.CACHE_KEY).catch(() => null);
  }

  /**
   * Normalise whatever the user pasted into a base URL.
   *
   * People paste the endpoint they copied from a docs page — the owner pasted
   * `https://kktoken.cc/v1/chat/completions`, which we then asked for
   * `/chat/completions/models` and got a 404 that looked like a bad key.
   * Everything from the endpoint onwards is stripped.
   */
  static normalizeBase(raw: string): string {
    let u = String(raw ?? "").trim().replace(/\s+/g, "");
    u = u.replace(/\/(chat\/completions|completions|chat|models|embeddings)\/?$/i, "");
    u = u.replace(/\/+$/, "");
    return u;
  }

  /** Last-resort model ids for endpoints with no /models list. */
  private static readonly GUESSES = ["gpt-4o-mini", "openai", "llama-3.3-70b-versatile", "mistral-small-latest"];

  /** Model names that are almost always wrong for a chat call. */
  private static readonly NOT_CHAT = /(embed|embedding|whisper|tts|audio|image|dall|moderation|rerank|clip|stable|flux|guard|vision-encoder)/i;

  /**
   * Reasoning models spend their budget thinking and can return an *empty*
   * message when max_tokens is small — which looks exactly like a broken key.
   * They still work (we set reasoning_effort low), but plain chat models are
   * tried first.
   */
  static readonly REASONING = /(gpt-oss|deepseek-r1|\bqwq|\bo1\b|\bo3\b|\bo4\b|thinking|reasoner|magistral)/i;

  /**
   * Ask the provider which models it has, best-first for chat.
   * Free/cheap chat models first, embedding and image models last.
   */
  static async listModels(baseUrl: string, key: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const url = KeyPool.normalizeBase(baseUrl);
    try {
      const res = await fetch(`${url}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, models: [], error: `${res.status} ${(await res.text()).slice(0, 160)}` };
      const j: any = await res.json().catch(() => ({}));
      const ids: string[] = (j?.data ?? j?.models ?? []).map((m: any) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
      const rank = (id: string) => {
        let s = 0;
        if (KeyPool.NOT_CHAT.test(id)) s += 100;                        // never a chat model
        if (KeyPool.REASONING.test(id)) s += 12;                        // usable, but last
        if (/free/i.test(id)) s -= 3;                                   // free tiers first
        if (/70b|72b|large|pro|sonnet|gpt-4|gpt-5|o[13]|command-r|mixtral/i.test(id)) s -= 2;
        if (/8b|7b|mini|flash|lite|small|instant|haiku/i.test(id)) s -= 1;
        return s;
      };
      return { ok: true, models: [...new Set(ids)].sort((a, b) => rank(a) - rank(b)) };
    } catch (e: any) {
      return { ok: false, models: [], error: String(e?.message ?? e).slice(0, 160) };
    }
  }

  /** One chat ping. */
  private static async ping(url: string, key: string, model: string) {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),   // keyless endpoints are welcome
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(model === "ping-probe" ? 8000 : 20000),
    });
    const body = (await res.text()).slice(0, 200);
    if (!res.ok) return { ok: false as const, status: res.status, error: body };
    let reply = "";
    try { reply = String(JSON.parse(body)?.choices?.[0]?.message?.content ?? ""); } catch { /* keep empty */ }
    return { ok: true as const, status: res.status, reply };
  }

  /**
   * Live test used when a key is donated (and by the "test" button later).
   *
   * The important part: a *valid* key must never be rejected because the model
   * name was guesswork. Groq retired the default we shipped, so a working key
   * failed with model_not_found and the user was told their key was broken.
   * Now we ask the provider for its model list and try again — twice — before
   * we call anything broken, and we hand the working model name back so it can
   * be stored.
   */
  static async test(baseUrl: string, key: string, model: string): Promise<{
    ok: boolean; error?: string; errorKind?: "auth" | "quota" | "rate" | "url" | "model" | "net";
    models?: string[]; reply?: string; model?: string;
  }> {
    const url = KeyPool.normalizeBase(baseUrl);
    const kindOf = (status: number, body: string): "auth" | "quota" | "rate" | "url" | "model" | "net" => {
      if (status === 401 || status === 403 || /invalid api key|unauthorized|no auth|invalid_api_key/i.test(body)) return "auth";
      // 402 = out of credit (the key is dead), 429 = busy right now (the key is fine)
      if (status === 402 || /insufficient|out of credit|quota exceeded/i.test(body)) return "quota";
      if (status === 429 || /rate limit|too many requests|tpm|rpm/i.test(body)) return "rate";
      if (status === 404 && /model/i.test(body)) return "model";
      if (status === 404 || /invalid url|not found/i.test(body)) return "url";
      if (/model.*(not|does not).*(exist|found)|unknown model|no such model|model_not_found/i.test(body)) return "model";
      return "net";
    };

    // 1. the model we were given (if any)
    if (model) {
      try {
        const r = await KeyPool.ping(url, key, model);
        if (r.ok) return { ok: true, reply: r.reply.slice(0, 40), model, models: [model] };
        const kind = kindOf(r.status, r.error);
        if (kind === "auth" || kind === "quota") return { ok: false, error: `${r.status} ${r.error}`, errorKind: kind };
        // model/url problems fall through to discovery
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 160), errorKind: "net" };
      }
    }

    // 2. ask the provider what it actually serves
    const list = await KeyPool.listModels(url, key);
    if (!list.ok && /401|403|invalid api key|unauthorized/i.test(list.error ?? ""))
      return { ok: false, error: list.error, errorKind: "auth" };
    const candidates = (list.models ?? []).filter((m) => !KeyPool.NOT_CHAT.test(m)).slice(0, 6);

    /* Some OpenAI-compatible endpoints answer /chat/completions but expose no
       /models list at all (pollinations, small self-hosted gateways). Rather
       than reject a key that works, try the handful of model ids those servers
       actually use. */
    // a rejected key must be reported as such — not as "no usable model"
    let refusals: { kind: "auth" | "quota" | "rate"; error: string } | null = null;
    let lastError = "";
    const attempt = async (candidate: string) => {
      try {
        const r = await KeyPool.ping(url, key, candidate);
        if (r.ok) return { ok: true as const, reply: r.reply.slice(0, 40), model: candidate, models: list.models?.length ? list.models : [candidate] };
        const kind = kindOf(r.status, r.error);
        lastError = `${r.status} ${r.error}`;
        if (kind === "auth" || kind === "quota" || kind === "rate") refusals = refusals ?? { kind, error: lastError };
      } catch (e: any) {
        lastError = String(e?.message ?? e).slice(0, 160);
      }
      return null;
    };

    if (!candidates.length && !model) {
      for (const guess of KeyPool.GUESSES) {
        const hit = await attempt(guess);
        if (hit) return hit;
        if (refusals) break;   // an auth failure will not improve with another model name
      }
    }

    for (const candidate of candidates) {
      const hit = await attempt(candidate);
      if (hit) return hit;
      if (refusals) break;
    }
    if (refusals) return { ok: false, error: (refusals as any).error, errorKind: (refusals as any).kind, models: list.models };

    // 3. nothing from the list — say why, precisely
    if (!list.ok) {
      return {
        ok: false,
        error: list.error ?? "no /models endpoint",
        errorKind: /401|403|invalid api key|unauthorized/i.test(list.error ?? "") ? "auth" : "url",
      };
    }
    return {
      ok: false,
      error: model
        ? `model "${model}" and ${candidates.length} alternative(s) were refused by this endpoint`
        : lastError || "the endpoint lists no usable chat model",
      errorKind: "model",
      models: list.models,
    };
  }
}
