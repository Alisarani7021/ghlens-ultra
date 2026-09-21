import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * UserSession Durable Object.
 *
 * Why a DO and not KV? Because the bot has *stateful* interactions:
 *   • multi-step wizards (compare two repos, deep-scout options, download builder)
 *   • per-user in-flight locks so double-taps don't run expensive jobs twice
 *   • a tiny in-memory hot cache (last 20 cards) with ~0ms reads
 *   • presence + activity counters for the admin dashboard
 *
 * One DO instance per Telegram user id.
 */
export interface SessionState {
  ctx: Record<string, unknown>;      // wizard state
  cardType: "auto" | "full" | "compact";
  lastCards: { full: string; text: string; at: number }[];
  inflight: string | null;
  counters: Record<string, number>;
}

export class UserSession extends DurableObject<Env> {
  private state!: SessionState;

  async ensure() {
    if (this.state) return this.state;
    this.state = (await this.ctx.storage.get<SessionState>("s")) ?? {
      ctx: {}, cardType: "auto", lastCards: [], inflight: null, counters: {},
    };
    return this.state;
  }

  private persist() {
    return this.ctx.storage.put("s", this.state);
  }

  /** Wizard/context API */
  async get(key: string) {
    const s = await this.ensure();
    return s.ctx[key];
  }
  async set(key: string, value: unknown) {
    const s = await this.ensure();
    s.ctx[key] = value;
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60_000); // auto-expire context
  }
  async clear(keys?: string[]) {
    const s = await this.ensure();
    if (keys) for (const k of keys) delete s.ctx[k];
    else s.ctx = {};
    await this.persist();
  }

  async cardType(t?: "auto" | "full" | "compact") {
    const s = await this.ensure();
    if (t) { s.cardType = t; await this.persist(); }
    return s.cardType;
  }

  /** Hot card cache — makes "back" navigation instantaneous. */
  async rememberCard(full: string, text: string) {
    const s = await this.ensure();
    s.lastCards.unshift({ full, text, at: Date.now() });
    s.lastCards = s.lastCards.slice(0, 20);
    await this.persist();
    return text;
  }
  async lastCard(full: string) {
    const s = await this.ensure();
    return s.lastCards.find((c) => c.full === full) ?? null;
  }

  /** Cheap mutex: returns false when another expensive job is running for this user. */
  async acquire(tag: string) {
    const s = await this.ensure();
    if (s.inflight && Date.now() - (s.counters[`lock:${s.inflight}`] ?? 0) < 60_000) return false;
    s.inflight = tag;
    s.counters[`lock:${tag}`] = Date.now();
    await this.persist();
    return true;
  }
  async release() {
    const s = await this.ensure();
    s.inflight = null;
    await this.persist();
  }

  async bump(counter: string, by = 1) {
    const s = await this.ensure();
    s.counters[counter] = (s.counters[counter] ?? 0) + by;
    await this.persist();
    return s.counters[counter];
  }

  async stats() {
    const s = await this.ensure();
    return { counters: s.counters, ctxKeys: Object.keys(s.ctx), cards: s.lastCards.length };
  }

  /** Alarm wipes stale wizard context (privacy + hygiene). */
  override async alarm() {
    const s = await this.ensure();
    s.ctx = {};
    s.inflight = null;
    s.lastCards = s.lastCards.filter((c) => Date.now() - c.at < 3600_000);
    await this.persist();
  }
}
