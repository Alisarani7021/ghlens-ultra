/**
 * Rich documents.
 *
 * Telegram's rich messages (Bot API 10.3) render a real document: `h1`–`h3`,
 * paragraphs, lists, tables, asides, `<pre>` with a copy button. Model output,
 * READMEs and generated analyses are markdown — so the missing piece was never
 * the API, it was a converter. `markdownToTelegramHtml` (written for changelogs)
 * flattens everything into bold-and-newlines, which is why a translated README
 * arrived as a grey wall of text.
 *
 * This module is that converter, and it is deliberately small and boring:
 *
 *   • text is escaped *before* any tag is inserted, so a README containing `<b>`
 *     cannot smuggle markup into the message,
 *   • a block that cannot be closed is never emitted (no half-open `<ul>`),
 *   • output is cut on a block boundary, never mid-tag,
 *   • anything the renderer does not recognise still arrives as a paragraph —
 *     losing a heading style is fine, losing the sentence is not.
 */

import { tgEscape } from "../tg/types";

export interface RichDocOptions {
  /** total characters to keep (rich messages allow 32 768) */
  maxChars?: number;
  /** shift every heading down (2 renders `#` as `h2`) */
  headingBase?: 1 | 2;
}

const INLINE_CODE = /\u0000(\d+)\u0000/g;

/** Inline markdown → rich-safe inline HTML. Escapes first, always. */
export function inlineMd(text: string): string {
  let out = tgEscape(text);
  // code spans are protected before anything else can rewrite their insides
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, "$1")              // images: keep the caption
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return out.replace(INLINE_CODE, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** One markdown table row → cells. */
const cells = (line: string): string[] =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

const isSeparator = (line: string) => /^\s*\|?[\s:|-]{3,}\|?\s*$/.test(line) && line.includes("-");

/**
 * Markdown → rich HTML. Handles the constructs that actually appear in READMEs
 * and model output; everything else degrades to a paragraph.
 */
export function markdownToRichHtml(md: string, opts: RichDocOptions = {}): string {
  const maxChars = opts.maxChars ?? 20000;
  const base = opts.headingBase ?? 1;
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  const heading = (depth: number, text: string) => {
    const level = Math.min(3, Math.max(1, depth + (base - 1)));
    return `<h${level}>${inlineMd(text)}</h${level}>`;
  };

  let i = 0;
  // a YAML front matter block is metadata, not prose
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0 && end < 30) i = end + 1;
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // fenced code — kept verbatim, closing fence respected
    const fence = /^(```+|~~~+)\s*([\w+-]*)\s*$/.exec(trimmed);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^(```+|~~~+)\s*$/.test(lines[i].trim())) body.push(lines[i++] ?? "");
      i++;
      blocks.push(`<pre>${tgEscape(body.join("\n"))}</pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) { blocks.push(heading(h[1].length, h[2])); i++; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push("<hr/>"); i++; continue; }

    // table: a header row followed by a separator row
    if (trimmed.startsWith("|") && isSeparator(lines[i + 1] ?? "")) {
      const header = cells(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      const width = header.length;
      const padded = rows.map((r) => Array.from({ length: width }, (_v, k) => r[k] ?? ""));
      blocks.push(
        `<table bordered striped><tr>${header.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr>` +
        padded.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("") +
        `</table>`,
      );
      continue;
    }

    // lists (one level of nesting handled by flattening the indent)
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      const ordered = !!numbered;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        const b2 = /^([-*+])\s+(.*)$/.exec(l);
        const n2 = /^(\d+)[.)]\s+(.*)$/.exec(l);
        if (ordered ? n2 : b2) { items.push(inlineMd((ordered ? n2![2] : b2![2]))); i++; continue; }
        // a wrapped continuation line belongs to the item above
        if (items.length && l && !/^(#{1,6}\s|>\s|\||```)/.test(l) && !/^([-*+]|\d+[.)])\s/.test(l)) {
          items[items.length - 1] += " " + inlineMd(l); i++; continue;
        }
        break;
      }
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${t}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quote.push(inlineMd(lines[i++].trim().replace(/^>\s?/, "")));
      blocks.push(`<aside>${quote.join("<br>")}</aside>`);
      continue;
    }

    // paragraph: consecutive plain lines, soft breaks kept as <br>
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trim();
      if (!t || /^(#{1,6}\s|>\s?|\||```|~~~)/.test(t) || /^([-*+]|\d+[.)])\s/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) break;
      para.push(inlineMd(t));
      i++;
    }
    if (para.length) blocks.push(`<p>${para.join("<br>")}</p>`);
  }

  // cut on a block boundary: a truncated tag renders worse than a shorter document
  let out = "";
  for (const b of blocks) {
    if (out.length + b.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + b;
  }
  return out || `<p>${inlineMd(String(md ?? "").slice(0, maxChars))}</p>`;
}

/** A document with a heading, a small metadata line and a footer. */
export function richDoc(input: {
  title?: string;
  meta?: string;
  body: string;
  footer?: string;
  headingBase?: 1 | 2;
  maxChars?: number;
}): string {
  return [
    input.title ? `<h1>${input.title}</h1>` : "",
    input.meta ? `<p>${input.meta}</p>` : "",
    input.body,
    input.footer ? `<footer>${input.footer}</footer>` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Split markdown into pages **on block boundaries**.
 *
 * The old pager cut the translated string every 3 800 characters, which sliced
 * tables and lists in half; a page that starts mid-row renders as garbage. This
 * walks the document the same way `markdownToRichHtml` does and starts a new page
 * whenever the next block would overflow — so every page is a whole number of
 * blocks, and the last page is never empty.
 */
/** The page size the README reader uses — one constant, so pager and page one agree. */
export const README_PAGE_CHARS = 11500;

export function paginateMd(md: string, perPage = README_PAGE_CHARS, maxPages = 12): string[] {
  const text = String(md ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```+|~~~+)/.test(line)) inFence = !inFence;
    const isBreak = !inFence && !line.trim();
    if (isBreak) {
      if (buf.length) { blocks.push(buf.join("\n")); buf = []; }
      continue;
    }
    buf.push(line);
    if (buf.length > 400) { blocks.push(buf.join("\n")); buf = []; }   // a runaway paragraph
  }
  if (buf.length) blocks.push(buf.join("\n"));

  const pages: string[] = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > perPage) { pages.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + b;
    if (pages.length >= maxPages - 1) break;
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : [text.slice(0, perPage)];
}
