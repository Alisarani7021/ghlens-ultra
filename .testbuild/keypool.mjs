var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// src/core/crypto.ts
async function tokenKey(env, purpose = "github-token") {
  const secret = env.TOKEN_ENCRYPTION_KEY || env.DOWNLOAD_SIGNING_KEY || env.TELEGRAM_WEBHOOK_SECRET;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ghlens-token-v1"), info: new TextEncoder().encode(purpose) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptSecret(env, plain, purpose = "github-token") {
  const key = await tokenKey(env, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...packed));
}
async function decryptSecret(env, packedB64, purpose = "github-token") {
  try {
    const packed = Uint8Array.from(atob(packedB64), (c) => c.charCodeAt(0));
    const key = await tokenKey(env, purpose);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12));
    return new TextDecoder().decode(plain);
  } catch (e) {
    console.error("secret-decrypt-failed", String(e?.message ?? e));
    return null;
  }
}

// src/ai/keypool.ts
var PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", hint: "\u0645\u062F\u0644\u200C\u0647\u0627\u06CC \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0632\u06CC\u0627\u062F \u062F\u0627\u0631\u062F\u061B \u0628\u0627 :free \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646", free: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", hint: "\u0633\u0631\u06CC\u0639 \u0648 \u0633\u062E\u0627\u0648\u062A\u0645\u0646\u062F \u062F\u0631 \u067E\u0644\u0646 \u0631\u0627\u06CC\u06AF\u0627\u0646", free: true },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", hint: "\u067E\u0644\u0646 \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0631\u0648\u0632\u0627\u0646\u0647 \u062F\u0627\u0631\u062F", free: true },
  { id: "xai", label: "xAI \xB7 Grok", baseUrl: "https://api.x.ai/v1", model: "grok-4", hint: "\u06A9\u0644\u06CC\u062F \u0633\u0647\u0645\u06CC\u0647\u200C\u062F\u0627\u0631" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hint: "\u06A9\u0644\u06CC\u062F \u0633\u0647\u0645\u06CC\u0647\u200C\u062F\u0627\u0631" },
  { id: "custom", label: "\u0633\u0641\u0627\u0631\u0634\u06CC (Custom)", baseUrl: "", model: "", hint: "\u0622\u062F\u0631\u0633 \u067E\u0627\u06CC\u0647 \u0648 \u0646\u0627\u0645 \u0645\u062F\u0644 \u0631\u0627 \u062E\u0648\u062F\u062A \u0628\u062F\u0647" },
  { id: "local", label: "Local (Ollama / LM Studio)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", hint: "\u0628\u0627\u06CC\u062F \u0627\u0632 \u0634\u0628\u06A9\u0647\u0654 \u0648\u0631\u06A9\u0631 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0628\u0627\u0634\u062F" }
];
var providerPreset = (id) => PROVIDERS.find((p) => p.id === id);
var _KeyPool = class {
  constructor(env) {
    this.env = env;
  }
  /** Pool ordered for use: healthiest first, least-recently-used first. */
  async candidates(limit = 8) {
    const cached = await this.env.CACHE.get(_KeyPool.CACHE_KEY, "json").catch(() => null);
    const rows = cached ?? (await this.rows()).slice(0, 40);
    if (!cached)
      await this.env.CACHE.put(_KeyPool.CACHE_KEY, JSON.stringify(rows), { expirationTtl: 45 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    const usable = rows.filter((r) => r.status === "ok" || r.status === "new").sort((a, b) => (a.last_ok_at ?? 0) - (b.last_ok_at ?? 0)).slice(0, limit);
    const out = [];
    for (const r of usable) {
      const key = await decryptSecret(this.env, r.enc_key, "ai-key");
      if (key)
        out.push({ id: r.id, provider: r.provider, baseUrl: r.base_url, model: r.model, key });
      else
        await this.remove(r.id, "decrypt failed");
    }
    return out;
  }
  async rows() {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM ai_keys ORDER BY (status='ok') DESC, last_ok_at DESC, id DESC LIMIT 200`
    ).all().catch(() => ({ results: [] }));
    return results ?? [];
  }
  async stats() {
    const r = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok FROM ai_keys`
    ).first().catch(() => null);
    return { total: r?.total ?? 0, ok: r?.ok ?? 0 };
  }
  async add(opts) {
    const enc = await encryptSecret(this.env, opts.key, "ai-key");
    const res = await this.env.DB.prepare(
      `INSERT INTO ai_keys (owner_id, label, provider, base_url, model, enc_key, status, ok_count, fail_count, created_at)
       VALUES (?,?,?,?,?,?, 'ok', 0, 0, ?)`
    ).bind(opts.ownerId, opts.label.slice(0, 40), opts.provider, opts.baseUrl, opts.model, enc, Date.now()).run();
    await this.invalidate();
    return Number(res?.meta?.last_row_id ?? 0);
  }
  async remove(id, reason = "removed") {
    await this.env.DB.prepare(`DELETE FROM ai_keys WHERE id=?`).bind(id).run().catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    console.log("keypool-remove", id, reason);
    await this.invalidate();
  }
  async markOk(id, model) {
    await this.env.DB.prepare(
      `UPDATE ai_keys SET status='ok', ok_count=ok_count+1, last_ok_at=?, last_err=NULL, model=CASE WHEN ?='' THEN model ELSE ? END WHERE id=?`
    ).bind(Date.now(), model, model, id).run().catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
  }
  async markFail(id, err) {
    if (/401|403|402|invalid api key|insufficient|quota|credit|expired|no auth/i.test(err)) {
      await this.remove(id, err.slice(0, 80));
      return "deleted";
    }
    await this.env.DB.prepare(
      `UPDATE ai_keys SET status='warn', fail_count=fail_count+1, last_err=? WHERE id=?`
    ).bind(err.slice(0, 160), id).run().catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
    return "kept";
  }
  async invalidate() {
    await this.env.CACHE.delete(_KeyPool.CACHE_KEY).catch(() => null);
  }
  /**
   * Live test used when a key is donated (and by the "test" button later).
   * Returns the model list when the endpoint exposes one.
   */
  static async test(baseUrl, key, model) {
    const url = baseUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    try {
      if (!model) {
        const res2 = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(15e3) });
        if (!res2.ok)
          return { ok: false, error: `${res2.status} ${(await res2.text()).slice(0, 120)}` };
        const j2 = await res2.json().catch(() => ({}));
        return { ok: true, models: (j2?.data ?? []).map((m) => m.id).slice(0, 400) };
      }
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
        signal: AbortSignal.timeout(2e4)
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        return { ok: false, error: `${res.status} ${body}` };
      }
      const j = await res.json().catch(() => ({}));
      const reply = j?.choices?.[0]?.message?.content ?? "";
      return { ok: true, reply: String(reply).slice(0, 40) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
    }
  }
};
var KeyPool = _KeyPool;
__publicField(KeyPool, "CACHE_KEY", "aipool:keys:v1");
export {
  KeyPool,
  PROVIDERS,
  providerPreset
};
