import type { Env } from "../env";

/**
 * The event envelope — the only shape that moves through the hub.
 *
 * Everything the platform does is triggered by one of these. GitHub sends a
 * release, an RSS connector notices a new article, a webhook lands from an
 * arbitrary service — they all get normalised into this shape *before* any
 * workflow sees them, so a workflow never has to know who sent it.
 *
 *   { type: "github.release.created", source: "github", payload, trace, … }
 *
 * Two fields carry the weight:
 *   • `trace`  — minted once at the edge and copied into every run, content
 *                row and log line it spawns, so "why did this post appear?"
 *                is always answerable.
 *   • `dedupe` — a stable identity for the *event itself*. Webhooks are
 *                delivered at-least-once; GitHub retries, cron overlaps, and
 *                a workflow that runs twice must not publish twice. The unique
 *                index on `dedupe` is what makes that a database guarantee
 *                instead of a hope.
 */
export interface HubEvent {
  id: string;
  /** dotted, always `source.object.verb` — e.g. `github.release.published` */
  type: string;
  source: ConnectorKind | string;
  payload: Record<string, any>;
  ts: number;
  trace: string;
  owner_id?: number;
  dedupe?: string;
}

export type ConnectorKind = "github" | "rss" | "http" | "telegram" | "webhook" | "manual";

/** Short, sortable, collision-resistant. Time-prefixed so logs read in order. */
export function hubId(prefix: string, now = Date.now()): string {
  const t = now.toString(36).padStart(9, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${t}${rand}`;
}

export const newTrace = () => "tr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);

/** Hex SHA-256 — used for dedupe keys and content fingerprints. */
export async function digest(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The identity of an event: what it *is*, not when it arrived.
 *
 * Deliberately excludes the timestamp — GitHub re-delivering the same release
 * an hour later must hash to the same value, or the unique index would let the
 * duplicate straight through.
 */
export async function eventDedupe(ev: Pick<HubEvent, "type" | "source" | "payload" | "owner_id">): Promise<string> {
  const subject =
    ev.payload?.identity ??
    ev.payload?.sha ??
    ev.payload?.guid ??
    ev.payload?.id ??
    ev.payload?.release?.tag_name ??
    ev.payload?.tag_name ??
    ev.payload?.url ??
    ev.payload?.link ??
    JSON.stringify(ev.payload ?? {}).slice(0, 200);
  return digest(`${ev.source}|${ev.type}|${ev.owner_id ?? 0}|${subject}`);
}

export interface StoredEvent extends HubEvent {
  handled: number;
  error?: string | null;
}

/** Persist an event. Returns null when it is a duplicate we have already seen. */
export async function storeEvent(env: Env, ev: HubEvent): Promise<HubEvent | null> {
  if (!ev.dedupe) ev.dedupe = await eventDedupe(ev);
  try {
    await env.DB.prepare(
      `INSERT INTO hub_events (id, type, source, payload, trace, owner_id, dedupe, ts, handled)
       VALUES (?,?,?,?,?,?,?,?,0)`,
    )
      .bind(ev.id, ev.type, ev.source, JSON.stringify(ev.payload ?? {}), ev.trace, ev.owner_id ?? null, ev.dedupe, ev.ts)
      .run();
    return ev;
  } catch (e: any) {
    // UNIQUE constraint on dedupe → this exact event already exists. Not an
    // error: it's the guarantee working.
    if (/UNIQUE|constraint/i.test(String(e?.message ?? e))) return null;
    console.error("hub-event-store", String(e?.message ?? e));
    throw e;
  }
}

export async function markEvent(env: Env, id: string, err?: string) {
  await env.DB.prepare(`UPDATE hub_events SET handled=1, error=? WHERE id=?`)
    .bind(err ? err.slice(0, 300) : null, id)
    .run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export async function recentEvents(env: Env, ownerId?: number, limit = 12): Promise<StoredEvent[]> {
  const q = ownerId
    ? env.DB.prepare(`SELECT * FROM hub_events WHERE owner_id=? OR owner_id IS NULL ORDER BY ts DESC LIMIT ?`).bind(ownerId, limit)
    : env.DB.prepare(`SELECT * FROM hub_events ORDER BY ts DESC LIMIT ?`).bind(limit);
  const { results } = await q.all<any>().catch(() => ({ results: [] as any[] }));
  return (results ?? []).map(rowToEvent);
}

export function rowToEvent(r: any): StoredEvent {
  let payload: any = {};
  try { payload = JSON.parse(r.payload ?? "{}"); } catch { /* keep {} */ }
  return {
    id: r.id, type: r.type, source: r.source, payload, ts: r.ts,
    trace: r.trace, owner_id: r.owner_id ?? undefined, dedupe: r.dedupe ?? undefined,
    handled: r.handled ?? 0, error: r.error ?? null,
  };
}

/**
 * Glob match for event routing: `github.release.*`, `*`, `rss.item.new`.
 * Written by hand rather than imported so the routing rule is one readable
 * function an owner can reason about.
 */
export function matches(pattern: string, type: string): boolean {
  if (!pattern) return false;
  if (pattern === "*" || pattern === type) return true;
  const p = pattern.split(".");
  const t = type.split(".");
  if (p.length !== t.length) {
    // allow a trailing `**` to swallow the rest
    if (p[p.length - 1] === "**" && t.length >= p.length - 1) {
      return p.slice(0, -1).every((seg, i) => seg === "*" || seg === t[i]);
    }
    return false;
  }
  return p.every((seg, i) => seg === "*" || seg === t[i]);
}
