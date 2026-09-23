import type { Telegram } from "./api";
import type { SendMessageOpts } from "./types";

/**
 * RICH MESSAGES — Bot API 10.3 structured formatting.
 *
 * Plain HTML messages can do bold and links; rich messages can do headings,
 * tables, checklists, collapsible `<details>`, pull-quotes, footnotes and math.
 * The welcome screen is where a bot either looks designed or looks like a wall of
 * emoji-separated lines, so `/start` and `/help` are built as rich messages.
 *
 * Two rules shape this module:
 *
 *  1. **Never lose the message.** `sendRichMessage` is a new method; if the API,
 *     the account or a proxy in front of it does not know it, the call fails. A
 *     welcome screen that fails is worse than an undecorated one, so every rich
 *     send has a legacy fallback: the same content with the rich-only tags
 *     stripped, sent through the ordinary `sendMessage` path that has been in
 *     production since day one.
 *  2. **Build, don't concatenate.** The helpers keep the markup balanced, so a
 *     missing `</table>` is impossible to write by accident.
 */

/** What actually happened, so callers can be honest about the fallback. */
export type RichOutcome = "rich" | "legacy";

/**
 * Rich-only block tags and the plain equivalent to keep when rewriting a rich
 * message as a legacy one. Anything not listed as supported by plain HTML
 * messages is dropped; `<b>`, `<i>`, `<a>`, `<code>`, `<pre>`, `<blockquote>`
 * and `<u>` survive untouched (Telegram's legacy HTML parser knows them).
 */
const LEGACY_KEEP = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "blockquote", "tg-spoiler"]);

/** Tags whose *content* is worth keeping, even though the tag itself is rich-only. */
const UNWRAP = new Set(["table", "tr", "td", "th", "caption", "thead", "tbody", "details", "summary", "aside", "cite", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "footer", "mark", "sub", "sup", "tg-reference", "div", "section"]);

/**
 * Turn a rich message into the best plain-HTML message it can be.
 *
 * Tables become "cell — cell" lines (tab characters collapse badly in most
 * clients), headings become bold lines, `<details>` loses its shell but keeps
 * its content, and everything the legacy parser would reject is removed.
 */
export function richToLegacy(html: string): string {
  let out = html
    // structural whitespace first, so the joins below are predictable
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n──────────\n")
    .replace(/<(\/?)strong>/gi, "<$1b>")
    .replace(/<(\/?)em>/gi, "<$1i>")
    .replace(/<(\/?)ins>/gi, "<$1u>")
    .replace(/<(\/?)strike>/gi, "<$1s>")
    .replace(/<(\/?)del>/gi, "<$1s>")
    .replace(/<mark>/gi, "<b>").replace(/<\/mark>/gi, "</b>");

  // rows: one line per row, cells joined with a middledot
  out = out.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
    const cells = [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((c) => c[1].trim());
    return `\n${cells.join(" · ")}\n`;
  });

  // headings and pull-quotes: bold, on their own line
  out = out.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t: string) => `\n<b>${t.trim()}</b>\n`);
  out = out.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, t: string) => `\n<b>${t.trim()}</b>\n`);
  out = out.replace(/<aside[^>]*>([\s\S]*?)<\/aside>/gi, (_m, t: string) => `\n<blockquote>${t.trim()}</blockquote>\n`);
  out = out.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, (_m, t: string) => ` — <i>${t.trim()}</i>`);
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `• ${t.trim()}\n`);
  out = out.replace(/<caption[^>]*>([\s\S]*?)<\/caption>/gi, (_m, t: string) => `\n<b>${t.trim()}</b>\n`);

  // now strip every remaining tag, keeping the content of the ones we unwrap
  out = out.replace(/<\/?([a-z0-9-]+)([^>]*)>/gi, (whole, name: string) => {
    const n = name.toLowerCase();
    if (LEGACY_KEEP.has(n)) return whole;
    if (UNWRAP.has(n)) return "";
    return ""; // tg-collage, img, tg-map, tg-button … nothing to say in plain text
  });

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ── builders ────────────────────────────────────────────────────────────── */

export const h1 = (t: string) => `<h1>${t}</h1>`;
export const h2 = (t: string) => `<h2>${t}</h2>`;
export const h3 = (t: string) => `<h3>${t}</h3>`;
export const p = (t: string) => `<p>${t}</p>`;
export const hr = () => "<hr/>";
export const aside = (t: string, cite?: string) => `<aside>${t}${cite ? `<cite>${cite}</cite>` : ""}</aside>`;
export const footer = (t: string) => `<footer>${t}</footer>`;
export const details = (summary: string, body: string, open = false) =>
  `<details${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
export const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
export const ol = (items: string[]) => `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;

/**
 * A bordered, striped table with a caption — the shape that makes a feature list
 * scannable instead of a paragraph. Cells may only carry inline formatting
 * (Telegram's rule), so nothing here inserts block tags inside a cell.
 */
export function table(rows: string[][], opts: { caption?: string; header?: boolean; compact?: boolean } = {}): string {
  const { caption, header = true, compact = false } = opts;
  const attrs = ["bordered", "striped", compact ? "compact" : ""].filter(Boolean).join(" ");
  const body = rows
    .map((row, i) => {
      const tag = header && i === 0 ? "th" : "td";
      return `<tr>${row.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    })
    .join("");
  return `<table ${attrs}>${caption ? `<caption>${caption}</caption>` : ""}${body}</table>`;
}

/* ── sending ─────────────────────────────────────────────────────────────── */

export interface RichSendOpts {
  /** Additional Bot API fields (reply_markup, link previews, …). */
  extra?: SendMessageOpts;
  /** Right-to-left layout — set for Persian and Arabic. */
  rtl?: boolean;
}

/**
 * Send a rich message, and if that is not possible, send it as a normal one.
 *
 * Returns which path was taken so the caller can log it once instead of guessing:
 * a silent downgrade is exactly the kind of thing that makes a "we shipped rich
 * messages" claim untrue.
 */
export async function sendRich(
  tg: Telegram,
  chatId: number,
  html: string,
  opts: RichSendOpts = {},
): Promise<RichOutcome> {
  try {
    const res: any = await tg.sendRichMessage(chatId, html, {
      ...(opts.extra ?? {}),
      rich_message_extras: opts.rtl ? { is_rtl: true } : {},
    } as any);
    if (res && (res as any).ok === false) throw new Error(String((res as any).description ?? "rich send failed"));
    return "rich";
  } catch (e: any) {
    console.error("rich-send-fallback", String(e?.message ?? e).slice(0, 200));
    await tg.sendMessage(chatId, richToLegacy(html), { parse_mode: "HTML", ...(opts.extra ?? {}) } as any);
    return "legacy";
  }
}

/**
 * Same idea for edits: a rich edit when the message is already a rich one and
 * the API allows it, otherwise the legacy edit path.
 */
export async function editRich(
  tg: Telegram,
  chatId: number | string,
  messageId: number,
  html: string,
  opts: RichSendOpts = {},
): Promise<RichOutcome> {
  try {
    const res: any = await tg.editRichMessage(chatId, messageId, html, {
      ...(opts.extra ?? {}),
      rich_message_extras: opts.rtl ? { is_rtl: true } : {},
    } as any);
    if (res && (res as any).ok === false) throw new Error(String((res as any).description ?? "rich edit failed"));
    return "rich";
  } catch (e: any) {
    console.error("rich-edit-fallback", String(e?.message ?? e).slice(0, 200));
    await tg.editMessageText(chatId as any, messageId, richToLegacy(html), { parse_mode: "HTML", ...(opts.extra ?? {}) } as any);
    return "legacy";
  }
}
