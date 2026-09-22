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
  last_err: string | null;
  created_at: number;
}

/** Plaintext credential for one request. */
export interface LiveKey { id: number; provider: string; baseUrl: string; model: string; key: string }

export class KeyPool {
  constructor(private env: Env) {}

  private static readonly CACHE_KEY = "aipool:keys:v1";

  /** Pool ordered for use: healthiest first, least-recently-used first. */
  async candidates(limit = 8): Promise<LiveKey[]> {
    const cached = await this.env.CACHE.get<PoolKey[]>(KeyPool.CACHE_KEY, "json").catch(() => null);
    const rows = cached ?? (await this.rows()).slice(0, 40);
    if (!cached) await this.env.CACHE.put(KeyPool.CACHE_KEY, JSON.stringify(rows), { expirationTtl: 45 })
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    const usable = rows
      .filter((r) => r.status === "ok" || r.status === "new")
      .sort((a, b) => (a.last_ok_at ?? 0) - (b.last_ok_at ?? 0))   // round-robin by age
      .slice(0, limit);

    const out: LiveKey[] = [];
    for (const r of usable) {
      const key = await decryptSecret(this.env, r.enc_key, "ai-key");
      if (key) out.push({ id: r.id, provider: r.provider, baseUrl: r.base_url, model: r.model, key });
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

  async add(opts: { ownerId: number | null; label: string; provider: string; baseUrl: string; model: string; key: string }) {
    const enc = await encryptSecret(this.env, opts.key, "ai-key");
    const res = await this.env.DB.prepare(
      `INSERT INTO ai_keys (owner_id, label, provider, base_url, model, enc_key, status, ok_count, fail_count, created_at)
       VALUES (?,?,?,?,?,?, 'ok', 0, 0, ?)`,
    ).bind(opts.ownerId, opts.label.slice(0, 40), opts.provider, opts.baseUrl, opts.model, enc, Date.now()).run();
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

  async markFail(id: number, err: string): Promise<"deleted" | "kept"> {
    // hard failures mean the key itself is gone: quota, revoked, unpaid
    if (/401|403|402|invalid api key|insufficient|quota|credit|expired|no auth/i.test(err)) {
      await this.remove(id, err.slice(0, 80));
      return "deleted";
    }
    await this.env.DB.prepare(
      `UPDATE ai_keys SET status='warn', fail_count=fail_count+1, last_err=? WHERE id=?`,
    ).bind(err.slice(0, 160), id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
    return "kept";
  }

  async invalidate() {
    await this.env.CACHE.delete(KeyPool.CACHE_KEY).catch(() => null);
  }

  /**
   * Live test used when a key is donated (and by the "test" button later).
   * Returns the model list when the endpoint exposes one.
   */
  static async test(baseUrl: string, key: string, model: string): Promise<{ ok: boolean; error?: string; models?: string[]; reply?: string }> {
    const url = baseUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    try {
      if (!model) {
        const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 120)}` };
        const j: any = await res.json().catch(() => ({}));
        return { ok: true, models: (j?.data ?? []).map((m: any) => m.id).slice(0, 400) };
      }
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        return { ok: false, error: `${res.status} ${body}` };
      }
      const j: any = await res.json().catch(() => ({}));
      const reply = j?.choices?.[0]?.message?.content ?? "";
      return { ok: true, reply: String(reply).slice(0, 40) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
    }
  }
}
