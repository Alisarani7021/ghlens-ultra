/**
 * One-click self-hosting.
 *
 * The ask was specific: a pre-filled link that creates a Cloudflare API token
 * with exactly the right permissions, then paste the token and the bot deploys
 * a working copy of itself into that account — no wrangler, no repository, no
 * CLI on the user's machine.
 *
 * How the copy is obtained is the interesting part. A worker cannot read its
 * own source, and shipping a second copy of the bundle inside the worker would
 * make every deploy twice as large and one version stale. Cloudflare will hand
 * back the *compiled* script it is currently running:
 *
 *   GET /accounts/{account}/workers/services/{script}/environments/production/content
 *
 * …which is a multipart body containing `index.js` and its source map. That is
 * the exact artefact to re-upload to someone else's account, so the copy is
 * byte-identical to the running worker and stays that way with no build step
 * here. (The older `/workers/scripts/{name}/content` path answers 405 for
 * account-scoped tokens — the service-scoped one is the one that works.)
 *
 * Everything after that is ordinary provisioning: create the D1 database, two
 * KV namespaces and the queue, split the schema into statements and load it,
 * remap the bindings to the new ids, and upload.
 *
 * Two rules this file follows on purpose:
 *   • every step reports what it did, including the ones that were skipped
 *     because the resource already existed — a re-run must be safe;
 *   • a failure says which step failed and what Cloudflare answered, because
 *     the person reading it cannot see the API response otherwise.
 */

const API = "https://api.cloudflare.com/client/v4";
const SCRIPT_NAME = "ghlens-ultra";

/**
 * The permission groups the token needs, and *why* each one — the token link
 * below encodes exactly this list, so the dashboard opens with the boxes
 * already ticked and nothing extra granted.
 */
export const TOKEN_PERMISSIONS: Array<{ key: string; type: "edit" | "read"; why: string }> = [
  { key: "workers_scripts", type: "edit", why: "آپلود خودِ ربات (Workers Scripts)" },
  { key: "workers_kv_storage", type: "edit", why: "ساخت دو فضای KV: کش و وضعیت" },
  { key: "d1", type: "edit", why: "ساخت دیتابیس D1 و اجرای اسکیما" },
  { key: "queues", type: "edit", why: "ساخت صف کارهای سنگین" },
  { key: "workers_ai", type: "edit", why: "مدل‌های Workers AI برای پاسخ و بردار" },
  { key: "account_settings", type: "read", why: "خواندن زیردامنهٔ workers.dev برای ساخت آدرس" },
  { key: "user_details", type: "read", why: "تأیید اعتبار خود توکن پیش از شروع" },
];

export function tokenLink(accountId?: string): string {
  const groups = TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(groups),
    name: "GHLens Ultra (self-host)",
  });
  if (accountId) params.set("accountId", accountId);
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}

type CfResult<T> = { ok: true; result: T } | { ok: false; error: string; status?: number };

async function cf<T = any>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<CfResult<T>> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(init.headers as Record<string, string> | undefined),
    },
  }).catch((e: any) => null);
  if (!res) return { ok: false, error: "ارتباط با API کلاودفلر برقرار نشد (خطای شبکه)" };
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* some endpoints answer with raw text */ }
  if (!res.ok || data?.success === false) {
    const detail =
      data?.errors?.map((e: any) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join(" · ") ||
      text.slice(0, 200) ||
      `HTTP ${res.status}`;
    return { ok: false, error: detail, status: res.status };
  }
  return { ok: true, result: (data?.result ?? (data as T)) as T };
}

export const verifyToken = (token: string) =>
  cf<{ id: string; status: string }>(token, "/user/tokens/verify");

export const listAccounts = (token: string) =>
  cf<Array<{ id: string; name: string }>>(token, "/accounts?per_page=50");

/** The worker's own compiled module, straight from the account that runs it. */
export async function fetchOwnBundle(
  env: any,
): Promise<{ ok: true; modules: Array<{ name: string; body: string }> } | { ok: false; error: string }> {
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!account || !token) {
    return { ok: false, error: "این نمونه برای ساخت نسخهٔ جدید پیکربندی نشده (CF_ACCOUNT_ID / CF_API_TOKEN ندارد)" };
  }
  const res = await fetch(
    `${API}/accounts/${account}/workers/services/${SCRIPT_NAME}/environments/production/content`,
    { headers: { authorization: `Bearer ${token}` } },
  ).catch(() => null);
  if (!res || !res.ok) {
    return { ok: false, error: `خواندن باندل خودم ناموفق بود (HTTP ${res?.status ?? "?"})` };
  }
  // The response is multipart/form-data, so let the runtime parse it rather
  // than hand-rolling a boundary splitter.
  let form: FormData;
  try {
    form = await new Response(res.body, { headers: res.headers }).formData();
  } catch (e: any) {
    return { ok: false, error: `باندل قابل تجزیه نبود: ${String(e?.message ?? e)}` };
  }
  // Cloudflare's multipart parts carry a `name` but no filename, so the runtime
  // hands them back as plain strings rather than File objects — the first
  // version of this filtered for File and quietly found "no JavaScript at all".
  // Accept both shapes, and fall back to the biggest non-map part if the module
  // is not named `.js` (Cloudflare has used other names, e.g. `worker.js`).
  const parts: Array<{ name: string; body: string }> = [];
  for (const [name, value] of form.entries()) {
    if (/\.map$/.test(name)) continue; // a source map is not uploaded again
    const body = typeof value === "string" ? value : await (value as File).text();
    if (body) parts.push({ name, body });
  }
  const modules = parts.filter((p) => /\.js$/.test(p.name));
  if (!modules.length && parts.length) {
    const biggest = parts.slice().sort((a, b) => b.body.length - a.body.length)[0];
    modules.push({ name: biggest.name.endsWith(".js") ? biggest.name : "index.js", body: biggest.body });
  }
  if (!modules.length) return { ok: false, error: "در پاسخ، ماژول جاوااسکریپت پیدا نشد" };
  return { ok: true, modules };
}

export const ownSettings = (env: any) =>
  cf<any>(env.CF_API_TOKEN, `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/settings`);

/** Existing resources in the target account, so a re-run does not duplicate. */
export async function survey(token: string, accountId: string) {
  const [kv, d1, queues] = await Promise.all([
    cf<Array<{ id: string; title: string }>>(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`),
    cf<Array<{ uuid: string; name: string }>>(token, `/accounts/${accountId}/d1/database`),
    cf<Array<{ queue_id: string; queue_name: string }>>(token, `/accounts/${accountId}/queues`),
  ]);
  return { kv, d1, queues };
}

async function ensureKv(token: string, accountId: string, title: string, existing?: string) {
  if (existing) return { id: existing, created: false };
  const r = await cf<{ id: string }>(token, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`KV «${title}»: ${r.error}`);
  return { id: r.result.id, created: true };
}

async function ensureD1(token: string, accountId: string, name: string, existing?: string) {
  if (existing) return { id: existing, created: false };
  const r = await cf<{ uuid: string }>(token, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`D1 «${name}»: ${r.error}`);
  return { id: r.result.uuid, created: true };
}

async function ensureQueue(token: string, accountId: string, name: string, existing?: string) {
  if (existing) return { id: existing, created: false };
  const r = await cf<{ queue_id: string }>(token, `/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
  if (!r.ok) throw new Error(`صف «${name}»: ${r.error}`);
  return { id: r.result.queue_id, created: true };
}

/**
 * Load the schema into the new database.
 *
 * Statements are sent in small batches rather than one giant string: a batch
 * that fails tells us *which* statements were already applied, and re-running
 * the deploy does not explode on `CREATE TABLE` that already exists — the DDL
 * is idempotent (`IF NOT EXISTS`) precisely so this is safe.
 */
export async function migrate(
  token: string,
  accountId: string,
  databaseId: string,
  statements: string[],
  onBatch?: (done: number, total: number) => Promise<void> | void,
): Promise<{ applied: number; failed?: string }> {
  const batchSize = 12;
  let applied = 0;
  for (let i = 0; i < statements.length; i += batchSize) {
    const batch = statements.slice(i, i + batchSize);
    const r = await cf(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: batch.join(";\n") }),
    });
    if (!r.ok) {
      return { applied, failed: `دستور ${i + 1} از ${statements.length}: ${r.error}` };
    }
    applied += batch.length;
    await onBatch?.(applied, statements.length);
  }
  return { applied };
}

/** Turn our own bindings into bindings for the copy. */
export function rebind(
  settings: any,
  ids: { d1?: string; cache?: string; state?: string; queue?: string },
  vars: Record<string, string>,
  secrets: Record<string, string>,
  workerUrl: string,
): { bindings: any[]; dropped: string[] } {
  const bindings: any[] = [];
  const dropped: string[] = [];
  for (const b of settings?.bindings ?? []) {
    switch (b.type) {
      case "d1":
        // Any D1 binding gets the new database; there is only one in this app.
        if (ids.d1) bindings.push({ type: "d1", name: b.name, id: ids.d1 });
        else dropped.push(b.name);
        break;
      case "kv_namespace": {
        const id = b.name === "CACHE" ? ids.cache : ids.state;
        if (id) bindings.push({ type: "kv_namespace", name: b.name, namespace_id: id });
        else dropped.push(b.name);
        break;
      }
      case "queue":
        if (ids.queue) bindings.push({ type: "queue", name: b.name, queue_name: "ghlens-jobs" });
        else dropped.push(b.name);
        break;
      case "durable_object_namespace":
        // The class ships inside the same module. `script_name` and the old
        // namespace id are deliberately left out: the copy must get its *own*
        // namespace, not a binding onto ours. The class name is required — the
        // settings endpoint reports the namespace id, not the class, so it
        // falls back to the known one.
        bindings.push({
          type: "durable_object_namespace",
          name: b.name,
          class_name: b.class_name ?? "UserSession",
        });
        break;
      case "ai":
        bindings.push({ type: "ai", name: b.name });
        break;
      case "plain_text":
        bindings.push({ type: "plain_text", name: b.name, text: vars[b.name] ?? b.text ?? "" });
        break;
      case "secret_text": {
        const text = secrets[b.name];
        if (text != null) bindings.push({ type: "secret_text", name: b.name, text });
        else dropped.push(b.name);
        break;
      }
      case "analytics_engine":
      case "vectorize":
      case "r2_bucket":
        dropped.push(`${b.name} (${b.type})`);
        break;
      default:
        // Unknown binding types are dropped rather than guessed at: an upload
        // rejected by the API halfway through leaves nothing behind.
        dropped.push(`${b.name} (${b.type})`);
    }
  }
  // WORKER_URL is derived, never copied from us.
  const url = bindings.find((b) => b.type === "plain_text" && b.name === "WORKER_URL");
  if (url) url.text = workerUrl;
  return { bindings, dropped };
}

/**
 * Upload the copy.
 *
 * `scriptName` is a parameter and not a constant for a reason that cost us the
 * live bot once: the first version of this hard-coded the source script's name
 * and ignored the per-owner name it was handed, so "deploy me a copy" uploaded
 * the *copy's* bindings — a random Telegram secret, an empty bot token — over
 * the production worker. The bot went dark and the only symptom on the far side
 * was a 403. The guard below makes that impossible rather than unlikely.
 */
export async function uploadScript(
  token: string,
  accountId: string,
  scriptName: string,
  modules: Array<{ name: string; body: string }>,
  metadata: any,
): Promise<CfResult<any>> {
  if (!scriptName || scriptName === SCRIPT_NAME) {
    return { ok: false, error: "نام هدف آپلود معتبر نیست — نمی‌شود ربات مبدأ را بازنویسی کرد" };
  }
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const m of modules) {
    form.set(m.name, new Blob([m.body], { type: "application/javascript+module" }), m.name);
  }
  return cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    body: form,
  });
}

/**
 * Wait for a freshly uploaded script to be readable.
 *
 * A `PUT` answers success for a brand-new name before the API will serve that
 * script back: asking immediately returns «10222 This Worker has no versions».
 * The upload was fine; the question was asked too early. Retry instead of
 * declaring a working deploy broken.
 */
export async function confirmScript(
  token: string,
  accountId: string,
  scriptName: string,
  attempts = 4,
): Promise<{ ok: boolean; error?: string }> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = await cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}`);
    if (r.ok) return { ok: true };
    last = r.error;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ok: false, error: last };
}

export const workersDevSubdomain = (token: string, accountId: string) =>
  cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`);

export const enableSubdomain = (token: string, accountId: string, script = SCRIPT_NAME) =>
  cf(token, `/accounts/${accountId}/workers/scripts/${script}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });

export const setSchedules = (token: string, accountId: string, crons: string[], script = SCRIPT_NAME) =>
  cf(token, `/accounts/${accountId}/workers/scripts/${script}/schedules`, {
    method: "PUT",
    body: JSON.stringify(crons.map((cron) => ({ cron }))),
  });

/** Point the new owner's bot at its own worker. */
export async function setTelegramWebhook(botToken: string, url: string, secret: string) {
  const r: any = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${url}/tg/${secret}`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query", "inline_query"],
      drop_pending_updates: true,
    }),
  }).then((x) => x.json()).catch(() => null);
  return r?.ok ? { ok: true as const } : { ok: false as const, error: String(r?.description ?? "setWebhook failed") };
}

export function randomSecret(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unique per install, so two copies never collide outside their own account. */
export function scriptNameFor(ownerId: number): string {
  return `${SCRIPT_NAME}-${String(ownerId).slice(-6)}`;
}

export interface ProvisionProgress {
  step: string;
  detail?: string;
}

export interface ProvisionResult {
  ok: boolean;
  url?: string;
  account?: string;
  steps: string[];
  dropped?: string[];
  error?: string;
}

/**
 * The whole flow, in order, reporting as it goes.
 *
 * Every `await` that touches the network may fail on a permission the token
 * does not have; those failures come back as a sentence naming the step, which
 * is the difference between "it didn't work" and "the token is missing Queues".
 */
export async function provision(
  env: any,
  opts: {
    token: string;
    ownerId: number;
    botToken?: string;
    statements: string[];
    onProgress?: (p: ProvisionProgress) => Promise<void> | void;
  },
): Promise<ProvisionResult> {
  const steps: string[] = [];
  const say = async (step: string, detail?: string) => {
    steps.push(detail ? `${step} — ${detail}` : step);
    await opts.onProgress?.({ step, detail });
  };

  // 1. is this token real?
  const v = await verifyToken(opts.token);
  if (!v.ok) return { ok: false, steps, error: `توکن تأیید نشد: ${v.error}` };
  if (v.result.status !== "active") {
    return { ok: false, steps, error: `این توکن ${v.result.status} است، نه active` };
  }
  await say("✅ توکن تأیید شد");

  // 2. which account
  const acc = await listAccounts(opts.token);
  if (!acc.ok) return { ok: false, steps, error: `فهرست حساب‌ها خوانده نشد: ${acc.error}` };
  const account = acc.result[0];
  if (!account) return { ok: false, steps, error: "این توکن به هیچ حسابی دسترسی ندارد" };
  await say("✅ حساب انتخاب شد", `${account.name} (${account.id.slice(0, 8)}…)`);

  // 3. our own bundle
  const bundle = await fetchOwnBundle(env);
  if (!bundle.ok) return { ok: false, steps, error: bundle.error };
  const kb = Math.round(bundle.modules.reduce((n, m) => n + m.body.length, 0) / 1024);
  await say("✅ باندل نسخهٔ فعلی گرفته شد", `${kb}KB`);

  // 4. resources
  const existing = await survey(opts.token, account.id);
  const kvMap = new Map((existing.kv.ok ? existing.kv.result : []).map((n) => [n.title, n.id]));
  const d1Map = new Map((existing.d1.ok ? existing.d1.result : []).map((n) => [n.name, n.uuid]));
  const queueMap = new Map((existing.queues.ok ? existing.queues.result : []).map((q) => [q.queue_name, q.queue_id]));

  const d1 = await ensureD1(opts.token, account.id, "ghlens", d1Map.get("ghlens"));
  const cache = await ensureKv(opts.token, account.id, "ghlens-cache", kvMap.get("ghlens-cache"));
  const state = await ensureKv(opts.token, account.id, "ghlens-state", kvMap.get("ghlens-state"));
  const queue = await ensureQueue(opts.token, account.id, "ghlens-jobs", queueMap.get("ghlens-jobs"));
  await say(
    d1.created || cache.created || state.created || queue.created ? "✅ منابع ساخته شدند" : "✅ منابع از قبل بودند",
    `D1 ${d1.created ? "جدید" : "موجود"} · KV ×2 · صف ${queue.created ? "جدید" : "موجود"}`,
  );

  // 5. schema
  const mig = await migrate(opts.token, account.id, d1.id, opts.statements, async (done, total) => {
    if (done === total || done % 24 === 0) await say("⏳ ساخت جدول‌ها", `${done}/${total}`);
  });
  if (mig.failed) return { ok: false, steps, error: `اجرای اسکیما: ${mig.failed}` };
  await say("✅ جدول‌ها ساخته شدند", `${mig.applied} دستور`);

  // 6. names, secrets, url
  const scriptName = scriptNameFor(opts.ownerId);
  const sub = await workersDevSubdomain(opts.token, account.id);
  const subdomain = sub.ok ? sub.result.subdomain : "";
  const url = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : "";
  const tgSecret = randomSecret();
  const secrets: Record<string, string> = {
    TELEGRAM_WEBHOOK_SECRET: tgSecret,
    DOWNLOAD_SIGNING_KEY: randomSecret(),
    GITHUB_WEBHOOK_SECRET: randomSecret(),
    CF_ACCOUNT_ID: account.id,
    CF_API_TOKEN: opts.token,
    ...(opts.botToken ? { BOT_TOKEN: opts.botToken } : {}),
    ADMIN_IDS: String(opts.ownerId),
    GITHUB_TOKEN: "",
    BOT_USERNAME: "",
    HELPER_REPO: "",
  };
  const vars: Record<string, string> = {
    DEFAULT_LOCALE: "fa",
    MAX_TG_UPLOAD_MB: "49",
    FREE_TIER_DAILY_QUERIES: "200",
    HELPER_REPO: "",
    WORKER_URL: url || `https://${scriptName}.workers.dev`,
  };
  const settings = await ownSettings(env);
  if (!settings.ok) return { ok: false, steps, error: `تنظیمات نسخهٔ فعلی خوانده نشد: ${settings.error}` };
  const { bindings, dropped } = rebind(settings.result, { d1: d1.id, cache: cache.id, state: state.id, queue: queue.id }, vars, secrets, vars.WORKER_URL);
  if (!bindings.some((b) => b.type === "d1")) {
    return { ok: false, steps, error: "اتصال D1 ساخته نشد — بدون آن نسخهٔ جدید کار نمی‌کند" };
  }

  // 7. upload
  // A Durable Object binding is rejected unless the upload also declares a
  // migration that creates the class, and on a free plan the only accepted form
  // is a *sqlite* class (`new_sqlite_classes`) — plain `new_classes` answers
  // «In order to use Durable Objects with a free plan…». Both were discovered
  // by uploading for real; wrangler does this from the config and the raw API
  // does not do it for you.
  const doClasses = bindings
    .filter((b) => b.type === "durable_object_namespace")
    .map((b) => String(b.class_name));
  const metadata: any = {
    main_module: bundle.modules[0].name,
    compatibility_date: settings.result.compatibility_date ?? "2024-11-06",
    compatibility_flags: settings.result.compatibility_flags ?? ["nodejs_compat"],
    bindings,
    observability: { enabled: true, head_sampling_rate: 1 },
    ...(doClasses.length ? { migrations: { new_tag: "v1", new_sqlite_classes: doClasses } } : {}),
  };
  const up = await uploadScript(opts.token, account.id, scriptName, bundle.modules, metadata);
  if (!up.ok) {
    return { ok: false, steps, error: `آپلود ربات: ${up.error}`, dropped };
  }
  // "success": true is not proof of a worker. The first version of this shipped
  // straight past a rejected upload because the API answered success and the
  // script was never created — the copy only failed later, at the subdomain
  // step, with «This Worker does not exist on your account». Ask for it back…
  const confirm = await confirmScript(opts.token, account.id, scriptName);
  await say(
    confirm.ok ? "✅ ربات آپلود شد" : "⚠️ آپلود موفق گزارش شد ولی ورکر دیده نمی‌شود",
    confirm.ok ? scriptName : "ادامه می‌دهم و آخر کار سلامت را واقعی تست می‌کنم",
  );

  // 8. address + cron + webhook (each best-effort, each reported)
  if (url) {
    const subOn = await enableSubdomain(opts.token, account.id, scriptName);
    await say(subOn.ok ? "✅ آدرس workers.dev روشن شد" : "⚠️ روشن‌کردن آدرس ناموفق", url);
  } else {
    await say("⚠️ زیردامنهٔ workers.dev پیدا نشد", "بعداً در داشبورد روشنش کن");
  }
  const sched = await setSchedules(opts.token, account.id, ["*/15 * * * *", "0 * * * *", "0 6 * * *"], scriptName);
  /* Free plans cap cron triggers per ACCOUNT (5), and other projects on the same
     account usually own them all. That is a limit on *automatic* polling — the
     copy still answers every command, receives webhooks instantly, and can pull
     events by hand. So the failure is reported as exactly that, with the two
     ways out, instead of a bare API error. */
  await say(
    sched.ok ? "✅ زمان‌بندی‌ها ثبت شد" : "⚠️ زمان‌بندی خودکار ثبت نشد (ربات کار می‌کند)",
    sched.ok
      ? "۳ کرون"
      : `${String(sched.error).slice(0, 120)} — این فقط «زمان‌بندی خودکار» را خاموش می‌کند: فرمان‌ها و وبهوک‌ها کار می‌کنند و می‌توانی با دکمهٔ «دریافت رویدادها الان» دستی بکشی. برای روشن‌کردنش یا یک اسلات کرون از این حساب را آزاد کن، یا نسخه را با توکن یک حساب کلودفلر دیگر بساز (هر حساب سهمیهٔ خودش را دارد).`,
  );

  // Without a consumer the queue fills up and nothing ever runs it.
  const cons = await cf(opts.token, `/accounts/${account.id}/queues/${queue.id}/consumers`, {
    method: "POST",
    body: JSON.stringify({
      type: "worker",
      // `script` is silently wrong — the API answers «script_name is required
      // for consumer type worker». The queue would simply never be consumed.
      script_name: scriptName,
      settings: { batch_size: 10, max_wait_time_ms: 5000, max_retries: 3, max_concurrency: 2 },
    }),
  });
  await say(
    cons.ok ? "✅ مصرف‌کنندهٔ صف وصل شد" : "⚠️ مصرف‌کنندهٔ صف وصل نشد",
    cons.ok ? undefined : cons.error,
  );

  if (opts.botToken && url) {
    const hook = await setTelegramWebhook(opts.botToken, url, tgSecret);
    await say(hook.ok ? "✅ وبهوک تلگرام وصل شد" : "⚠️ وبهوک وصل نشد", hook.ok ? undefined : hook.error);
  }

  // A worker that was uploaded ten seconds ago is not always reachable yet:
  // the first version of this called the 404 a failure and told the user their
  // brand-new copy was broken. It was live a few seconds later. So: retry, and
  // check a route that proves the *app* runs (not just the edge).
  // Measured twice: a copy that answers 200 takes 40–60 seconds to start
  // serving after the subdomain is switched on. The probe waits most of that
  // out; if it still is not up, that is "the edge is still warming", not a
  // failed deploy — the script, its config and its address are all confirmed
  // by this point, and calling that a failure would be a lie.
  let healthStatus = 0;
  if (url) {
    for (let i = 0; i < 10; i++) {
      healthStatus = await fetch(`${url}/v1/models`).then((r) => r.status).catch(() => 0);
      if (healthStatus === 200) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const status = healthStatus;
    await say(
      status === 200 ? "✅ نسخهٔ جدید جواب می‌دهد" : "🕓 لبه هنوز منتشر نشده",
      status === 200 ? `${url}/v1/models → 200` : `یک دقیقهٔ دیگر باز کن؛ آخرین بررسی HTTP ${status || "—"}`,
    );
  }

  // The verdict belongs to the health probe, not to the API's politeness.
  if (!confirm.ok && healthStatus !== 200) {
    return {
      ok: false,
      steps,
      error:
        `ورکر ساخته نشد: ${confirm.error}. ` +
        "معمولاً یعنی توکن دسترسی Workers Scripts: Edit ندارد.",
      dropped,
    };
  }

  return { ok: true, url: url || undefined, account: account.name, steps, dropped };
}

export const DEPLOY_SCRIPT_NAME = SCRIPT_NAME;
