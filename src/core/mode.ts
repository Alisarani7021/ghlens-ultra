/**
 * Which section is the user standing in?
 *
 * Every stateful input used to be its own session flag ("wf", "code",
 * "repochat", …) with a 30-minute life and no owner. A user who opened the
 * workflow builder once, then walked to «چت با مخزن» and typed a question,
 * had the question answered by the *workflow* builder — the stale flag was
 * still sitting there and free text fell through to it.
 *
 * So there is exactly one place that says where the user is: this mode.
 *   • entering a section sets it (setMode)
 *   • a typed message goes to the mode's own handler, and only that one
 *   • pressing a button that does not belong to the mode leaves the section
 *     (modeKeeps) — so nothing can hijack the next message
 *   • with no mode, free text means "search for projects", always
 *   • the clock resets on every message, so a section stays usable while the
 *     user is actually using it and expires when they walk away
 */
export type InputMode = { kind: string; at: number; data?: any };

/** 25 minutes of *inactivity* ends a section; any message pushes the clock. */
export const MODE_TTL_MS = 25 * 60_000;

type Sess = {
  set(key: string, value: unknown): Promise<unknown>;
  get(key: string): Promise<unknown>;
  clear(keys?: string[]): Promise<unknown>;
};

export async function setMode(s: Sess, kind: string, data?: any): Promise<void> {
  await s.set("mode", { kind, at: Date.now(), data } satisfies InputMode);
}

export async function readMode(s: Sess): Promise<InputMode | null> {
  const raw: any = await s.get("mode").catch(() => null);
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") return null;
  if (Date.now() - Number(raw.at ?? 0) > MODE_TTL_MS) {
    await s.clear(["mode"]).catch(() => null);
    return null;
  }
  return raw as InputMode;
}

export async function touchMode(s: Sess, m: InputMode): Promise<void> {
  await s.set("mode", { ...m, at: Date.now() }).catch(() => null);
}

export async function clearMode(s: Sess): Promise<void> {
  await s.clear(["mode"]).catch(() => null);
}

/**
 * Does this button belong to the mode the user is in?
 * Only the mode's own buttons keep it alive; everything else means "I left".
 */
export function modeKeeps(kind: string, cb: string): boolean {
  if (!cb) return false;
  if (kind === "keys") return cb.startsWith("keys:");
  // the deep-link gate lives until answered or walked away from
  if (kind === "dl:go") return cb === "dl:yes" || cb === "dl:no";
  // the studio's channel choice survives its own buttons
  if (kind === "hub_postch") return cb.startsWith("hub:postch") || cb === "hub:postself";
  if (kind === "wf") return cb.startsWith("wf:") || cb.startsWith("a:wf");
  const ns = cb.split(":")[0];
  if (kind.startsWith("dvu:")) return ns === "dvu";
  if (kind === "u:ip" || kind === "u:asn") return ns === "u";
  // repo chat, PR review, code explainer, security: any button is a new journey
  return false;
}

/** Handlers that consume a single typed message, keyed by mode. */
export const MODE_LABELS: Record<string, string> = {
  repochat: "چت با مخزن",
  wf: "ساخت ورک‌فلو",
  code: "توضیح کد",
  review: "بازبینی PR",
  appgen: "ساخت نرم‌افزار کامل",
  hub_postch: "مقصد پست: کانال یا فوروارد خودم",
  arch: "تحلیل معماری پروژه",
  "sec:scan": "اسکن امنیتی",
  "sec:secrets": "جست‌وجوی کلید لو‌رفته",
  "u:ip": "ابزار IP/DNS",
  "u:asn": "ابزار ASN",
  "hos:mission": "مأموریت هاب",
  "hos:conn:add": "افزودن کانکتور",
  "hos:search": "جست‌وجوی معنایی",
  "hos:media": "کارخانهٔ رسانه",
  "hos:file": "کالبدشکافی فایل",
  "hos:edit": "ویرایش متن پیش‌نویس",
  "hos:deploy": "ساخت نمونهٔ شخصی",
};
