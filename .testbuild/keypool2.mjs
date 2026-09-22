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
      await this.env.CACHE.put(_KeyPool.CACHE_KEY, JSON.stringify(rows), { expirationTtl: 120 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    const usable = rows.filter((r) => r.status === "ok" || r.status === "new" || // a rate-limited provider is not a dead key: try it again after the cooldown
    r.status === "warn" && Date.now() - Number(r.last_fail_at ?? 0) > _KeyPool.COOLDOWN_MS).sort((a, b) => (a.last_ok_at ?? 0) - (b.last_ok_at ?? 0)).slice(0, limit);
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
      `UPDATE ai_keys SET status='warn', fail_count=fail_count+1, last_fail_at=?, last_err=? WHERE id=?`
    ).bind(Date.now(), err.slice(0, 160), id).run().catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.invalidate();
    return "kept";
  }
  async invalidate() {
    await this.env.CACHE.delete(_KeyPool.CACHE_KEY).catch(() => null);
  }
  /**
   * Normalise whatever the user pasted into a base URL.
   *
   * People paste the endpoint they copied from a docs page — the owner pasted
   * `https://kktoken.cc/v1/chat/completions`, which we then asked for
   * `/chat/completions/models` and got a 404 that looked like a bad key.
   * Everything from the endpoint onwards is stripped.
   */
  static normalizeBase(raw) {
    let u = String(raw ?? "").trim().replace(/\s+/g, "");
    u = u.replace(/\/(chat\/completions|completions|chat|models|embeddings)\/?$/i, "");
    u = u.replace(/\/+$/, "");
    return u;
  }
  /**
   * Ask the provider which models it has, best-first for chat.
   * Free/cheap chat models first, embedding and image models last.
   */
  static async listModels(baseUrl, key) {
    const url = _KeyPool.normalizeBase(baseUrl);
    try {
      const res = await fetch(`${url}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15e3)
      });
      if (!res.ok)
        return { ok: false, models: [], error: `${res.status} ${(await res.text()).slice(0, 160)}` };
      const j = await res.json().catch(() => ({}));
      const ids = (j?.data ?? j?.models ?? []).map((m) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
      const rank = (id) => {
        let s = 0;
        if (_KeyPool.NOT_CHAT.test(id))
          s += 100;
        if (/free/i.test(id))
          s -= 3;
        if (/70b|72b|large|pro|sonnet|gpt-4|gpt-5|o[13]|command-r|mixtral/i.test(id))
          s -= 2;
        if (/8b|7b|mini|flash|lite|small|instant|haiku/i.test(id))
          s -= 1;
        return s;
      };
      return { ok: true, models: [...new Set(ids)].sort((a, b) => rank(a) - rank(b)) };
    } catch (e) {
      return { ok: false, models: [], error: String(e?.message ?? e).slice(0, 160) };
    }
  }
  /** One chat ping. */
  static async ping(url, key, model) {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(2e4)
    });
    const body = (await res.text()).slice(0, 200);
    if (!res.ok)
      return { ok: false, status: res.status, error: body };
    let reply = "";
    try {
      reply = String(JSON.parse(body)?.choices?.[0]?.message?.content ?? "");
    } catch {
    }
    return { ok: true, status: res.status, reply };
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
  static async test(baseUrl, key, model) {
    const url = _KeyPool.normalizeBase(baseUrl);
    const kindOf = (status, body) => {
      if (status === 401 || status === 403 || /invalid api key|unauthorized|no auth|invalid_api_key/i.test(body))
        return "auth";
      if (status === 402 || status === 429 || /quota|credit|rate limit|insufficient/i.test(body))
        return "quota";
      if (status === 404 && /model/i.test(body))
        return "model";
      if (status === 404 || /invalid url|not found/i.test(body))
        return "url";
      if (/model.*(not|does not).*(exist|found)|unknown model|no such model|model_not_found/i.test(body))
        return "model";
      return "net";
    };
    if (model) {
      try {
        const r = await _KeyPool.ping(url, key, model);
        if (r.ok)
          return { ok: true, reply: r.reply.slice(0, 40), model, models: [model] };
        const kind = kindOf(r.status, r.error);
        if (kind === "auth" || kind === "quota")
          return { ok: false, error: `${r.status} ${r.error}`, errorKind: kind };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 160), errorKind: "net" };
      }
    }
    const list = await _KeyPool.listModels(url, key);
    if (!list.ok && /401|403|invalid api key|unauthorized/i.test(list.error ?? ""))
      return { ok: false, error: list.error, errorKind: "auth" };
    const candidates = (list.models ?? []).filter((m) => !_KeyPool.NOT_CHAT.test(m)).slice(0, 6);
    for (const candidate of candidates) {
      try {
        const r = await _KeyPool.ping(url, key, candidate);
        if (r.ok)
          return { ok: true, reply: r.reply.slice(0, 40), model: candidate, models: list.models };
      } catch {
      }
    }
    if (!list.ok) {
      return {
        ok: false,
        error: list.error ?? "no /models endpoint",
        errorKind: /401|403|invalid api key|unauthorized/i.test(list.error ?? "") ? "auth" : "url"
      };
    }
    return {
      ok: false,
      error: model ? `model "${model}" and ${candidates.length} alternative(s) were refused by this endpoint` : "the endpoint lists no usable chat model",
      errorKind: "model",
      models: list.models
    };
  }
};
var KeyPool = _KeyPool;
__publicField(KeyPool, "CACHE_KEY", "aipool:keys:v1");
/** How long a merely-failed key (429, timeout, provider hiccup) stays out. */
__publicField(KeyPool, "COOLDOWN_MS", 10 * 6e4);
/** Model names that are almost always wrong for a chat call. */
__publicField(KeyPool, "NOT_CHAT", /(embed|embedding|whisper|tts|audio|image|dall|moderation|rerank|clip|stable|flux|guard|vision-encoder)/i);
export {
  KeyPool,
  PROVIDERS,
  providerPreset
};
