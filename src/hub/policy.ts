/**
 *  POLICY ENGINE
 *
 *      AI proposes  →  policy permits  →  the system executes
 *
 *  The engine exists because "let the model decide" is not a control system.
 *  Every rule here is a *veto* — deterministic, inspectable, unit-testable —
 *  and the model never gets to argue with it.
 *
 *  Each rule returns a verdict, not a boolean:
 *      allow=true            → carry on
 *      allow=false           → drop it, with a reason the owner can read
 *      require="approval"    → allowed, but a human must press the button
 *      require="review"      → allowed, but flagged for review first
 *
 *  Rules are ordered and all of them run: a post blocked by dedupe *and*
 *  missing a source reports both, so the owner fixes it in one pass.
 */

export type Requirement = "approval" | "review" | null;

export interface PolicyVerdict {
  rule: string;
  allow: boolean;
  require: Requirement;
  /** short machine code, stable enough to count in analytics */
  code: string;
  /** Persian explanation shown to the owner */
  why: string;
}

export interface PolicySubject {
  /** where this content would be published, if anywhere */
  destination?: "channel" | "draft" | "none";
  /** the text that would go out */
  text?: string;
  /** where it came from; empty = we cannot say → must be reviewed */
  sourceRef?: string | null;
  /** 0..1 — the generator's own confidence, kept as a signal not a verdict */
  confidence?: number;
  /** true when a previous run already produced near-identical content */
  duplicate?: boolean;
  /** similarity score of that duplicate, for the message */
  duplicateScore?: number;
  /** upstream source changed since this was written */
  stale?: boolean;
  /** the model produced something that failed its own self-check */
  failedCheck?: boolean;
  /** remaining quota, when the caller knows it */
  quotaLeft?: number | null;
  /** has this exact event already been handled in this run? */
  alreadyHandled?: boolean;
}

export interface PolicyContext {
  /** does this owner have a channel wired up at all? */
  hasChannel: boolean;
  /** is the destination channel the owner's own draft channel? */
  isDraftChannel?: boolean;
  /** owner's rule: publish without asking, or never without asking */
  autonomy?: "manual" | "auto-with-review" | "auto";
}

export type Policy = (s: PolicySubject, c: PolicyContext) => PolicyVerdict;

const VA = (rule: string, code: string, allow: boolean, require: Requirement, why: string): PolicyVerdict =>
  ({ rule, code, allow, require, why });

/**
 * Nothing that leaves the building goes out without a source we can point at.
 *
 * Deliberately an approval gate rather than a block: an owner is allowed to
 * publish their own writing — that is a legitimate use of the button — but the
 * platform will never do it *for* them when it cannot say where the text came
 * from. Blocking outright would make hand-written posts impossible; allowing
 * it unattended would make unattributed text possible. This is the seam.
 */
export const sourceRequired: Policy = (s) =>
  s.destination === "channel" && !s.sourceRef
    ? VA("source-required", "no-source", true, "approval", "منبع مشخصی ثبت نشده — فقط با تأیید دستی تو منتشر می‌شود")
    : VA("source-required", "ok", true, null, "");

/** Near-duplicates are blocked outright, not merely flagged. */
export const noDuplicates: Policy = (s) =>
  s.duplicate
    ? VA("no-duplicates", "duplicate", false, null,
        `محتوا مشابه چیزی است که قبلاً ساخته شده (شباهت ${((s.duplicateScore ?? 0) * 100).toFixed(0)}٪)`)
    : VA("no-duplicates", "ok", true, null, "");

/** A failed self-check means the model disagreed with itself; a human breaks the tie. */
export const checkGate: Policy = (s) =>
  s.failedCheck
    ? VA("check-gate", "failed-check", false, "review", "ارزیابی خودکار این خروجی را تأیید نکرد — نیاز به بازبینی انسانی")
    : VA("check-gate", "ok", true, null, "");

/** Confidence is a signal, never a verdict — low confidence downgrades, not blocks. */
export const confidenceFloor: Policy = (s) => {
  const c = s.confidence;
  if (typeof c !== "number") return VA("confidence-floor", "ok", true, null, "");
  if (c < 0.45) return VA("confidence-floor", "low-confidence", true, "review", `اطمینان پایین (${(c * 100).toFixed(0)}٪) — قبل از انتشار مرور شود`);
  if (c < 0.7) return VA("confidence-floor", "medium-confidence", true, "approval", `اطمینان متوسط (${(c * 100).toFixed(0)}٪) — تأیید لازم است`);
  return VA("confidence-floor", "ok", true, null, "");
};

/**
 * Everything that leaves the platform to an external audience is human-gated
 * by default. The owner can relax this, but the default is the safe one.
 */
export const externalPublish: Policy = (s, c) => {
  if (s.destination !== "channel") return VA("external-publish", "ok", true, null, "");
  if (c.autonomy === "auto") return VA("external-publish", "auto-publish", true, null, "");
  if (c.autonomy === "auto-with-review") return VA("external-publish", "flagged", true, "review", "انتشار خودکار تنظیم شده ولی علامت‌گذاری شد");
  return VA("external-publish", "approval-required", true, "approval", "انتشار در کانال نیاز به تأیید تو دارد");
};

/** Publishing to a channel that isn't wired up is a config error, not a content one. */
export const channelWired: Policy = (s, c) =>
  s.destination === "channel" && !c.hasChannel
    ? VA("channel-wired", "no-channel", false, null, "کانالی برای انتشار تنظیم نشده — از «کانکتورها» کانال را وصل کن")
    : VA("channel-wired", "ok", true, null, "");

/** Stale content derived from a changed source must be rebuilt, not published. */
export const freshness: Policy = (s) =>
  s.stale
    ? VA("freshness", "stale", false, "review", "منبع این محتوا تغییر کرده — نسخهٔ فعلی کهنه است و بازسازی می‌خواهد")
    : VA("freshness", "ok", true, null, "");

/** Spend guard: when the shared AI quota is nearly gone, hold non-essential work. */
export const quotaGuard: Policy = (s) =>
  typeof s.quotaLeft === "number" && s.quotaLeft <= 0
    ? VA("quota-guard", "quota-exhausted", false, "review", "سهمیهٔ هوش مصنوعی تمام شده — با دادهٔ خام ساخته می‌شود")
    : VA("quota-guard", "ok", true, null, "");

/** A guard against the engine re-publishing after a retry. */
export const singleDelivery: Policy = (s) =>
  s.alreadyHandled
    ? VA("single-delivery", "already-handled", false, null, "این رویداد قبلاً در همین اجرا پردازش شده")
    : VA("single-delivery", "ok", true, null, "");

/** Order = reporting order. All rules always run. */
export const RULES: Policy[] = [
  singleDelivery,
  channelWired,
  sourceRequired,
  freshness,
  noDuplicates,
  checkGate,
  confidenceFloor,
  externalPublish,
  quotaGuard,
];

export interface PolicyDecision {
  allow: boolean;
  require: Requirement;
  verdicts: PolicyVerdict[];
  /** the verdicts that actually mattered, newest rule last */
  active: PolicyVerdict[];
  summary: string;
}

/**
 * Evaluate every rule and fold them into one decision.
 *
 * The fold is deliberately conservative: a single `allow:false` blocks,
 * and the strongest surviving requirement wins (approval > review > none).
 */
export function evaluate(s: PolicySubject, c: PolicyContext): PolicyDecision {
  const verdicts = RULES.map((r) => r(s, c));
  const blocking = verdicts.filter((v) => !v.allow);
  const active = verdicts.filter((v) => !v.allow || v.require);
  let require: Requirement = null;
  if (active.some((v) => v.require === "approval")) require = "approval";
  else if (active.some((v) => v.require === "review")) require = "review";
  const allow = blocking.length === 0;
  const summary = !allow
    ? blocking.map((v) => v.why).join(" · ")
    : require === "approval"
      ? active.filter((v) => v.require === "approval").map((v) => v.why).join(" · ")
      : require === "review"
        ? active.filter((v) => v.require === "review").map((v) => v.why).join(" · ")
        : "همهٔ قواعد عبور کردند";
  return { allow, require, verdicts, active, summary };
}
