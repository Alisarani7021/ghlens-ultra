/**
 * History navigation: a back button that means «the screen before this one».
 *
 * Screens used to carry a fixed back target — mostly home — so one press
 * threw the user out of a five-level walk. The history fixes that: every
 * callback-rendered screen records its route, and every back button on every
 * screen is rewritten to one key, `nav:back`, which pops the history and
 * re-renders the previous screen — browser semantics, no per-screen wiring.
 *
 * A few deliberate rules keep the history honest:
 *   • only callback routes are recorded (commands open top-level screens the
 *     menu already reaches);
 *   • a screen rendered *by* a back press does not re-record itself — the
 *     past is not history;
 *   • consecutive repeats collapse (a refresh is not a navigation), and the
 *     stack is capped;
 *   • an action button re-rendering its own screen records normally, so back
 *     from a toggle re-runs it — back doubles as undo.
 */

export const NAV_BACK = "nav:back";
export const NAV_STACK_KEY = "nav:stack";
export const NAV_MAX = 15;

/** Back labels across the locales the bot speaks. */
const BACK_WORDS = "بازگشت|برگشت|back|назад|返回|رجوع|عودة";
const BACK_RE = new RegExp(`^(?:◀️?|↩️?)\\s*(?:${BACK_WORDS})\\s*$`, "iu");

export function isBackButton(text: string): boolean {
  const t = String(text ?? "").trim();
  return t === "◀️" || t === "◀" || BACK_RE.test(t);
}

/**
 * Rewrite every back button to the one history key. Pagination («◀️ قبلی»),
 * home («🏠 منوی اصلی») and section links («◀️ کانکتورها») are navigation of
 * their own and stay untouched. Returns the original markup when nothing
 * changed, so callers can skip the copy.
 */
export function navizeKeyboard(kb: any): any {
  if (!kb?.inline_keyboard?.length) return kb;
  let any = false;
  const rows = kb.inline_keyboard.map((row: any[]) =>
    (row ?? []).map((b: any) => {
      if (b?.callback_data && b.callback_data !== NAV_BACK && isBackButton(b.text)) {
        any = true;
        return { ...b, callback_data: NAV_BACK };
      }
      return b;
    }),
  );
  return any ? { ...kb, inline_keyboard: rows } : kb;
}

/** Record a route: repeats collapse, the back key never lands, depth caps. */
export function pushRoute(stack: string[], route: string): string[] {
  if (!route || route === NAV_BACK) return stack;
  const out = (stack ?? []).filter(Boolean).filter((r) => r !== NAV_BACK);
  if (out[out.length - 1] === route) return out;
  out.push(route);
  while (out.length > NAV_MAX) out.shift();
  return out;
}

/**
 * One step back: drop the current screen, name the one before it. An empty
 * history lands on home — the one back button that always works.
 */
export function backTarget(stack: string[]): { stack: string[]; target: string } {
  const out = (stack ?? []).filter(Boolean).filter((r) => r !== NAV_BACK);
  out.pop();
  return { stack: out, target: out[out.length - 1] ?? "m:home" };
}

/** The back label in every locale the bot speaks. */
export function backLabel(loc: string): string {
  return ({ fa: "◀️ بازگشت", en: "◀️ Back", ru: "◀️ Назад", zh: "◀️ 返回", ar: "◀️ عودة" } as Record<string, string>)[loc] ?? "◀️ Back";
}

/**
 * No screen may strand the reader. After the rewrite, a keyboard that still
 * has no nav:back button gains one as its own last row — the screenshot
 * complaint was a screen with buttons but no way back. Two exceptions, both
 * deliberate: the root menu (nothing sits above home — a back button there
 * re-renders the same screen), and replies without any keyboard (they expect
 * typed input, not taps).
 */
export function ensureBackButton(kb: any, isHome: boolean, loc: string): any {
  if (!kb?.inline_keyboard?.length || isHome) return kb;
  const has = kb.inline_keyboard.some((row: any[]) =>
    (row ?? []).some((b: any) => b?.callback_data === NAV_BACK));
  if (has) return kb;
  return { ...kb, inline_keyboard: [...kb.inline_keyboard, [{ text: backLabel(loc), callback_data: NAV_BACK }]] };
}
