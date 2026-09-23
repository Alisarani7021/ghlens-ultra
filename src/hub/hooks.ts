import type { Ctx, Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { Telegram } from "../tg/api";
import { type HubEvent, hubId, newTrace } from "./event";
import { publish } from "./bus";
import { hubId as _hubId } from "./event";

/**
 *  WEBHOOK RECEIVER
 *
 *      Internet → /hooks/<source>/<key> → validate → normalise → bus → workflow
 *
 *  One endpoint per source, one shared pipeline. The important property is that
 *  an inbound webhook and a polled connector produce **the same envelope**, so
 *  nothing downstream needs to know which way the event arrived.
 *
 *  Validation is per-source and deliberate:
 *   • GitHub   — HMAC-SHA256 over the raw body against a per-owner secret
 *   • Stripe   — the same scheme with the `t=…,v1=…` signed-payload format
 *   • generic  — a shared secret in the URL path or an `x-hub-signature` header
 *
 *  A wrong or missing signature is a 401 before any parsing happens, because
 *  parsing attacker-controlled JSON first is exactly the mistake this endpoint
 *  exists to avoid.
 */

export interface HookResult {
  ok: boolean;
  status: number;
  event_id?: string;
  type?: string;
  duplicate?: boolean;
  runs?: number;
}

/** The raw signature checks, kept as pure functions so they can be tested. */
export async function hmacHex(secret: string, body: string, algo: "SHA-256" | "SHA-1" = "SHA-256"): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: algo }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time compare.
 *
 * Timing-safe comparison matters even here: a length or early-exit leak lets an
 * attacker recover a signature byte by byte, one request per guess. The XOR
 * fold has no early exit and no branch on the data.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyGithub(body: string, header: string, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + (await hmacHex(secret, body));
  return timingSafeEqual(expected, header);
}

/**
 * Stripe's scheme: `t=<unix>,v1=<hex>`, signed over `<t>.<body>`.
 *
 * The timestamp is part of the signed payload precisely so an old captured
 * request cannot be replayed — so we must also bound its age ourselves.
 */
export async function verifyStripe(body: string, header: string, secret: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return timingSafeEqual(expected, v1);
}

/** The event type a provider's payload should become on the bus. */
export function classifyGithub(event: string, payload: any): string {
  const action = payload?.action ?? "";
  switch (event) {
    case "release": return `github.release.${action === "prereleased" ? "prerelease" : action || "published"}`;
    case "push": return "github.push.commits";
    case "issues": return `github.issue.${action || "opened"}`;
    case "pull_request": return `github.pr.${action || "opened"}`;
    case "workflow_run": return `github.ci.${payload?.workflow_run?.conclusion ?? action ?? "completed"}`;
    case "star": return `github.star.${action || "created"}`;
    case "fork": return `github.fork.${action || "created"}`;
    case "security_advisory": return "github.security.advisory";
    case "ping": return "github.ping";
    default: return `github.${event || "unknown"}`;
  }
}

/** GitHub's payload → the flat shape every workflow already understands. */
export function normaliseGithub(event: string, payload: any): { identity: string; data: Record<string, any> } {
  const repo = payload?.repository?.full_name ?? "";
  if (event === "release") {
    const r = payload.release ?? {};
    return {
      identity: `${repo}@${r.tag_name ?? r.id}`,
      data: {
        repo, tag: r.tag_name ?? "", name: r.name ?? r.tag_name ?? "",
        body: (r.body ?? "").slice(0, 4000), url: r.html_url ?? "",
        published_at: r.published_at ?? r.created_at ?? "", prerelease: !!r.prerelease,
        author: r.author?.login ?? "", draft: !!r.draft,
        assets: (r.assets ?? []).map((a: any) => ({
          name: a.name, size: a.size, downloads: a.download_count,
          url: a.browser_download_url, type: a.content_type,
        })),
      },
    };
  }
  if (event === "push") {
    const commits = (payload.commits ?? []).slice(0, 25);
    return {
      identity: `${repo}@${payload.after ?? commits[0]?.id ?? Date.now()}`,
      data: {
        repo,
        branch: String(payload.ref ?? "").replace("refs/heads/", ""),
        commits: commits.map((c: any) => ({
          id: c.id, message: String(c.message ?? "").split("\n")[0].slice(0, 200),
          author: c.author?.name ?? "", url: c.url ?? "",
        })),
        count: commits.length, pusher: payload.pusher?.name ?? "",
        compare_url: payload.compare ?? "",
      },
    };
  }
  if (event === "issues" || event === "pull_request") {
    const o = payload.issue ?? payload.pull_request ?? {};
    return {
      identity: `${repo}#${o.number}`,
      data: {
        repo, number: o.number, title: o.title ?? "", url: o.html_url ?? "",
        author: o.user?.login ?? "", state: o.state ?? "",
        labels: (o.labels ?? []).map((l: any) => l.name ?? String(l)),
        body: String(o.body ?? "").slice(0, 2000),
        additions: o.additions, deletions: o.deletions, changed_files: o.changed_files,
      },
    };
  }
  if (event === "workflow_run") {
    const w = payload.workflow_run ?? {};
    return {
      identity: `${repo}@${w.id}`,
      data: {
        repo, name: w.name ?? "", conclusion: w.conclusion ?? "", status: w.status ?? "",
        branch: w.head_branch ?? "", url: w.html_url ?? "", run_number: w.run_number,
      },
    };
  }
  if (event === "security_advisory") {
    const a = payload.security_advisory ?? {};
    return {
      identity: String(a.ghsa_id ?? a.cve_id ?? Date.now()),
      data: {
        repo, severity: a.severity ?? "", summary: a.summary ?? "",
        description: String(a.description ?? "").slice(0, 1500),
        ghsa: a.ghsa_id ?? "", cve: a.cve_id ?? "", url: a.html_url ?? "",
      },
    };
  }
  if (event === "star") {
    return { identity: `${repo}@${payload.starred_at ?? Date.now()}`, data: { repo, sender: payload.sender?.login ?? "", stars: payload.repository?.stargazers_count ?? 0 } };
  }
  return { identity: `${repo}@${payload?.after ?? payload?.action ?? Date.now()}`, data: { repo, raw_keys: Object.keys(payload ?? {}).slice(0, 12) } };
}

// ── the endpoint ───────────────────────────────────────────────────────────

/**
 * Handle `POST /hooks/{source}/{key}`.
 *
 * `key` is an opaque token minted when the owner creates the connector. It does
 * two jobs: it identifies *whose* workflow should run, and it is the secret for
 * sources that have no signature scheme of their own. It is never logged.
 */
export async function handleHook(
  request: Request,
  env: Env,
  ctx: Ctx,
  ai: AiBrain,
  source: string,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["hooks", source, key?, …]
  const key = parts[2] ?? "";
  if (!key) return json({ ok: false, error: "missing hook key" }, 401);

  const row = await env.DB.prepare(
    `SELECT id, owner_id, kind, config FROM hub_connectors WHERE id=? OR json_extract(config,'$.hook_key')=? LIMIT 1`,
  ).bind(key, key).first<any>().catch(() => null);
  if (!row) return json({ ok: false, error: "unknown hook" }, 401);

  // The body is read once, as text, because every signature scheme signs the
  // raw bytes — re-serialising parsed JSON would change them.
  const body = await request.text();
  const src = source || row.kind;

  let ownerId = Number(row.owner_id);
  let config: Record<string, any> = {};
  try { config = JSON.parse(row.config ?? "{}"); } catch { /* {} */ }

  // ── validation, before any parsing ──────────────────────────────────────
  const secret = String(config.secret ?? env.GITHUB_WEBHOOK_SECRET ?? "");
  if (src === "github") {
    const header = request.headers.get("x-hub-signature-256") ?? "";
    if (secret && !(await verifyGithub(body, header, secret))) {
      return json({ ok: false, error: "bad signature" }, 401);
    }
  } else if (src === "stripe") {
    const header = request.headers.get("stripe-signature") ?? "";
    if (secret && !(await verifyStripe(body, header, secret))) {
      return json({ ok: false, error: "bad signature" }, 401);
    }
  } else {
    // Generic sources: the hook key in the path already authenticates, but a
    // caller that also sends a signature gets it checked.
    const header = request.headers.get("x-hub-signature-256") ?? "";
    if (header && secret && !(await verifyGithub(body, header, secret))) {
      return json({ ok: false, error: "bad signature" }, 401);
    }
  }

  let payload: any = null;
  try { payload = JSON.parse(body); } catch { return json({ ok: false, error: "bad json" }, 400); }

  // ── normalise ───────────────────────────────────────────────────────────
  let type = `${src}.event`;
  let identity = "";
  let data: Record<string, any> = {};

  if (src === "github") {
    const ghEvent = request.headers.get("x-github-event") ?? "unknown";
    type = classifyGithub(ghEvent, payload);
    const n = normaliseGithub(ghEvent, payload);
    identity = n.identity; data = n.data;
    if (ghEvent === "ping") return json({ ok: true, type: "github.ping", note: "pong" });
    const configured = (config.repos as string[] | undefined) ?? [];
    if (configured.length && data.repo && !configured.includes(data.repo)) {
      return json({ ok: true, type, ignored: "repo not watched" });
    }
  } else if (src === "stripe") {
    type = `stripe.${payload?.type ?? "event"}`;
    identity = String(payload?.id ?? "");
    data = { id: payload?.id, amount: payload?.data?.object?.amount, currency: payload?.data?.object?.currency, customer: payload?.data?.object?.customer };
  } else {
    // Unknown source: give the owner the whole payload as data, and let the
    // path segment name the event so workflows can still match on it.
    type = `${src}.${payload?.type ?? payload?.event ?? "event"}`;
    identity = String(payload?.id ?? payload?.identity ?? (await sha(body)));
    data = typeof payload === "object" && payload !== null ? payload : { value: payload };
  }

  const trace = newTrace();
  const ev: HubEvent = {
    id: hubId("evt"), type, source: src, payload: { ...data, identity }, ts: Date.now(), trace, owner_id: ownerId,
  };

  const result = await publish({ env, ai, tg: new Telegram(env) }, ev);

  await env.DB.prepare(
    `INSERT OR REPLACE INTO hub_webhooks (id, owner_id, source, type, event_id, status, ts)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(hubId("whk"), ownerId, src, type, result.event_id, result.duplicate ? "duplicate" : "accepted", Date.now())
    .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

  void ctx;
  return json({
    ok: true, type, trace,
    event_id: result.event_id,
    duplicate: result.duplicate,
    runs: result.runs.map((r) => ({ id: r.run_id, state: r.state, steps: r.steps.length })),
  });
}

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export { _hubId };
