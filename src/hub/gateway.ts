import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { KeyPool } from "../ai/keypool";
import { MODEL_CAPS, mesh, meshConfidence, type TaskKind } from "./mesh";
import { hubId } from "./event";

/**
 *  AI GATEWAY
 *
 *      Your app → GHLens /v1/chat/completions → AI router → provider
 *
 *  An OpenAI-compatible front door to the whole model fabric. The reason this
 *  is worth building rather than proxying: the hub already knows things an
 *  ordinary proxy does not —
 *
 *    • **which key is healthy** (the donated-key pool rotates and cools)
 *    • **which model suits the task** (the capability graph in `mesh.ts`)
 *    • **whether the answer is trustworthy** (agreement between models)
 *    • **what it cost** and who spent it
 *
 *  So the gateway is not a pipe; it is a router with a memory and a budget.
 *
 *  Compatibility promises, kept exactly:
 *    • the response shape is `chat.completion` — clients parse it unchanged
 *    • `stream: true` returns real SSE chunks and a `[DONE]` sentinel
 *    • errors use the OpenAI `{error:{code,message}}` envelope, because client
 *      libraries branch on it
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** hub extensions — ignored by plain OpenAI clients */
  gh?: {
    /** run a multi-model jury and report agreement */
    mesh?: boolean;
    breadth?: number;
    task?: TaskKind;
    /** deterministic caching for idempotent work */
    cacheKey?: string;
    owner_id?: number;
  };
}

/** Short aliases → the tier the mesh routes through. */
const MODEL_ALIASES: Record<string, "fast" | "smart" | "code" | "mesh" | "auto"> = {
  "ghlens-auto": "auto",
  "ghlens-fast": "fast",
  "ghlens-smart": "smart",
  "ghlens-code": "code",
  "ghlens-mesh": "mesh",
  // Let a client that hardcodes an OpenAI name keep working.
  "gpt-4o-mini": "fast",
  "gpt-4o": "smart",
  "gpt-4": "smart",
  "gpt-3.5-turbo": "fast",
};

export const MODELS = [
  { id: "ghlens-auto", object: "model", owned_by: "ghlens", description: "Routes by task; the default" },
  { id: "ghlens-fast", object: "model", owned_by: "ghlens", description: "Cheapest tier — extraction, translation" },
  { id: "ghlens-smart", object: "model", owned_by: "ghlens", description: "Editorial writing, analysis" },
  { id: "ghlens-code", object: "model", owned_by: "ghlens", description: "Code generation and repair" },
  { id: "ghlens-mesh", object: "model", owned_by: "ghlens", description: "Multi-model jury + synthesis" },
];

/** The task a request implies, when the client did not say. */
export function inferTask(body: ChatRequest): TaskKind {
  if (body.gh?.task) return body.gh.task;
  const model = body.model ?? "";
  if (model === "ghlens-code") return "code";
  const text = (body.messages ?? []).map((m) => m.content).join(" ").slice(0, 1200).toLowerCase();
  if (/\b(function|class|bug|refactor|typescript|python|sql|regex|stack ?trace|کد|تابع|خطا)\b/.test(text)) return "code";
  if (/\b(translate|translation|ترجمه)\b/.test(text)) return "translate";
  if (/\bjson|extract|parse|استخراج\b/.test(text)) return "extract";
  if (/\b(compare|which is better|نقد|مقایسه)\b/.test(text)) return "compare";
  return "compose";
}

/**
 * Authorise the caller.
 *
 * Two accepted credentials: the bot's own webhook secret (used by the platform
 * itself and by the owner), or a donated pool key. Nothing else — an open AI
 * gateway on a public URL is a free compute faucet for whoever finds it.
 */
export async function authorise(env: Env, request: Request): Promise<{ ok: boolean; who: string; owner_id?: number }> {
  const auth = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!auth) return { ok: false, who: "anonymous" };
  if (env.TELEGRAM_WEBHOOK_SECRET && auth === env.TELEGRAM_WEBHOOK_SECRET) return { ok: true, who: "platform" };

  // A donated key is a legitimate credential: the donor is paying for the
  // compute, so they may spend it through the gateway.
  const pool = new KeyPool(env);
  const keys = await pool.candidates().catch(() => []);
  for (const k of keys) {
    // `LiveKey` carries the decrypted value as `key`; the id is the row id,
    // which is what a usage row can be attributed to without storing anything
    // about the secret itself.
    if (k?.key && k.key === auth) return { ok: true, who: `donor:${k.id}`, owner_id: undefined };
  }

  // The owner's own GitHub token is NOT accepted here — different trust domain.
  return { ok: false, who: "bad-key" };
}

export interface GatewayResult {
  body: any;
  status: number;
  headers: Record<string, string>;
}

/**
 * Run a chat completion.
 *
 * Routing order: explicit model alias → inferred task → the mesh when a jury
 * was asked for. `usage` is filled from the real text lengths rather than
 * invented numbers, because a client that logs cost from a fabricated field is
 * worse off than one with no field at all.
 */
export async function chatCompletion(env: Env, ai: AiBrain, body: ChatRequest, who: string): Promise<GatewayResult> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return errorEnvelope(400, "messages is required", "invalid_request_error");

  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n").trim();
  const prompt = messages.filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`).join("\n\n").slice(0, 12_000);
  const model = String(body.model ?? "ghlens-auto");
  const alias = MODEL_ALIASES[model] ?? "auto";
  const task = inferTask(body);
  const useMesh = alias === "mesh" || !!body.gh?.mesh;

  const started = Date.now();
  let text = "";
  let chosen = "none";
  let agreement = 1;
  let models: string[] = [];

  if (useMesh) {
    const r = await mesh(ai, prompt, {
      kind: task,
      breadth: Number(body.gh?.breadth ?? 3),
      system: system || undefined,
      max_tokens: Number(body.max_tokens ?? 900),
      temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
      adjudicate: true,
      feature: "gateway:mesh",
      cacheKey: body.gh?.cacheKey,
    });
    text = r.text; chosen = r.chosen; agreement = r.agreement;
    models = r.attempts.filter((a) => a.ok).map((a) => a.tier);
    if (!text) return errorEnvelope(503, "no model in the mesh produced an answer", "upstream_error");
  } else {
    const tier = alias === "auto" ? autoTier(task) : alias;
    text = await ai.chat(prompt, {
      tier,
      system: system || undefined,
      max_tokens: Number(body.max_tokens ?? 900),
      temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
      feature: "gateway",
      cacheKey: body.gh?.cacheKey,
    });
    chosen = tier;
    models = [tier];
    if (!text) {
      // The brain records *why* it produced nothing; surfacing that is the
      // difference between a usable error and a shrug.
      const reason = ai.failure ?? "unknown";
      return errorEnvelope(
        reason === "quota" ? 429 : 503,
        `no answer available (${reason})`,
        reason === "quota" ? "rate_limit_error" : "upstream_error",
      );
    }
  }

  const promptTokens = Math.ceil((system.length + prompt.length) / 4);
  const completionTokens = Math.ceil(text.length / 4);
  const id = hubId("chatcmpl");

  // One log line per call. Not analytics theatre — this is how "which model
  // actually gets used, and what does it cost" becomes answerable later.
  await env.DB.prepare(
    `INSERT INTO hub_gateway_log (id, who, model, chosen, task, prompt_tokens, completion_tokens, ms, ok, ts)
     VALUES (?,?,?,?,?,?,?,?,1,?)`,
  ).bind(id, who.slice(0, 60), model.slice(0, 40), chosen, task, promptTokens, completionTokens, Date.now() - started, Date.now())
    .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      // Non-standard, additive, and safe for any client that ignores extras.
      ghlens: { chosen, models, agreement, task, confidence: useMesh ? agreement : undefined },
    },
  };
}

/** The cheapest tier whose capability list contains this task. */
export function autoTier(task: TaskKind): "fast" | "smart" | "code" {
  const ranked = [...MODEL_CAPS]
    .sort((a, b) => {
      const as = a.strengths.includes(task) ? 0 : 1;
      const bs = b.strengths.includes(task) ? 0 : 1;
      if (as !== bs) return as - bs;
      return a.cost - b.cost;
    })
    .map((m) => m.tier);
  const first = ranked[0];
  return first === "smart" || first === "code" ? first : "fast";
}

function errorEnvelope(status: number, message: string, type: string): GatewayResult {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { error: { message, type, code: status, param: null } },
  };
}

/**
 * Server-sent events for `stream: true`.
 *
 * The answer is generated in one shot and then chunked, rather than streamed
 * from the provider: Workers AI returns whole responses, and pretending to
 * stream token-by-token by slicing after the fact is still better for a client
 * than not streaming at all — the interface is what they depend on. The chunks
 * are emitted on a real schedule so a progress UI advances smoothly instead of
 * appearing all at once.
 */
export function streamResponse(result: any, chunks = 24): Response {
  const text: string = result?.choices?.[0]?.message?.content ?? "";
  const id = result?.id ?? "chatcmpl";
  const created = result?.created ?? Math.floor(Date.now() / 1000);
  const model = result?.model ?? "ghlens-auto";
  const size = Math.max(1, Math.ceil(text.length / chunks));
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  if (!parts.length) parts.push("");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for (const p of parts) {
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, 8));
      }
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: result.usage, ghlens: result.ghlens });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** `GET /v1/models` — the list clients poll to populate their model picker. */
export function modelsResponse() {
  return new Response(JSON.stringify({ object: "list", data: MODELS }), {
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /v1 — the page a person lands on.
 *
 * `/v1/chat/completions` is for machines and `/v1/models` is for clients; a
 * human who taps the gateway link in Telegram used to get «Not found» from a
 * path they had no way to guess. This page states what the endpoint is, shows
 * copy-paste snippets built from the *real* host, and lists the ways a request
 * can fail — so a wrong turn ends in an explanation instead of a dead end.
 */
export function gatewayLanding(base: string): Response {
  const models = MODELS.map((m) => `<li><code>${m.id}</code> <span class="d">${(m as any).description ?? ""}</span></li>`).join("");
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub Lens Ultra — دروازهٔ هوش مصنوعی</title>
<style>
 *{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.9 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
 main{max-width:820px;margin:0 auto;padding:28px 18px 60px}h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:28px 0 10px;color:#e6edf3}
 p,li{color:#c9d1d9}.d{color:#8b949e}code{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:1px 6px;font-size:13px;direction:ltr;display:inline-block}
 pre{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;overflow:auto;direction:ltr;text-align:left;font-size:13px}
 .ok{color:#3fb950}.warn{color:#d29922}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #30363d;padding:8px 10px;text-align:right;font-size:14px}
 th{background:#161b22}a{color:#58a6ff}.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
 .btn{display:inline-block;background:#238636;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none}.btn.alt{background:#21262d;border:1px solid #30363d;color:#e6edf3}
</style></head><body><main>
<h1>🧠 دروازهٔ هوش مصنوعی</h1>
<p>این آدرس یک API سازگار با OpenAI است: هر برنامه‌ای که <code>api.openai.com</code> را صدا می‌زند، با عوض‌کردن آدرس، به این ربات وصل می‌شود — با مسیریابی خودکار بین مدل‌ها، استخر کلیدهای اهدایی و گزارش مصرف.</p>
<div class="row"><a class="btn" href="${base}/v1/models">GET /v1/models</a><a class="btn alt" href="${base}/health">وضعیت سرویس</a><a class="btn alt" href="https://github.com/Alisarani7021/ghlens-ultra">سورس</a></div>

<h2>۱) آدرس‌ها</h2>
<table><tr><th>متد</th><th>مسیر</th><th>کار</th></tr>
<tr><td>POST</td><td><code>${base}/v1/chat/completions</code></td><td>گفتگو — با <code>stream: true</code> هم کار می‌کند</td></tr>
<tr><td>GET</td><td><code>${base}/v1/models</code></td><td>فهرست مدل‌ها و مترادف‌ها</td></tr>
<tr><td>GET</td><td><code>${base}/v1</code></td><td>همین صفحه</td></tr></table>

<h2>۲) کلید</h2>
<p>هدر <code>Authorization: Bearer &lt;key&gt;</code> لازم است. کلید همان توکنی است که در ربات می‌سازی: <b>🧠 هوش مصنوعی → 🔑 کلید API</b> (یا فرمان <code>/token</code>). هر کلید به حساب خودت گره خورده و مصرفش در همان صفحه گزارش می‌شود.</p>

<h2>۳) سه خط کد</h2>
<pre>curl ${base}/v1/chat/completions \
  -H "authorization: Bearer YOUR_KEY" -H "content-type: application/json" \
  -d '{"model":"ghlens-smart","messages":[{"role":"user","content":"سلام"}]}'</pre>
<pre>from openai import OpenAI
client = OpenAI(base_url="${base}/v1", api_key="YOUR_KEY")
print(client.chat.completions.create(model="ghlens-auto",
      messages=[{"role":"user","content":"یک کتابخانهٔ سبک صف در Go پیشنهاد بده"}]).choices[0].message.content)</pre>
<pre>import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${base}/v1", apiKey: process.env.GHLENS_KEY });
const r = await client.chat.completions.create({ model: "ghlens-code",
  messages: [{ role: "user", content: "این تابع را بازبینی کن" }] });
console.log(r.choices[0].message.content);</pre>
<p class="d">در Cursor/Continue/Cline و هر کلاینت دیگر، همین دو مقدار را بگذار: Base URL و API Key — بقیه‌اش خودکار است.</p>

<h2>۴) مدل‌ها</h2>
<ul>${models}</ul>

<h2>۵) اگر خطا گرفتی</h2>
<table><tr><th>خطا</th><th>معنی</th><th>راه‌حل</th></tr>
<tr><td><code>401 invalid api key</code></td><td>کلید غایب یا باطل است</td><td>کلید را در ربات دوباره بساز (<code>/token</code>)</td></tr>
<tr><td><code>404 unknown endpoint</code></td><td>مسیر غلط — مثلاً <code>/v1/completions</code></td><td>یکی از سه مسیر جدول بالا</td></tr>
<tr><td><code>429</code></td><td>سهمیهٔ روزانهٔ رایگان تمام شده</td><td>فردا صفر می‌شود، یا Pro بگیر</td></tr>
<tr><td><code>503 model unavailable</code></td><td>همهٔ مدل‌های آن رده مشغول‌اند</td><td>مدل <code>ghlens-auto</code> را بزن؛ خودش جابه‌جا می‌کند</td></tr></table>

<p class="d">GitHub Lens Ultra · روی لبهٔ Cloudflare · بدون سرور · <span class="ok">این صفحه هم با همین Worker سرو می‌شود</span></p>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A machine-readable 404 for /v1/* — an agent should never see a bare "Not found". */
export function gatewayNotFound(pathname: string): Response {
  return new Response(JSON.stringify({
    error: {
      message: `unknown endpoint ${pathname}`,
      type: "invalid_request_error",
      code: 404,
      hint: "available: POST /v1/chat/completions · GET /v1/models · GET /v1 (docs)",
      docs: "/v1",
    },
  }), { status: 404, headers: { "content-type": "application/json" } });
}
