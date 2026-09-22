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
  /** How long an armed text-input mode stays valid without being used. */
  static readonly MODE_TTL_MS = 15 * 60_000;

  /** Keys that mean "the very next message belongs to this feature". */
  static readonly INPUT_MODES = [
    "keys:pending", "me:token", "repochat", "wf", "code", "review", "cmp",
    "adm:broadcast", "sec:scan", "sec:secrets", "u:ip", "u:asn",
    "dvu:cron", "dvu:regex", "dvu:cidr", "dvu:jwt", "dvu:b64", "dvu:hash",
    "dvu:time", "dvu:json", "dvu:semver", "dvu:color",
  ];

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
    /* Text-input modes get a stamp as well. Without it a flag armed in one
       section (e.g. «ورک‌فلو») ate every later message, so typing a normal
       question answered with a GitHub Actions YAML. */
    if (UserSession.INPUT_MODES.includes(key)) s.ctx[`__at:${key}`] = Date.now();
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60_000); // auto-expire context
  }
  async clear(keys?: string[]) {
    const s = await this.ensure();
    if (keys) for (const k of keys) { delete s.ctx[k]; delete s.ctx[`__at:${k}`]; }
    else s.ctx = {};
    await this.persist();
  }

  /**
   * Read a text-input mode and consume it.
   *
   * Returns the stored value only if it was armed within the last MODE_TTL_MS;
   * an old flag is dropped instead of hijacking the message the user is sending
   * right now. Consuming means the next message is normal again.
   */
  async mode(key: string) {
    const s = await this.ensure();
    if (!(key in s.ctx)) return undefined;
    const at = Number(s.ctx[`__at:${key}`] ?? 0);
    const fresh = !at || Date.now() - at <= UserSession.MODE_TTL_MS;
    const value = s.ctx[key];
    if (!fresh) {
      delete s.ctx[key];
      delete s.ctx[`__at:${key}`];
      await this.persist();
      return undefined;
    }
    return value;
  }

  /** Forget every armed input mode — called when the user moves to another section. */
  async clearModes() {
    const s = await this.ensure();
    let touched = false;
    for (const key of UserSession.INPUT_MODES) {
      if (key in s.ctx) { delete s.ctx[key]; delete s.ctx[`__at:${key}`]; touched = true; }
    }
    if (touched) await this.persist();
  }

  /** Which section the user is standing in («search», «assistant», … or none). */
  async section(sec?: string | null) {
    const s = await this.ensure();
    if (sec !== undefined) {
      if (sec === null) delete s.ctx.sec;
      else s.ctx.sec = sec;
      await this.persist();
      return sec;
    }
    return typeof s.ctx.sec === "string" ? s.ctx.sec : null;
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
