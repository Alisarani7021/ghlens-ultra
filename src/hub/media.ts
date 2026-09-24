import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import type { H } from "../core/handler";
import { tgEscape } from "../tg/types";

/**
 *  MEDIA FACTORY
 *
 *      a post → an image prompt → a cover
 *
 *  ── Why there is no audio here ─────────────────────────────────────────────
 *  The obvious shape of this layer is "post → image + voice + video". Two of
 *  those three are not being built: the owner removed every audio surface from
 *  this bot («تموم قسمت های صوتی رو از تو ربات بردار»), and a voice-over is
 *  that surface wearing a different hat. Text and images only.
 *
 *  ── Why the cover is rendered, not generated ───────────────────────────────
 *  An AI image model produces a different picture every time, cannot render
 *  Persian text legibly, and costs neurons on every post. A rendered SVG cover
 *  is the opposite on all three counts: identical for identical input,
 *  pixel-crisp in any script, and free. The AI is used for the one thing it is
 *  genuinely better at — deciding *what the picture should say*.
 *
 *  The result is a deterministic PNG-free SVG that Telegram happily renders and
 *  that stays sharp at any size, which is what a channel cover actually needs.
 */

export interface CoverSpec {
  title: string;
  subtitle?: string;
  /** small chip in the corner — version, tag, date */
  badge?: string;
  /** the channel handle printed at the bottom */
  handle?: string;
  /** accent colour; derived from the title when omitted */
  accent?: string;
  theme?: "dark" | "light";
  width?: number;
  height?: number;
}

/** Stable hash → a hue, so the same repo always gets the same colour. */
export function hueFrom(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

const PALETTE = ["#f97316", "#22d3ee", "#a78bfa", "#34d399", "#f472b6", "#facc15", "#60a5fa", "#fb7185"];

export function accentFor(text: string, theme: "dark" | "light" = "dark"): string {
  if (theme === "light") return "#1f2937";
  return PALETTE[hueFrom(text) % PALETTE.length];
}

/**
 * SVG needs its text escaped or a title containing `&` or `<` breaks the
 * document outright — and release names contain those constantly (`A & B`,
 * `x < y`).
 */
export function xmlEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Wrap a line of text to a character budget.
 *
 * SVG has no text wrapping, so it has to happen here — and it has to be
 * *character*-based rather than width-based because Persian and Latin glyphs
 * differ in width and we cannot measure without a font engine.
 */
export function wrapText(text: string, perLine: number, maxLines = 3): string[] {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current.length) { current = w; continue; }
    if ((current + " " + w).length <= perLine) current += " " + w;
    else { lines.push(current); current = w; if (lines.length === maxLines) break; }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Truncate the last line rather than dropping words silently.
  if (lines.length === maxLines) {
    const joined = lines.join(" ");
    if (joined.length < String(text).trim().length) {
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.length > perLine - 1 ? last.slice(0, perLine - 1) + "…" : last + " …";
    }
  }
  return lines.length ? lines : [""];
}

/**
 * Render the cover.
 *
 * Layout is a fixed 1200×630 (the OG-image ratio every platform expects), a
 * diagonal accent glow, the title in up to three lines, an optional badge chip
 * and a footer handle. Everything is absolute — no layout engine, no fonts to
 * fetch — so the output is deterministic and dependency-free.
 */
export function renderCover(spec: CoverSpec): string {
  const W = spec.width ?? 1200;
  const H = spec.height ?? 630;
  const theme = spec.theme ?? "dark";
  /* Persian and Arabic are read right to left, and an SVG <text> is laid out by
     the renderer — without this the title of every Persian cover sits on the
     wrong side, which is exactly the kind of half-finished detail that shows up
     the moment it is published. */
  const rtl = /[\u0600-\u06FF]/.test(spec.title);
  const anchor = rtl ? "end" : "start";
  const edge = rtl ? W - 72 : 72;
  const dir = rtl ? ` direction="rtl"` : "";
  const accent = spec.accent ?? accentFor(spec.title, theme);
  const bg0 = theme === "dark" ? "#0b1120" : "#f8fafc";
  const bg1 = theme === "dark" ? "#111c33" : "#e2e8f0";
  const fg = theme === "dark" ? "#f8fafc" : "#0f172a";
  const muted = theme === "dark" ? "#94a3b8" : "#475569";

  const titleLines = wrapText(spec.title, 26, 3);
  const titleSize = titleLines.length >= 3 ? 66 : titleLines.length === 2 ? 78 : 92;
  const lineH = Math.round(titleSize * 1.28);
  const blockH = titleLines.length * lineH;
  const startY = Math.round((H - blockH) / 2) + Math.round(titleSize * 0.35) - (spec.subtitle ? 24 : 0);

  const esc = xmlEscape;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Vazirmatn, Noto Sans Arabic, Tahoma, DejaVu Sans, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg0}"/>
      <stop offset="100%" stop-color="${bg1}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${rtl ? "82%" : "18%"}" cy="12%" r="72%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.42"/>
      <stop offset="60%" stop-color="${accent}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.15"/>
    </linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${theme === "dark" ? "#ffffff" : "#0f172a"}" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="14" height="${H}" fill="${accent}"/>
  <!-- a hairline frame: it makes the cover read as a designed card, not a slide -->
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${theme === "dark" ? "#ffffff" : "#0f172a"}" stroke-opacity="0.08"/>

  ${spec.badge ? `<g transform="translate(${rtl ? W - 72 : 72},72)${rtl ? " translate(-100%,0)" : ""}">
    <rect rx="14" ry="14" width="${Math.max(120, spec.badge.length * 19 + 48)}" height="56" fill="${accent}" fill-opacity="0.16" stroke="${accent}" stroke-opacity="0.5"/>
    <text x="${rtl ? Math.max(120, spec.badge.length * 19 + 48) - 24 : 24}" y="37" text-anchor="${anchor}" font-size="27" fill="${accent}" font-weight="700"${dir}>${esc(spec.badge)}</text>
  </g>` : ""}

  <g>
    ${titleLines.map((line, i) => `<text x="${edge}" y="${startY + i * lineH}" text-anchor="${anchor}" font-size="${titleSize}" font-weight="800" fill="${fg}"${dir}>${esc(line)}</text>`).join("\n    ")}
  </g>

  <!-- the accent rule separates title from subtitle and gives the eye a place
       to rest between them -->
  <rect x="${rtl ? W - 72 - 96 : 72}" y="${Math.round((H - blockH) / 2) - 46}" width="96" height="6" rx="3" fill="url(#rule)"/>

  ${spec.subtitle ? `<text x="${edge}" y="${startY + blockH + 8}" text-anchor="${anchor}" font-size="34" fill="${muted}"${dir}>${esc(wrapText(spec.subtitle, 54, 1)[0])}</text>` : ""}

  ${spec.handle ? `<g transform="translate(${rtl ? W - 72 : 72},${H - 68})">${rtl ? '<g transform="translate(-100,0) scale(-1,1)">' : ""}
    <circle cx="14" cy="0" r="10" fill="${accent}"/>
    <text x="40" y="10" font-size="28" fill="${muted}" font-weight="600">${esc(spec.handle)}</text>
  ${rtl ? "</g>" : ""}</g>` : ""}

  <g opacity="0.5">
    ${[0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${W - 60 - i * 34}" cy="${H - 58}" r="${4 + i}" fill="${accent}" fill-opacity="${0.55 - i * 0.08}"/>`).join("\n    ")}
  </g>
</svg>`;
}

// ── the AI half ────────────────────────────────────────────────────────────

export interface ImagePrompt {
  /** "ai" when a model wrote it, "rule" when the fallback did */
  origin?: "ai" | "rule";
  prompt: string;
  style: string;
  negative: string;
  aspect: string;
  alt: string;
}

/**
 * Ask the model for the *idea* of the image, then render it ourselves.
 *
 * The prompt is written for a human illustrator or an external image model, so
 * it is useful even when we never generate the picture: an owner can paste it
 * into any tool. `alt` is in the post's own language, because that is what a
 * screen reader or a channel reader scrolling past actually needs.
 */
export async function imagePromptFor(ai: AiBrain, post: string, lang = "fa"): Promise<ImagePrompt | null> {
  /* Model first, then a second model, then a rule.
     The owner's instruction was "if a model cannot, switch to the next" — and the
     kit must never arrive half-built, because it is meant to be published. So:
     fast tier → smart tier (a different model family, so a provider-side failure
     of one does not repeat) → a deterministic art direction built from the post
     itself. The last one is not as clever, and it is honest about being a
     fallback. */
  for (const tier of ["fast", "smart"] as const) {
    const out = await imagePromptForTier(ai, post, lang, tier);
    if (out) return out;
  }
  return rulePrompt(post, lang);
}

/** One attempt at a given tier; null when that model produced nothing usable. */
async function imagePromptForTier(ai: AiBrain, post: string, lang: string, tier: "fast" | "smart"): Promise<ImagePrompt | null> {
  const raw = await ai.chat(
    `You art-direct a cover image for a technology channel post.\n\n` +
      `POST:\n"""${post.slice(0, 1200)}"""\n\n` +
      `Return STRICT JSON only:\n` +
      `{"prompt":"a precise visual description for an image generator, 25-45 words, no text in the image",` +
      `"style":"one of: editorial-3d, flat-vector, isometric, neon-cyber, minimal-geometric, technical-diagram",` +
      `"negative":"what to avoid, 5-10 words","aspect":"16:9 | 1:1 | 9:16",` +
      `"alt":"one short sentence in ${lang === "fa" ? "Persian" : lang} describing the image for a screen reader"}\n\n` +
      `The image must make sense next to the post and must contain NO lettering — covers with text are rendered separately.`,
    { tier, max_tokens: 400, temperature: 0.6, json: true, feature: "hub:imgprompt", deadlineMs: 12_000 },
  ).catch(() => "");
  const j = safeJson<ImagePrompt>(raw);
  if (!j?.prompt) return null;
  return { ...j, origin: "ai" };
}

/**
 * The fallback art direction.
 *
 * Built from the post itself: its leading nouns, its language and a fixed
 * palette per theme. It is deliberately generic — the alternative is an empty
 * field in a kit the owner is about to publish.
 */
export function rulePrompt(post: string, lang = "fa"): ImagePrompt {
  const plain = stripHtml(post).replace(/\s+/g, " ").trim();
  const words = plain.split(" ").filter((w) => w.length > 3).slice(0, 6).join(", ");
  const fa = lang === "fa";
  return {
    origin: "rule",
    prompt: fa
      ? `تصویر مفهومي براي موضوع «${plain.slice(0, 80)}» — عناصر اصلي: ${words || "نرم‌افزار و داده"}؛ ترکیب تیره با نور سبز-فیروزه‌ای، بدون هیچ متني در تصویر`
      : `A conceptual cover for "${plain.slice(0, 80)}" — key elements: ${words || "software and data"}; dark composition with teal-green light, no lettering in the image`,
    style: "neon-cyber",
    negative: fa ? "متن، لوگو، صورت انسان، کلیشهٔ سهام" : "text, logos, faces, stock-photo clichés",
    aspect: "16:9",
    alt: fa ? `تصویر مفهومي دربارهٔ ${plain.slice(0, 60)}` : `Conceptual illustration about ${plain.slice(0, 60)}`,
  };
}

function safeJson<T>(raw: string): T | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/**
 * Build the full media kit for a post and hand back the pieces a caller can
 * use without knowing anything about SVG or prompts.
 */
export async function mediaKit(
  env: Env,
  ai: AiBrain,
  post: { title: string; body: string; badge?: string; handle?: string; lang?: string },
  opts: { withPrompt?: boolean } = {},
): Promise<{ cover: string; svg: string; prompt: ImagePrompt | null }> {
  const svg = renderCover({
    title: post.title,
    subtitle: stripHtml(post.body).split("\n")[0]?.slice(0, 90),
    badge: post.badge,
    handle: post.handle,
    theme: "dark",
  });
  let prompt: ImagePrompt | null = null;
  if (opts.withPrompt) prompt = await imagePromptFor(ai, `${post.title}\n${post.body}`, post.lang ?? "fa").catch(() => null);
  return { cover: svg, svg, prompt };
}

/** Post text → the first readable line, for use as a cover subtitle. */
export function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Media kit rendered for the chat, so an owner can preview before publishing. */
export function mediaKitCaption(spec: CoverSpec, prompt: ImagePrompt | null, fa = true): string {
  const lines = [
    fa ? `🖼 <b>کیت رسانه</b>` : `🖼 <b>Media kit</b>`,
    ``,
    `<blockquote>${fa ? "کاور زیر به‌صورت برداری (SVG) ساخته شده: برداری، همیشه شارپ، و برای عنوان تکراری همیشه یکسان." : "Rendered as SVG: vector, always sharp, deterministic."}</blockquote>`,
    ``,
    `• ${fa ? "عنوان" : "title"}: <b>${tgEscape(spec.title)}</b>`,
    spec.badge ? `• ${fa ? "نشان" : "badge"}: <code>${tgEscape(spec.badge)}</code>` : "",
    prompt ? `\n🎨 <b>${fa ? "پرامپت تصویر" : "image prompt"}</b>` +
      (prompt.origin === "rule"
        ? `\n<i>${fa ? "مدل‌ها جواب ندادند، این پرامپت از خودِ متن ساخته شد — همچنان قابل استفاده است." : "no model answered; built from the post itself."}</i>`
        : "") +
      `\n<blockquote>${tgEscape(prompt.prompt)}\n\n<i>${tgEscape(prompt.style)} · ${tgEscape(prompt.aspect)}</i></blockquote>` : "",
    prompt?.alt ? `\n♿️ <b>alt</b>: ${tgEscape(prompt.alt)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}
