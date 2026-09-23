import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { Telegram } from "../tg/api";
import { type HubEvent, storeEvent, newTrace, hubId, digest } from "./event";
import { dispatchEvent, type RunResult } from "./engine";

/**
 *  THE UNIVERSAL BUS
 *
 *      anything that happens  →  normalise  →  store  →  fan out to workflows
 *
 *  Publishing is the only way an event enters the system, and it has exactly
 *  three jobs: make the event durable, make a redelivery harmless, and hand it
 *  to whoever asked for it. Everything else — translation, posting, approval —
 *  is a workflow's business, which is why the bus has no feature knowledge in
 *  it at all.
 *
 *  Idempotency is enforced by the database (a unique index on `dedupe`), not by
 *  a check-then-insert race, so two webhooks arriving in the same millisecond
 *  still produce exactly one run.
 */
export interface PublishDeps {
  env: Env;
  ai: AiBrain;
  tg?: Telegram;
  autonomy?: "manual" | "auto-with-review" | "auto";
}

export interface PublishResult {
  accepted: boolean;
  duplicate: boolean;
  event_id: string;
  trace: string;
  runs: RunResult[];
}

export async function publish(deps: PublishDeps, input: Omit<HubEvent, "id" | "ts" | "trace"> & { trace?: string }): Promise<PublishResult> {
  const trace = input.trace ?? newTrace();
  const ev: HubEvent = { ...input, id: hubId("evt"), ts: Date.now(), trace };

  const stored = await storeEvent(deps.env, ev);
  if (!stored) {
    return { accepted: false, duplicate: true, event_id: ev.id, trace, runs: [] };
  }

  const tg = deps.tg ?? new Telegram(deps.env);
  const runs = await dispatchEvent({
    env: deps.env, ai: deps.ai, tg, owner_id: ev.owner_id ?? 0,
    trace, event: stored, autonomy: deps.autonomy,
  }).catch((e: any) => {
    console.error("hub-dispatch", String(e?.message ?? e));
    return [] as RunResult[];
  });

  return { accepted: true, duplicate: false, event_id: stored.id, trace, runs };
}

/** Convenience wrappers so callers never build a raw envelope by hand. */
export const publishRaw = (
  deps: PublishDeps,
  type: string,
  source: string,
  payload: Record<string, any>,
  owner_id?: number,
) => publish(deps, { type, source, payload, owner_id });

/**
 * A stable identity for anything that did not bring one.
 *
 * Used for polled connectors: an RSS item without a GUID, or an HTTP endpoint
 * that reports a bare number, still needs a name that will be identical
 * tomorrow. Hashing the meaningful fields (and *not* the fetch time) is what
 * makes a second poll a no-op instead of a second post.
 */
export async function makeIdentity(...parts: Array<string | number | undefined | null>): Promise<string> {
  return (await digest(parts.filter((p) => p != null && p !== "").join("|"))).slice(0, 24);
}
