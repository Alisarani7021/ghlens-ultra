import type { H } from "./handler";

/**
 * SECTION / INPUT-MODE HELPERS
 *
 * One text-input mode at a time. The mode itself lives in the session under its
 * own key (the DO stamps it with `__at:` and `session.mode()` refuses stale
 * ones), so this file only keeps the *policy*:
 *
 *   • arming a mode drops every other armed mode
 *   • opening any section drops armed modes and remembers the section, so the
 *     next message goes to that section and nothing else
 *
 * The bug this exists to kill: «ورک‌فلو» was armed once and stayed armed, so a
 * plain question typed later answered with a GitHub Actions YAML.
 */

/** Arm exactly one text-input mode (and drop the others). */
export async function armMode(h: H, id: string): Promise<void> {
  if (!h.session) return;
  await h.session.clearModes();
  await h.session.set(id, true);
}

/** Arm a mode that carries a payload (e.g. the repo a chat is about). */
export async function armModeWith(h: H, id: string, value: unknown): Promise<void> {
  if (!h.session) return;
  await h.session.clearModes();
  await h.session.set(id, value);
}

/** Forget the armed mode(s). */
export async function leaveMode(h: H): Promise<void> {
  if (!h.session) return;
  await h.session.clearModes();
}

/** Which section the user is standing in («search», «assistant», …). */
export async function currentSection(h: H): Promise<string | null> {
  if (!h.session) return null;
  return h.session.section();
}

/** Enter a section: drop input modes, remember where the user is. */
export async function enterSection(h: H, sec: string | null): Promise<void> {
  if (!h.session) return;
  await h.session.clearModes();
  await h.session.section(sec ?? null);
}

/** Callback prefixes that mean "a section home is opening" → drop input modes. */
export const SECTION_HOME = new Set([
  "m:home", "m:start", "m:menu", "s:home", "a:home", "u:home", "t:menu", "b:menu",
  "pf:home", "keys:home", "c:home", "me:home", "h:main", "dvu:home", "sec:home", "d:home",
]);

/** Which free-text section a home callback belongs to (null = no owner). */
export function sectionOf(cb: string): string | null {
  // «s:» is the deep-scout namespace, «n:» is search — do not confuse them
  if (cb.startsWith("n:")) return "search";
  if (cb === "a:home" || cb === "a:new" || cb === "a:cont") return "assistant";
  return null;
}
