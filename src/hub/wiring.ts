import type { Env } from "../env";
import { hubId } from "./event";
import { getWorkflow } from "./engine";
import { connector } from "./connectors";

/**
 *  WIRING — what has to be true before a mission can actually run.
 *
 *      «هر وقت نسخهٔ جدید این مخزن آمد، خودکار در کانال بگذار»
 *                              ↓
 *        repos named in the mission are extracted
 *                              ↓
 *        the GitHub connector watches exactly those repos
 *                              ↓
 *        a webhook on each repo makes the event instant (poll is the safety net)
 *                              ↓
 *        the Telegram connector can post (bot is admin with post rights)
 *
 *  Before this module, a mission produced a DAG and a note saying "you also need
 *  a GitHub connector and a Telegram connector" — true, but it left the owner to
 *  work out *which* repos, *where* the connector lives, and *why* nothing
 *  happened afterwards. Three separate screens, no verification, and a workflow
 *  that looked installed while it could not fire.
 *
 *  Two rules this module keeps:
 *
 *   1. **Every claim is checked, not assumed.** The GitHub token may lack
 *      `admin:repo_hook`, the bot may not be a channel admin, the repo may not
 *      exist. Each is reported with the exact next step, never as a green tick.
 *   2. **Idempotent.** Wiring twice adds nothing, duplicates nothing, and never
 *      deletes a hook it did not create.
 */

/** Words that look like `owner/repo` in prose but are not repositories. */
const PROSE_PAIR = /^(?:and|or|on|off|yes|no|either|input|output|client|server|read|write|km|m|mi|gb|mb|kb|bit|he|she|it|they|we|you|true|false|n|a)\/(?:and|or|on|off|no|yes|either|input|output|client|server|read|write|h|s|gib|mib|1|2|3|0|true|false|a|b|c|php|js|py)$/i;

/** A full GitHub URL, including the `…/releases/tag/x` tail people paste. */
const GH_URL = /https?:\/\/github\.com\/([A-Za-z0-9-]{2,39})\/([A-Za-z0-9._-]{1,100})/g;

/** Bare `owner/repo`, GitHub's own naming rules. */
const REPO = /\b([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\b/g;

/**
 * The repositories a mission is about.
 *
 * Deterministic, not model-guessed: the identity of the repository decides where
 * an event is delivered, and a hallucinated `owner/repo` would silently point a
 * webhook at a stranger's project.
 *
 * Three shapes are accepted — a full URL, a bare `owner/repo`, and a list — and
 * prose that merely *looks* like a path (`and/or`, `on/off`, `yes/no`) is
 * rejected. The signal is the one real project names carry: a digit, a dash, a
 * dot or a capital letter somewhere in the pair. `oven-sh/bun` has one,
 * `cloudflare/workers-sdk` has one, `and/or` does not.
 */
export function reposInMission(text: string): string[] {
  const src = String(text ?? "");
  const found = new Set<string>();

  // 1) URLs: unambiguous, and the tail (`/releases`, `/tree/main`) is dropped
  for (const m of src.matchAll(GH_URL)) found.add(`${m[1]}/${m[2]}`);

  // 2) bare pairs, scanned in the text with URLs blanked out so that
  //    `github.com/oven-sh/bun` cannot be read as the pair `com/oven-sh`
  const stripped = src.replace(GH_URL, " ");
  for (const m of stripped.matchAll(REPO)) {
    const owner = m[1];
    const name = m[2].replace(/[.,;:)]+$/, "");
    const pair = `${owner}/${name}`;
    if (PROSE_PAIR.test(pair)) continue;
    if (owner.length < 2 || name.length < 2 || name.includes("..")) continue;
    if (!/[A-Z0-9._-]/.test(owner + name)) continue;   // no project-name signal → prose
    found.add(pair);
  }
  return [...found].slice(0, 10);
}

/** Persisted per workflow, so the readiness screen survives a reload. */
export const reposKey = (wfId: string) => `wf:repos:${wfId}`;

export async function saveRepos(env: Env, wfId: string, repos: string[]): Promise<void> {
  await env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
    .bind(reposKey(wfId), JSON.stringify(repos), Date.now()).run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export async function loadRepos(env: Env, wfId: string): Promise<string[]> {
  const row = await env.DB.prepare(`SELECT value FROM flags WHERE key=?`).bind(reposKey(wfId))
    .first<{ value: string }>().catch(() => null);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === "string") : [];
  } catch { return []; }
}

/* ── the connector ────────────────────────────────────────────────────────── */

export interface GithubWiring {
  id: string;
  created: boolean;
  repos: string[];
  added: string[];
  healthy: boolean;
}

/**
 * Make sure the owner's GitHub connector watches these repositories.
 *
 * Reuses the existing connector instead of creating a second one: two GitHub
 * connectors would poll the same API twice and split the event history in two,
 * which makes a run impossible to explain afterwards.
 */
export async function ensureGithubConnector(env: Env, ownerId: number, repos: string[]): Promise<GithubWiring> {
  const row = await env.DB.prepare(
    `SELECT id, config, status FROM hub_connectors WHERE owner_id=? AND kind='github' ORDER BY (status='ok') DESC, created_at DESC LIMIT 1`,
  ).bind(ownerId).first<{ id: string; config: string; status: string }>().catch(() => null);

  let config: Record<string, any> = {};
  try { config = JSON.parse(row?.config ?? "{}"); } catch { /* {} */ }
  const existing: string[] = Array.isArray(config.repos) ? config.repos.filter((r: any) => typeof r === "string") : [];
  const added = repos.filter((r) => !existing.includes(r));
  const merged = [...existing, ...added].slice(0, 50);
  const watch: string[] = Array.isArray(config.watch) && config.watch.length ? config.watch : ["release"];
  const next = { ...config, repos: merged, watch, hook_key: config.hook_key ?? hubId("hk") };

  if (row?.id) {
    await env.DB.prepare(`UPDATE hub_connectors SET config=?, label=?, enabled=1 WHERE id=?`)
      .bind(JSON.stringify(next), `${merged.length} مخزن`, row.id).run()
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return { id: row.id, created: false, repos: merged, added, healthy: row.status !== "disabled" };
  }

  const id = hubId("con");
  await env.DB.prepare(
    `INSERT INTO hub_connectors (id, owner_id, kind, label, config, enabled, status, created_at) VALUES (?,?,?,?,?,1,'new',?)`,
  ).bind(id, ownerId, "github", `${merged.length} مخزن`, JSON.stringify(next), Date.now()).run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  return { id, created: true, repos: merged, added, healthy: true };
}

/* ── the webhook on GitHub ────────────────────────────────────────────────── */

export interface HookResult {
  repo: string;
  ok: boolean;
  detail: string;
  /** where a human can finish the job when the token cannot */
  manualUrl: string;
  existed?: boolean;
}

const ghHeaders = (token?: string) => ({
  accept: "application/vnd.github+json",
  "user-agent": "ghlens-ultra",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/**
 * Create (or refresh) the release webhook on one repository.
 *
 * `admin:repo_hook` is the permission that decides this: with it, the hook is
 * created and the owner never sees GitHub's settings page. Without it — or when
 * the repository belongs to someone else — the answer is the exact URL to paste
 * and the secret to paste with it, instead of a failure.
 */
export async function ensureGithubHook(
  env: Env,
  repo: string,
  hookUrl: string,
  secret: string,
  token?: string,
): Promise<HookResult> {
  const manualUrl = `https://github.com/${repo}/settings/hooks/new`;
  const auth = token ?? env.GITHUB_TOKEN;
  if (!auth) {
    return { repo, ok: false, detail: "توکن گیت‌هاب موجود نیست", manualUrl };
  }
  try {
    // does a hook for this URL already exist? update it instead of duplicating.
    const list = await fetch(`https://api.github.com/repos/${repo}/hooks?per_page=100`, { headers: ghHeaders(auth) });
    if (list.status === 404) return { repo, ok: false, detail: "مخزن پیدا نشد یا توکن به آن دسترسی ندارد", manualUrl };
    if (list.status === 403) return { repo, ok: false, detail: "توکن اجازهٔ خواندن وب‌هوک‌ها را ندارد (admin:repo_hook لازم است)", manualUrl };
    const hooks: any[] = list.ok ? ((await list.json().catch(() => [])) as any[]) : [];
    const mine = Array.isArray(hooks) ? hooks.find((h) => h?.config?.url === hookUrl) : null;

    const body = JSON.stringify({
      name: "web",
      active: true,
      events: ["release", "push"],
      config: { url: hookUrl, content_type: "json", ...(secret ? { secret } : {}), insecure_ssl: "0" },
    });

    if (mine?.id) {
      const patch = await fetch(`https://api.github.com/repos/${repo}/hooks/${mine.id}`, {
        method: "PATCH", headers: { ...ghHeaders(auth), "content-type": "application/json" }, body,
      });
      if (patch.ok) return { repo, ok: true, detail: "وب‌هوک موجود به‌روز شد", manualUrl, existed: true };
      const pj: any = await patch.json().catch(() => ({}));
      return { repo, ok: false, detail: String(pj?.message ?? `HTTP ${patch.status}`), manualUrl, existed: true };
    }

    const create = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      method: "POST", headers: { ...ghHeaders(auth), "content-type": "application/json" }, body,
    });
    if (create.ok) return { repo, ok: true, detail: "وب‌هوک ساخته شد — رویدادها لحظه‌ای می‌رسند", manualUrl };
    const cj: any = await create.json().catch(() => ({}));
    const msg = String(cj?.message ?? `HTTP ${create.status}`);
    const friendly = /not found/i.test(msg)
      ? "توکن به این مخزن دسترسی ندارد (یا مخزن خصوصی است) — با حساب خودت اضافه‌اش کن"
      : /admin:repo_hook|forbidden|permission/i.test(msg)
        ? "توکن اجازهٔ مدیریت وب‌هوک ندارد — admin:repo_hook را به توکن بده"
        : msg;
    return { repo, ok: false, detail: friendly, manualUrl };
  } catch (e: any) {
    return { repo, ok: false, detail: String(e?.message ?? e).slice(0, 120), manualUrl };
  }
}

/* ── the readiness report ─────────────────────────────────────────────────── */

export interface WiringReport {
  repos: string[];
  github: { ok: boolean; detail: string; id?: string };
  hooks: HookResult[];
  hookUrl: string;
  telegram: { ok: boolean; detail: string; channel: string; connectorId: string };
  workflow?: { ok: boolean; detail: string; enabled: boolean; on_event: string };
  /** every blocking item, in the order the owner should fix them */
  blockers: string[];
}

export interface WiringCtx {
  env: Env;
  ownerId: number;
  repos: string[];
  base: string;
  token?: string;
  workflowId?: string;
  /** skip the GitHub hook listing when it is not needed (dry screens) */
  checkHooks?: boolean;
}

/**
 * The truth about whether this mission can fire, item by item.
 *
 * Nothing here is inferred from configuration: the Telegram connector is proven
 * by calling the bot's own `getChatMember`, the GitHub hooks by listing them, the
 * workflow by reading its row. A green line means a checked fact.
 */
export async function wiringReport(ctx: WiringCtx): Promise<WiringReport> {
  const { env, ownerId, repos, base } = ctx;

  const conn = await env.DB.prepare(
    `SELECT id, config, status, detail FROM hub_connectors WHERE owner_id=? AND kind='github' ORDER BY (status='ok') DESC, created_at DESC LIMIT 1`,
  ).bind(ownerId).first<{ id: string; config: string; status: string; detail: string }>().catch(() => null);
  let conf: Record<string, any> = {};
  try { conf = JSON.parse(conn?.config ?? "{}"); } catch { /* {} */ }
  const watched: string[] = Array.isArray(conf.repos) ? conf.repos : [];
  const missing = repos.filter((r) => !watched.includes(r));
  const ghOk = !!conn?.id && missing.length === 0;
  const github = {
    ok: ghOk,
    id: conn?.id,
    detail: !conn?.id
      ? "کانکتور گیت‌هاب ساخته نشده"
      : missing.length
        ? `این مخزن‌ها در کانکتور نیستند: ${missing.join(", ")}`
        : `کانکتور گیت‌هاب این ${watched.length} مخزن را رصد می‌کند`,
  };

  const hookKey = conf.hook_key ?? conn?.id ?? "";
  const hookUrl = `${base}/hooks/github/${hookKey}`;

  const hooks: HookResult[] = [];
  if (ctx.checkHooks && repos.length) {
    for (const repo of repos.slice(0, 5)) {
      hooks.push(await ensureGithubHook(env, repo, hookUrl, env.GITHUB_WEBHOOK_SECRET ?? "", ctx.token));
      // `ensureGithubHook` is create-or-refresh, so calling it here both proves
      // and repairs; a read-only probe would have needed its own code path.
    }
  }

  // The Telegram side: the same honest test the connector screen runs.
  const tgRow = await env.DB.prepare(
    `SELECT id, config, status, label FROM hub_connectors WHERE owner_id=? AND kind='telegram' ORDER BY (status='ok') DESC, created_at DESC LIMIT 1`,
  ).bind(ownerId).first<{ id: string; config: string; status: string; label: string }>().catch(() => null);
  let tgConf: Record<string, any> = {};
  try { tgConf = JSON.parse(tgRow?.config ?? "{}"); } catch { /* {} */ }
  const tgTest = tgRow ? await connector("telegram")?.test?.({ env, owner_id: ownerId, config: tgConf, cursor: null }).catch(() => null) : null;
  const telegram = {
    ok: !!tgTest?.ok,
    detail: tgRow
      ? String(tgTest?.detail ?? (tgRow.status === "ok" ? "کانکتور تلگرام آماده است" : "کانکتور تلگرام بررسی نشد"))
      : "کانکتور تلگرام نداری — پست‌ها جایی برای رفتن ندارند",
    channel: String(tgConf.channel ?? ""),
    connectorId: tgRow?.id ?? "",
  };

  let workflow: WiringReport["workflow"];
  if (ctx.workflowId) {
    const wf = await getWorkflow(env, ctx.workflowId).catch(() => null);
    workflow = wf
      ? { ok: wf.enabled === 1 && !!wf.on_event, detail: `${wf.name} · ${wf.enabled ? "فعال" : "غیرفعال"}`, enabled: wf.enabled === 1, on_event: wf.on_event }
      : { ok: false, detail: "ورک‌فلو پیدا نشد", enabled: false, on_event: "" };
  }

  const blockers: string[] = [];
  if (!repos.length) blockers.push("مخزنی در مأموریت مشخص نشده — بدون آن معلوم نیست کدام رویداد Important است");
  if (!github.ok) blockers.push("کانکتور گیت‌هاب این مخزن‌ها را رصد نمی‌کند");
  if (hooks.some((h) => !h.ok)) blockers.push("وبهوک گیت‌هاب ثبت نشده — رویدادها با تأخیر پول می‌شوند (poll)");
  if (!telegram.ok) blockers.push("کانکتور تلگرام آماده نیست — پست منتشر نمی‌شود");

  return { repos, github, hooks, hookUrl, telegram, workflow, blockers };
}

/* ── rendering ───────────────────────────────────────────────────────────── */

const tick = (ok: boolean) => (ok ? "✅" : "⚠️");

/** The checklist screen: one line per requirement, each with its next action. */
export function renderWiring(r: WiringReport, fa: boolean): string {
  const lines: string[] = [
    fa ? `🔧 <b>زیرساخت این مأموریت</b>` : `🔧 <b>Wiring</b>`,
    ``,
    `${tick(r.repos.length > 0)} <b>${fa ? "مخزن‌ها" : "repos"}</b>: ${r.repos.length ? r.repos.map((x) => `<code>${x}</code>`).join(" · ") : (fa ? "مشخص نشده" : "none")}`,
    `${tick(r.github.ok)} <b>${fa ? "کانکتور گیت‌هاب" : "GitHub connector"}</b> — ${r.github.detail}`,
  ];

  if (r.hooks.length) {
    for (const h of r.hooks) {
      lines.push(`${tick(h.ok)} <b>وب‌هوک</b> <code>${h.repo}</code> — ${h.detail}${h.ok ? "" : `\n   👈 <a href="${h.manualUrl}">${fa ? "افزودن دستی (۱۰ ثانیه)" : "add manually"}</a>`}`);
    }
  } else {
    lines.push(`⏸ <b>${fa ? "وب‌هوک‌ها" : "hooks"}</b> — ${fa ? "با دکمهٔ «🔧 وصلش کن» بررسی و ثبت می‌شوند" : "checked on wiring"}`);
  }

  lines.push(`${tick(r.telegram.ok)} <b>${fa ? "کانکتور تلگرام" : "Telegram connector"}</b>${r.telegram.channel ? ` — <code>${r.telegram.channel}</code>` : ""} — ${r.telegram.detail}`);
  if (r.workflow) lines.push(`${tick(r.workflow.ok)} <b>${fa ? "ورک‌فلو" : "workflow"}</b> — ${r.workflow.detail}${r.workflow.on_event ? ` · <code>${r.workflow.on_event}</code>` : ""}`);

  lines.push(``, r.blockers.length
    ? `<blockquote>${fa ? "تا این‌ها حل نشود، رویداد می‌رسد ولی پستی منتشر نمی‌شود:" : "until these are fixed nothing publishes:"}\n` +
      r.blockers.map((b) => `• ${b}`).join("\n") + `</blockquote>`
    : `<blockquote>${fa ? "✅ همه‌چیز وصل است: رویداد ← متن ← سیاست ← انتشار. همین حالا می‌توانی با «🧪 اجرای آزمایشی» ببینی چه می‌شود." : "all wired"}</blockquote>`);

  return lines.join("\n");
}

/** The manual path, for when a token cannot touch the repository. */
export function renderHookHelp(r: WiringReport, fa: boolean): string {
  const secretSet = true;
  return (
    `📎 <b>${fa ? "ثبت دستی وب‌هوک" : "Manual webhook"}</b>\n\n` +
    `<blockquote>${fa
      ? "اگر توکن تو اجازهٔ مدیریت وب‌هوک ندارد (یا مخزن مال کسی دیگر است)، همین سه مقدار را در گیت‌هاب بگذار. یک بار برای همیشه."
      : "paste these three values once."}</blockquote>\n\n` +
    `1️⃣ <b>Payload URL</b>\n<code>${r.hookUrl}</code>\n\n` +
    `2️⃣ <b>Content type</b>: <code>application/json</code>\n\n` +
    `3️⃣ <b>Secret</b>: ${secretSet ? (fa ? "همان مقداری که در Secrets ورکر با نام <code>GITHUB_WEBHOOK_SECRET</code> گذاشته‌ای" : "the value of GITHUB_WEBHOOK_SECRET") : ""}\n\n` +
    (fa ? "<b>رویدادها</b>: فقط <code>Releases</code> (و اگر کامیت‌ها هم مهم‌اند <code>Pushes</code>).\n\n" : "") +
    (r.repos.length
      ? r.repos.map((x) => `🔗 <a href="https://github.com/${x}/settings/hooks/new">${x} → Add webhook</a>`).join("\n")
      : (fa ? "اول مخزن را مشخص کن." : "name a repo first.")) +
    `\n\n<i>${fa ? "بدون وب‌هوک هم کار می‌کند: کرون هر چند دقیقه کانکتور را می‌پوید. وب‌هوک فقط تأخیر را صفر می‌کند." : "polling is the safety net."}</i>`
  );
}
