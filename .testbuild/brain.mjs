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

// src/ai/brain.ts
var FALLBACK = {
  fast: ["@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  smart: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/openai/gpt-oss-120b", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  code: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/meta/llama-3.1-8b-instruct-fp8"]
};
var _AiBrain = class {
  constructor(env) {
    this.env = env;
  }
  /** Set by the last chat() call: null when it produced text. */
  failure = null;
  /** Prompt → text, with cache + fallback chain. */
  async chat(prompt, opts = {}) {
    const tier = opts.tier ?? "fast";
    const system = opts.system ?? "You are GitHub Lens Ultra, an expert open-source intelligence analyst. Answer precisely and concisely.";
    const cacheKey = opts.cacheKey ? `ai:${tier}:${opts.cacheKey}` : null;
    if (cacheKey) {
      const memo = _AiBrain.memo.get(cacheKey);
      if (memo && memo.until > Date.now())
        return memo.text;
      const kv = await this.env.CACHE.get(cacheKey).catch(() => null);
      if (kv) {
        _AiBrain.memo.set(cacheKey, { until: Date.now() + 6e4, text: kv });
        return kv;
      }
    }
    const messages = [
      { role: "system", content: system + (opts.json ? "\nReturn ONLY valid, minified JSON. No markdown fences, no commentary." : "") },
      { role: "user", content: prompt }
    ];
    let text = "";
    const chain = FALLBACK[tier] ?? FALLBACK.fast;
    const compatReady = !!(this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY);
    const poolReady = compatReady ? true : !!await this.env.CACHE.get("aipool:has").catch(() => null);
    if (!compatReady && !poolReady && await this.env.CACHE.get("ai:halt").catch(() => null)) {
      this.failure = "quota";
      return "";
    }
    if (!text) {
      text = await this.tryPool(messages, opts);
      if (text) {
        this.failure = null;
        if (cacheKey)
          await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
        if (opts.userId)
          await this.meter(opts.userId, opts.feature ?? "chat", text.length);
        return text;
      }
    }
    if (this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY) {
      text = await this.openaiCompat(messages, opts).catch((e) => {
        console.error("ai-compat-failed", String(e?.message ?? e));
        return "";
      });
      if (text) {
        this.failure = null;
        if (cacheKey)
          await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
        return text;
      }
    }
    const failures = [];
    for (const model of chain) {
      try {
        const res = await this.env.AI.run(model, {
          messages,
          max_tokens: opts.max_tokens ?? 1024,
          temperature: opts.temperature ?? 0.35
        });
        text = (res?.response ?? "").toString().trim();
        if (text)
          break;
        failures.push(`${model}: empty response`);
      } catch (e) {
        failures.push(`${model}: ${String(e?.message ?? e).slice(0, 120)}`);
        continue;
      }
    }
    if (!text) {
      console.error("ai-chain-exhausted", failures.join(" | "));
      this.failure = failures.some((f) => /4006|neuron/i.test(f)) ? "quota" : failures.every((f) => /deprecat|no such model|not allowed|not available/i.test(f)) ? "missing" : "unconfigured";
      await this.env.CACHE.put("ai:last-failure", JSON.stringify({ at: Date.now(), reason: this.failure }), { expirationTtl: 3600 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
      if (this.failure === "quota") {
        const left = secondsUntilUtcMidnight();
        await this.env.CACHE.put("ai:halt", String(Date.now()), { expirationTtl: left }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    } else {
      this.failure = null;
    }
    if (!text && this.env.OPENAI_COMPAT_BASE_URL && this.env.OPENAI_COMPAT_KEY) {
      text = await this.openaiCompat(messages, opts).catch(() => "");
    }
    if (text && cacheKey) {
      _AiBrain.memo.set(cacheKey, { until: Date.now() + 12e4, text });
      await this.env.CACHE.put(cacheKey, text, { expirationTtl: opts.cacheTtl ?? 604800 }).catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    if (opts.userId && text)
      await this.meter(opts.userId, opts.feature ?? "chat", text.length);
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
  async parallel(prompts, opts = {}) {
    if (prompts.length === 0)
      return [];
    if (prompts.length === 1)
      return [await this.chat(prompts[0], opts)];
    const pool = new KeyPool(this.env);
    let keys = [];
    try {
      keys = await pool.candidates(prompts.length);
    } catch {
      keys = [];
    }
    if (keys.length === 0) {
      const out2 = [];
      for (const p of prompts)
        out2.push(await this.chat(p, opts));
      return out2;
    }
    const usedIds = /* @__PURE__ */ new Set();
    const runOne = async (prompt, k) => {
      if (!k)
        return this.chat(prompt, opts);
      try {
        const res = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: k.model || "auto", messages: [{ role: "user", content: prompt }], max_tokens: opts.max_tokens ?? 2048, temperature: opts.temperature ?? 0.2 }),
          signal: AbortSignal.timeout(6e4)
        });
        if (!res.ok) {
          await pool.markFail(k.id, `${res.status} ${(await res.text()).slice(0, 160)}`);
          return "";
        }
        const j = await res.json().catch(() => ({}));
        const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (text) {
          await pool.markOk(k.id, k.model);
          usedIds.add(k.id);
        }
        return text;
      } catch (e) {
        await pool.markFail(k.id, String(e?.message ?? e).slice(0, 120)).catch(() => null);
        return "";
      }
    };
    const primary = prompts.map((_, i) => keys[i % keys.length]);
    const first = await Promise.all(prompts.map((p, i) => runOne(p, primary[i])));
    const spare = keys.find((k) => !usedIds.has(k.id)) ?? keys[0];
    const out = [...first];
    for (let i = 0; i < out.length; i++) {
      if (!out[i])
        out[i] = await runOne(prompts[i], spare);
    }
    return out;
  }
  /** Translate several chunks — one part per pooled key when the pool is big. */
  async translateMany(texts, to = "fa", kind = "readme") {
    const prompts = texts.map((t) => this.translatePrompt(t, to, kind));
    const parts = await this.parallel(prompts, { tier: "smart", max_tokens: 4e3, temperature: 0.2, feature: "translate" });
    return parts.map((p) => p ?? "").filter(Boolean);
  }
  /** The prompt used by translate(); split out so parallel() can reuse it. */
  translatePrompt(text, to = "fa", kind = "readme") {
    const clipped = text.slice(0, 22e3);
    return `Translate the following GitHub ${kind} into ${to === "fa" ? "fluent Persian (\u0641\u0627\u0631\u0633\u06CC)" : to}.
Rules:
\u2022 keep ALL code blocks, commands, file paths, URLs, badges and YAML untouched
\u2022 keep markdown structure (headings, lists, tables)
\u2022 translate UI-ish nouns naturally, keep library names in Latin script
\u2022 do NOT add commentary, do NOT omit sections

---
${clipped}`;
  }
  /** Structured extraction: prompt → parsed JSON (with a lenient repair pass). */
  async json(prompt, opts = {}) {
    const raw = await this.chat(prompt, { ...opts, json: true });
    return safeJson(raw);
  }
  /**
   * Try the donated-key pool. Each key is used with its own base URL and model;
   * failures are accounted per key, and a dead key is deleted on the spot.
   */
  async tryPool(messages, opts) {
    let keys = [];
    try {
      keys = await new KeyPool(this.env).candidates(6);
    } catch (e) {
      console.error("keypool-load-failed", String(e?.message ?? e));
      return "";
    }
    if (!keys.length) {
      await this.env.CACHE.delete("aipool:has").catch(() => null);
      return "";
    }
    await this.env.CACHE.put("aipool:has", "1", { expirationTtl: 300 }).catch(() => null);
    const pool = new KeyPool(this.env);
    for (const k of keys) {
      try {
        const res = await fetch(`${k.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: k.model || "auto", messages, max_tokens: opts.max_tokens ?? 1024, temperature: opts.temperature ?? 0.3 }),
          signal: AbortSignal.timeout(45e3)
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          const verdict = await pool.markFail(k.id, `${res.status} ${body}`);
          console.error("pool-key-failed", k.id, res.status, verdict);
          if (verdict === "deleted")
            await this.notifyDonor(k.id, res.status, body).catch(() => null);
          continue;
        }
        const j = await res.json().catch(() => ({}));
        const out = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (out) {
          await pool.markOk(k.id, k.model);
          return out;
        }
        await pool.markFail(k.id, "empty response");
      } catch (e) {
        await pool.markFail(k.id, String(e?.message ?? e).slice(0, 120)).catch(() => null);
      }
    }
    return "";
  }
  /** Warn the donor that their key left the pool, and why. */
  async notifyDonor(keyId, status, body) {
    const row = await this.env.DB.prepare(`SELECT owner_id, label, provider FROM ai_keys WHERE id=?`).bind(keyId).first().catch(() => null);
    const owner = row?.owner_id;
    if (!owner)
      return;
    let locale = "fa";
    try {
      const u = await this.env.DB.prepare(`SELECT locale FROM users WHERE id=?`).bind(owner).first();
      locale = u?.locale ?? "fa";
    } catch {
    }
    const fa = locale === "fa";
    const text = fa ? `\u{1F514} <b>\u06A9\u0644\u06CC\u062F\u062A \u0627\u0632 \u0627\u0633\u062A\u062E\u0631 \u062E\u0627\u0631\u062C \u0634\u062F</b>

\u06A9\u0644\u06CC\u062F \xAB${row?.label ?? row?.provider ?? "\u2014"}\xBB \u062C\u0648\u0627\u0628 \u0646\u062F\u0627\u062F (${status}) \u0648 \u0686\u0648\u0646 \u0633\u0648\u062E\u062A\u0647/\u0628\u0627\u0637\u0644 \u0628\u0648\u062F \u0647\u0645\u0627\u0646 \u0644\u062D\u0638\u0647 \u062D\u0630\u0641 \u0634\u062F.
<code>${String(body).slice(0, 160)}</code>

\u0627\u06AF\u0631 \u06A9\u0644\u06CC\u062F \u062A\u0627\u0632\u0647\u200C\u0627\u06CC \u062F\u0627\u0631\u06CC\u060C \u0628\u0627 /keys \u0627\u0647\u062F\u0627 \u06A9\u0646 \u2014 \u0628\u0627 \u0647\u0631 \u06A9\u0644\u06CC\u062F\u060C \u0645\u0648\u062A\u0648\u0631 AI \u0631\u0628\u0627\u062A \u0628\u0631\u0627\u06CC \u0647\u0645\u0647 \u0631\u0648\u0634\u0646\u200C\u062A\u0631 \u0645\u06CC\u200C\u0634\u0648\u062F.` : `\u{1F514} Your donated key was removed from the pool (HTTP ${status}).`;
    await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: owner, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
  }
  async openaiCompat(messages, opts) {
    const res = await fetch(`${this.env.OPENAI_COMPAT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.OPENAI_COMPAT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages, max_tokens: opts.max_tokens ?? 1024, temperature: opts.temperature ?? 0.3 })
    });
    const j = await res.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? "";
  }
  async meter(userId, feature, chars) {
    const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    await this.env.DB.prepare(
      `INSERT INTO ai_usage (day, user_id, feature, tokens, calls) VALUES (?,?,?,?,1)
       ON CONFLICT(day, user_id, feature) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`
    ).bind(day, userId, feature, Math.ceil(chars / 4)).run().catch((e) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  // ── specialised calls ───────────────────────────────────────────────────
  /** Multilingual → Persian technical translation, format-preserving. */
  translate(text, to = "fa", kind = "readme") {
    const clipped = text.slice(0, 22e3);
    return this.chat(
      this.translatePrompt(clipped, to, kind),
      {
        tier: "smart",
        max_tokens: 4e3,
        temperature: 0.2,
        cacheKey: `tr:${to}:${kind}:${hash(clipped)}`,
        cacheTtl: 2592e3,
        feature: "translate"
      }
    );
  }
  /** Repo dossier → structured Persian intelligence brief. */
  analyzeRepo(meta) {
    return this.json(
      `Analyse this GitHub repository and answer in Persian (\u0641\u0627\u0631\u0633\u06CC).
Data: ${JSON.stringify({
        full_name: meta.full_name,
        description: meta.description,
        stars: meta.stars,
        forks: meta.forks,
        issues: meta.issues,
        open_prs: meta.prs,
        language: meta.language,
        languages: (meta.languages ?? []).slice(0, 6).map((l) => l.name),
        topics: (meta.topics ?? []).slice(0, 12),
        license: meta.license,
        archived: meta.archived,
        pushed_at: meta.pushed_at,
        created_at: meta.created_at,
        contributors: meta.contributors,
        community_health: meta.community_health,
        red_flags: meta.redFlags,
        recent_commits: (meta.raw?.commitHistory?.target?.history?.nodes ?? []).slice(0, 10).map((c) => c.messageHeadline)
      })}
Return JSON with keys: one_liner (max 90 chars), what (3 sentences), who_for, pros (3-5 bullets), cons (2-4 bullets, be honest about weaknesses), alternatives (up to 3 real competing projects), learning_curve (\u06A9\u0645/\u0645\u062A\u0648\u0633\u0637/\u0632\u06CC\u0627\u062F + \u06CC\u06A9 \u062C\u0645\u0644\u0647), production_ready (\u0628\u0644\u0647/\u062E\u06CC\u0631/\u0628\u0627 \u0627\u062D\u062A\u06CC\u0627\u0637 + \u062F\u0644\u06CC\u0644), security_note, tags_fa (5 Persian tags).`,
      { tier: "smart", max_tokens: 1600, cacheKey: `ana:${meta.full_name}:${meta.stars}`, cacheTtl: 604800 }
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
  async plan_search(query, locale = "fa") {
    const plan = await this.json(
      `A user (language: ${locale}) asks: "${query}"
Convert it into a GitHub repository search. Return JSON: github_query (valid GitHub search qualifiers, e.g. "language:typescript stars:>500 topic:state-management"), keywords (array, English), language (or null), topics (array), sort (stars|updated|forks|best-match), explain_fa (one Persian sentence explaining how you understood the request).`,
      { tier: "fast", max_tokens: 500, cacheKey: `plan:${hash(query)}`, cacheTtl: 86400 }
    );
    const cacheKey = `ai:fast:plan:${hash(query)}`;
    if (!plan)
      return null;
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
  changelog(commits, locale = "fa") {
    return this.chat(
      `Write concise release notes in ${locale === "fa" ? "Persian" : "English"} from these commits.
Group by: \u{1F680} Features, \u{1F41B} Fixes, \u26A1 Performance, \u{1F4DD} Docs, \u{1F527} Chore. Skip noise (typos, merges).
Commits:
${commits.map((c) => `- ${c.message}`).join("\n").slice(0, 6e3)}`,
      { tier: "fast", max_tokens: 800, cacheKey: `chg:${hash(commits.map((c) => c.message).join("|"))}`, cacheTtl: 604800 }
    );
  }
  /** GitHub Actions / workflow generator. */
  workflow(description) {
    return this.chat(
      `Write a production-grade GitHub Actions workflow YAML for: "${description}".
Include caching, matrix where useful, least-privilege permissions and comments. Return YAML only.`,
      { tier: "code", max_tokens: 1400, temperature: 0.2 }
    );
  }
  /** Code explainer for a file the user pasted or a repo path. */
  explainCode(code, locale = "fa") {
    return this.chat(
      `Explain this code in ${locale === "fa" ? "Persian" : "English"} for a mid-level developer.
Cover: purpose, flow, tricky parts, complexity, and 2 improvement suggestions.

\`\`\`
${code.slice(0, 9e3)}
\`\`\``,
      { tier: "code", max_tokens: 1400, temperature: 0.3, cacheKey: `exp:${hash(code)}`, cacheTtl: 604800 }
    );
  }
  /** PR review assistant. */
  reviewPR(diff, locale = "fa") {
    return this.chat(
      `Review this pull-request diff like a senior engineer. In ${locale === "fa" ? "Persian" : "English"}.
Sections: \u{1F50D} \u062E\u0644\u0627\u0635\u0647 \u062A\u063A\u06CC\u06CC\u0631\u0627\u062A\u060C \u26A0\uFE0F \u0631\u06CC\u0633\u06A9\u0647\u0627/\u0628\u0627\u06AF\u0647\u0627\u06CC \u0627\u062D\u062A\u0645\u0627\u0644\u06CC\u060C \u{1F9EA} \u062A\u0633\u062A\u0647\u0627\u06CC \u0644\u0627\u0632\u0645\u060C \u2705 \u067E\u06CC\u0634\u0646\u0647\u0627\u062F\u0647\u0627\u06CC \u06A9\u062F.

${diff.slice(0, 12e3)}`,
      { tier: "code", max_tokens: 1600, temperature: 0.3 }
    );
  }
  // ── embeddings ──────────────────────────────────────────────────────────
  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20).map((t) => t.slice(0, 6e3));
      const res = await this.env.AI.run("@cf/baai/bge-m3", { text: batch });
      const vecs = res?.data ?? [];
      out.push(...vecs);
    }
    return out;
  }
  async embedOne(text) {
    const v = await this.embed([text]);
    return v[0] ?? new Array(1024).fill(0);
  }
  // ── speech ──────────────────────────────────────────────────────────────
  /** Diagnostics from the last speak() attempt (surfaced by /health?deep). */
  lastTtsDebug = [];
  /** Which voice/language the last clip actually used. */
  spokenLang = "fa";
  /**
   * TTS — Persian first (mms-tts-fas), then the multilingual melotts voice.
   * Workers AI models answer in different shapes depending on the model
   * (base64 string, byte array, stream or ArrayBuffer), so normalise first and
   * report a readable trace when nothing usable comes back.
   */
  async speak(text, locale = "fa") {
    const clean = text.replace(/[*_`#>|]/g, "").replace(/https?:\/\/\S+/g, "").slice(0, 900);
    const models = locale === "en" ? ["@cf/deepgram/aura-1", "@cf/myshell-ai/melotts"] : ["@cf/facebook/mms-tts-fas", "@cf/myshell-ai/melotts"];
    this.lastTtsDebug = [];
    this.spokenLang = locale;
    if (locale !== "en") {
      try {
        const en = await this.translate(clean, "en", "text");
        if (en && en.length > 3) {
          const res = await this.env.AI.run("@cf/deepgram/aura-1", { text: en.replace(/[*_`#>|]/g, "").slice(0, 1200) });
          const buf = await audioBytes(res);
          this.lastTtsDebug.push(`@cf/deepgram/aura-1 (English read of the ${locale} text) \u2192 ${buf ? buf.byteLength + "B" : "no audio"}`);
          if (buf && buf.byteLength > 1e3) {
            this.spokenLang = "en (live translation)";
            return buf;
          }
        }
      } catch (e) {
        this.lastTtsDebug.push("@cf/deepgram/aura-1 fallback \u2192 error: " + String(e?.message ?? e).slice(0, 80));
      }
    }
    for (const m of models) {
      try {
        const res = await this.env.AI.run(m, { prompt: clean, text: clean, lang: locale });
        const buf = await audioBytes(res);
        this.lastTtsDebug.push(`${m} \u2192 ${buf ? buf.byteLength + "B" : "no audio (" + describe(res) + ")"}`);
        if (buf && buf.byteLength > 1e3) {
          if (locale !== "en") {
            this.spokenLang = `en (translated from ${locale}, model ${m})`;
            this.lastTtsDebug.push("spoken through the English voice as a live translation");
          }
          return buf;
        }
      } catch (e) {
        this.lastTtsDebug.push(`${m} \u2192 error: ${String(e?.message ?? e).slice(0, 90)}`);
        continue;
      }
    }
    return null;
  }
  /** Voice → text (voice notes handled like commands in the bot). */
  async transcribe(audio, locale = "fa") {
    try {
      const res = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        audio: [...new Uint8Array(audio)],
        language: locale
      });
      return (res?.text ?? "").trim();
    } catch {
      return "";
    }
  }
};
var AiBrain = _AiBrain;
__publicField(AiBrain, "memo", /* @__PURE__ */ new Map());
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
function safeJson(raw) {
  if (!raw)
    return null;
  let s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0));
  if (Number.isFinite(start) && start > 0)
    s = s.slice(start);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (end > 0)
    s = s.slice(0, end + 1);
  for (const attempt of [s, s.replace(/,\s*([}\]])/g, "$1"), s.replace(/'/g, '"'), s.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"')]) {
    try {
      return JSON.parse(attempt);
    } catch {
    }
  }
  return null;
}
async function audioBytes(res) {
  if (!res)
    return null;
  const pick = res.audio ?? res.audio_base64 ?? res;
  if (pick instanceof ReadableStream)
    return await new Response(pick).arrayBuffer();
  if (pick instanceof ArrayBuffer)
    return pick;
  if (ArrayBuffer.isView(pick))
    return pick.buffer.slice(pick.byteOffset, pick.byteOffset + pick.byteLength);
  if (Array.isArray(pick))
    return new Uint8Array(pick).buffer;
  if (typeof pick === "string") {
    if (pick.length < 200)
      return null;
    const b64 = pick.includes(",") ? pick.split(",").pop() : pick;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
      return out.buffer;
    } catch {
      return null;
    }
  }
  return null;
}
function describe(res) {
  if (res == null)
    return "null";
  if (typeof res === "string")
    return `string(${res.length})`;
  if (res instanceof ReadableStream)
    return "stream";
  if (res instanceof ArrayBuffer)
    return `ArrayBuffer(${res.byteLength})`;
  if (res instanceof Uint8Array)
    return `Uint8Array(${res.byteLength})`;
  if (typeof res === "object")
    return "keys:" + Object.keys(res).slice(0, 6).join("|");
  return typeof res;
}
async function aiDownNotice(env, loc) {
  let reason = null;
  try {
    const raw = await env.CACHE.get("ai:last-failure");
    reason = raw ? JSON.parse(raw).reason : null;
  } catch {
    reason = null;
  }
  const fa = loc === "fa";
  if (reason === "quota") {
    return fa ? "\u26A0\uFE0F \u0633\u0647\u0645\u06CC\u0647\u0654 \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0647\u0648\u0634 \u0645\u0635\u0646\u0648\u0639\u06CC \u0627\u06CC\u0646 \u062D\u0633\u0627\u0628 \u0628\u0631\u0627\u06CC \u0627\u0645\u0631\u0648\u0632 \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 (\u06F1\u06F0\u066C\u06F0\u06F0\u06F0 \u0646\u0648\u0631\u0648\u0646).\n\u2022 \u0686\u0646\u062F \u0633\u0627\u0639\u062A \u062F\u06CC\u06AF\u0631 \u06CC\u0627 \u0641\u0631\u062F\u0627 \u062E\u0648\u062F\u0634 \u0628\u0631\u0645\u06CC\u200C\u06AF\u0631\u062F\u062F\n\u2022 \u06CC\u0627 \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u06CC\u06A9 \u06A9\u0644\u06CC\u062F \u0633\u0627\u0632\u06AF\u0627\u0631 \u0628\u0627 OpenAI (Groq / OpenRouter / Gemini) \u0628\u0633\u0627\u0632\u062F \u0648 \u0628\u0627 <code>OPENAI_COMPAT_KEY</code> \u0648\u0635\u0644 \u06A9\u0646\u062F\u061B \u0622\u0646 \u0633\u0647\u0645\u06CC\u0647 \u062C\u062F\u0627\u0633\u062A.\n\u0628\u0642\u06CC\u0647\u0654 \u0631\u0628\u0627\u062A \u0628\u062F\u0648\u0646 AI \u06A9\u0627\u0631 \u0645\u06CC\u200C\u06A9\u0646\u062F." : "\u26A0\uFE0F The account's free Workers AI neurons are spent for today. It resets automatically, or add an OpenAI-compatible key (Groq / OpenRouter / Gemini) as OPENAI_COMPAT_KEY. Everything else keeps working.";
  }
  if (reason === "missing") {
    return fa ? "\u26A0\uFE0F \u0645\u062F\u0644\u200C\u0647\u0627\u06CC \u0647\u0648\u0634 \u0645\u0635\u0646\u0648\u0639\u06CC \u0627\u06CC\u0646 \u062D\u0633\u0627\u0628 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A\u0646\u062F (\u0634\u0646\u0627\u0633\u0647\u0654 \u0645\u062F\u0644 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647)." : "\u26A0\uFE0F No available model on this account (stale model ids).";
  }
  return fa ? "\u26A0\uFE0F \u0647\u0648\u0634 \u0645\u0635\u0646\u0648\u0639\u06CC \u0627\u0644\u0627\u0646 \u067E\u0627\u0633\u062E \u0646\u062F\u0627\u062F\u061B \u0686\u0646\u062F \u0644\u062D\u0638\u0647 \u0628\u0639\u062F \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646." : "\u26A0\uFE0F The AI backend did not answer; try again in a moment.";
}
function secondsUntilUtcMidnight() {
  const now = /* @__PURE__ */ new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(900, Math.min(86400, Math.floor((next - now.getTime()) / 1e3)));
}
async function aiHalted(env) {
  return !!await env.CACHE.get("ai:halt").catch(() => null);
}
export {
  AiBrain,
  aiDownNotice,
  aiHalted,
  audioBytes,
  describe,
  hash,
  safeJson
};
