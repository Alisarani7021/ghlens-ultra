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
 * A screen the bot already renders as Telegram HTML → a rich document.
 *
 * The twelve scout tabs (and a few older screens) are written as escaped HTML
 * with bold headings and emoji-led lines. Passing that through the *markdown*
 * converter escapes every tag — literal `<b>` reaches the reader — so this
 * converter takes the other side of the contract: the input is already escaped
 * by construction, and the only job is to give the blocks document shape.
 *
 *   • a lone bold line (`📊 <b>repo</b> — title`) becomes the heading
 *   • `• `-led and emoji-led item lines become list items
 *   • a line that is nothing but <code> (a sparkline) becomes <pre>
 *   • <blockquote> becomes an <aside>
 *   • everything else stays a paragraph, joined with <br>
 *
 * Inline tags the rich parser shares with legacy HTML (b, i, u, s, code, a,
 * tg-spoiler) pass through untouched — the content was escaped where it was
 * written, and re-escaping here would print the tags as text.
 */
export function telegramHtmlToRich(html: string): string {
  const lines = String(html ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];
  let titleDone = false;
  let i = 0;

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; }
  };
  const flushItems = () => {
    if (items.length) { out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`); items = []; }
  };
  const flush = () => { flushPara(); flushItems(); };

  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (!line) { flush(); continue; }

    // a <pre> block the screen already fenced — kept whole, verbatim
    if (line.startsWith("<pre>")) {
      flush();
      const first = line.replace(/^<pre>/, "");
      const buf = [first];
      if (!/<\/pre>\s*$/.test(first)) {
        while (i < lines.length && !/<\/pre>\s*$/.test(lines[i])) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i++].replace(/<\/pre>\s*$/, ""));
      } else {
        buf[0] = first.replace(/<\/pre>\s*$/, "");
      }
      out.push(`<pre>${buf.join("\n").trim()}</pre>`);
      continue;
    }

    // a quote block, possibly spanning several lines (the wiring checklist
    // writes one) — the whole block becomes one aside
    if (line.startsWith("<blockquote>")) {
      flush();
      const first = line.replace(/^<blockquote>/, "");
      const buf = [first];
      if (!/<\/blockquote>\s*$/.test(first)) {
        while (i < lines.length && !/<\/blockquote>\s*$/.test(lines[i])) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i++].replace(/<\/blockquote>\s*$/, ""));
      } else {
        buf[0] = first.replace(/<\/blockquote>\s*$/, "");
      }
      const inner = buf.join("<br>").replace(/^<br>|<br>$/g, "");
      out.push(`<aside>${inner}</aside>`);
      continue;
    }

    // the screen header: `📊 <b>repo</b> — عنوان` (or a plain lone bold line)
    const head = /^[^<>]{0,8}?<b>(.+?)<\/b>(?:\s*[—–-]\s*(.*))?$/.exec(line);
    if (head && !titleDone && !para.length && !items.length) {
      out.push(`<h1>${head[1]}${head[2] ? ` — ${head[2]}` : ""}</h1>`);
      titleDone = true;
      continue;
    }

    // a sparkline: a line that is entirely <code>…</code>
    if (/^<code>[\s\S]*<\/code>$/.test(line)) { flush(); out.push(`<pre>${line.replace(/^<code>|<\/code>$/g, "")}</pre>`); continue; }

    // a list item: bullet-led or a bare bold label leading a section
    if (/^[•\-*]\s+/.test(line) || /^(?:🌱|⚠️|✅|❌|🚀|📦)\s+<b>/.test(line)) {
      flushPara();
      items.push(line.replace(/^[•\-*]\s+/, ""));
      continue;
    }

    // a bold label with content after it on the same line starts a paragraph
    flushItems();
    para.push(line);
  }
  flush();
  return out.join("\n");
}

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
  chatId: number | string,
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
    /* sendLong, not sendMessage: the plain twin of a long document has to be
       split, or the fallback itself dies on Telegram's 4096 limit and the
       message is lost — the one outcome this module exists to prevent. */
    await tg.sendLong(chatId, richToLegacy(html), { parse_mode: "HTML", ...(opts.extra ?? {}) } as any);
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
    /* An edit can fail because the message is too old or was deleted — for the
       reader that must not read as «the button did nothing»: the answer goes
       out as a fresh message instead. «not modified» is the one failure that
       means nothing needs doing. */
    const res = await tg.editMessageText(chatId as any, messageId, richToLegacy(html), { parse_mode: "HTML", ...(opts.extra ?? {}) } as any);
    if (res && (res as any).ok === false && !/not modified/i.test(String((res as any).description ?? ""))) {
      await tg.sendLong(chatId as any, richToLegacy(html), { parse_mode: "HTML", ...(opts.extra ?? {}) } as any);
    }
    return "legacy";
  }
}
