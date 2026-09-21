import type { Env } from "../env";

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
  | "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  | "@cf/meta/llama-3.1-8b-instruct"
  | "@cf/qwen/qwen2.5-coder-32b-instruct"
  | "@cf/mistral/mistral-7b-instruct-v0.2"
  | "@cf/meta/llama-3.2-3b-instruct";

const FALLBACK: Record<string, AiModel[]> = {
  fast: ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.2-3b-instruct"],
  smart: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.2-3b-instruct"],
  code: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"],
};
export type Tier = keyof typeof FALLBACK;

export interface ChatOpts {
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

export class AiBrain {
  private static memo = new Map<string, { until: number; text: string }>();

  constructor(private env: Env) {}

  /** Prompt → text, with cache + fallback chain. */
  async chat(prompt: string, opts: ChatOpts = {}): Promise<string> {
    const tier = opts.tier ?? "fast";
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
    for (const model of chain) {
      try {
        const res: any = await this.env.AI.run(model as any, {
          messages,
          max_tokens: opts.max_tokens ?? 1024,
          temperature: opts.temperature ?? 0.35,
        } as any);
        text = (res?.response ?? "").toString().trim();
        if (text) break;
      } catch (e) {
        // capacity/limits → try the next model
        continue;
      }
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

  /** Structured extraction: prompt → parsed JSON (with a lenient repair pass). */
  async json<T = any>(prompt: string, opts: ChatOpts = {}): Promise<T | null> {
    const raw = await this.chat(prompt, { ...opts, json: true });
    return safeJson<T>(raw);
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
      `Translate the following GitHub ${kind} into ${to === "fa" ? "fluent Persian (فارسی)" : to}.\n` +
        `Rules:\n• keep ALL code blocks, commands, file paths, URLs, badges and YAML untouched\n` +
        `• keep markdown structure (headings, lists, tables)\n• translate UI-ish nouns naturally, keep library names in Latin script\n` +
        `• do NOT add commentary, do NOT omit sections\n\n---\n${clipped}`,
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
  plan_search(query: string, locale = "fa") {
    return this.json<{ github_query: string; keywords: string[]; language: string | null; topics: string[]; sort: string; explain_fa: string }>(
      `A user (language: ${locale}) asks: "${query}"\n` +
        `Convert it into a GitHub repository search. Return JSON: github_query (valid GitHub search qualifiers, ` +
        `e.g. "language:typescript stars:>500 topic:state-management"), keywords (array, English), ` +
        `language (or null), topics (array), sort (stars|updated|forks|best-match), explain_fa (one Persian sentence ` +
        `explaining how you understood the request).`,
      { tier: "fast", max_tokens: 500, cacheKey: `plan:${hash(query)}`, cacheTtl: 86400 },
    );
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

  // ── speech ──────────────────────────────────────────────────────────────
  /** Diagnostics from the last speak() attempt (surfaced by /health?deep). */
  lastTtsDebug: string[] = [];
  /** Which voice/language the last clip actually used. */
  spokenLang = "fa";

  /**
   * TTS — Persian first (mms-tts-fas), then the multilingual melotts voice.
   * Workers AI models answer in different shapes depending on the model
   * (base64 string, byte array, stream or ArrayBuffer), so normalise first and
   * report a readable trace when nothing usable comes back.
   */
  async speak(text: string, locale = "fa"): Promise<ArrayBuffer | null> {
    const clean = text.replace(/[*_`#>|]/g, "").replace(/https?:\/\/\S+/g, "").slice(0, 900);
    const models = locale === "en"
      ? ["@cf/deepgram/aura-1", "@cf/myshell-ai/melotts"]
      : ["@cf/facebook/mms-tts-fas", "@cf/myshell-ai/melotts"];
    this.lastTtsDebug = [];
    this.spokenLang = locale;
    // Stage 2 for non-English locales: Workers AI ships only English voices on
    // this account, so speak a live translation instead of dropping the feature.
    if (locale !== "en") {
      try {
        const en = await this.translate(clean, "en", "text");
        if (en && en.length > 3) {
          const res: any = await this.env.AI.run("@cf/deepgram/aura-1" as any, { text: en.replace(/[*_`#>|]/g, "").slice(0, 1200) } as any);
          const buf = await audioBytes(res);
          this.lastTtsDebug.push(`@cf/deepgram/aura-1 (English read of the ${locale} text) → ${buf ? buf.byteLength + "B" : "no audio"}`);
          if (buf && buf.byteLength > 1000) {
            this.spokenLang = "en (live translation)";
            return buf;
          }
        }
      } catch (e: any) {
        this.lastTtsDebug.push("@cf/deepgram/aura-1 fallback → error: " + String(e?.message ?? e).slice(0, 80));
      }
    }
    for (const m of models) {
      try {
        const res: any = await this.env.AI.run(m as any, { prompt: clean, text: clean, lang: locale } as any);
        const buf = await audioBytes(res);
        this.lastTtsDebug.push(`${m} → ${buf ? buf.byteLength + "B" : "no audio (" + describe(res) + ")"}`);
        if (buf && buf.byteLength > 1000) {
          if (locale !== "en") {
            this.spokenLang = `en (translated from ${locale}, model ${m})`;
            this.lastTtsDebug.push("spoken through the English voice as a live translation");
          }
          return buf;
        }
      } catch (e: any) {
        this.lastTtsDebug.push(`${m} → error: ${String(e?.message ?? e).slice(0, 90)}`);
        continue;
      }
    }
    return null;
  }

  /** Voice → text (voice notes handled like commands in the bot). */
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
