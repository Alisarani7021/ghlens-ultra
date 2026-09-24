import { tgEscape } from "../tg/types";

/**
 *  THE EDITOR
 *
 *  Turns a normalised event into a channel-ready post, and is the reason two
 *  specific bugs will never appear in this project again:
 *
 *   1. **Raw tags leaking.** GitHub release bodies are markdown that often
 *      contains literal HTML — `<details><summary>…</summary></details>` is in
 *      thousands of changelogs — and Telegram renders the inside of a `<b>`
 *      tag but shows the *rest* as literal text. So the body is put through a
 *      sanitizer that maps the tags Telegram knows, unwraps the ones it does
 *      not, and escapes everything else. Whatever comes out is HTML Telegram
 *      can render, or it is plain text — never a half-parsed mess.
 *
 *   2. **Twelve identical download buttons.** Release assets are grouped by
 *      platform and ordered the way a human reads them (mac, linux, windows,
 *      android, source), with signatures, checksums and metadata files
 *      filtered out. `Clash.Verge_2.5.5_x64-setup.exe` becomes
 *      `🪟 ویندوز · ۶۴ بیتی · ۲۸MB`.
 */

// ── HTML sanitisation ──────────────────────────────────────────────────────

/** The only tags Telegram Bot API accepts in parse_mode=HTML. */
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "s", "code", "pre", "blockquote", "a", "tg-spoiler", "br"]);

/** Tags that mean the same thing to a human but not to Telegram. */
const ALIAS: Record<string, string> = { strong: "b", em: "i", ins: "u", strike: "s", del: "s" };

/**
 * GitHub-flavoured markdown → the subset of HTML Telegram renders.
 *
 * Order matters: fenced blocks are extracted first so their contents are never
 * touched by the inline rules, then inline code is protected, then emphasis.
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return "";
  // 0. drop the tag bodies that must never be read back, before anything else
  let s = md.replace(/<(script|style|iframe)\b[\s\S]*?<\/\1>/gi, "");
  // 1. fenced code blocks survive verbatim
  const fences: string[] = [];
  s = s.replace(/```([a-z0-9+#-]*)\n?([\s\S]*?)```/gi, (_m, _lang, code) => {
    fences.push(String(code).replace(/\s+$/, ""));
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  // 2. inline code
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(String(code));
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  // 3. lift raw HTML out of the way.
  //
  //    This is the step that used to be wrong. GitHub release bodies are
  //    markdown that routinely contains *literal* HTML — `<details><summary>`
  //    blocks are everywhere — and markdown renders those as HTML, not as
  //    text. Escaping them produced a post that showed `&lt;details&gt;` or, if
  //    half-escaped, a dangling `</strong>`. So tags are stashed as
  //    placeholders, the remaining text is escaped, and the tags come back
  //    through an allowlist (see restoreTag) that maps what Telegram knows and
  //    unwraps what it does not.
  const tags: string[] = [];
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => {
    tags.push(m);
    return `\u0000TAG${tags.length - 1}\u0000`;
  });
  // 4. escape everything that is left, so nothing user-supplied can inject a tag
  s = tgEscape(s);
  // 4. markdown emphasis + links + quotes
  s = s
    .replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*>\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^---+$/gm, "─────");
  // 5. collapse adjacent blockquotes into one block (Telegram renders each as
  //    a separate bar, which looks like stripes rather than a quote)
  s = s.replace(/<\/blockquote>\n<blockquote>/g, "\n");
  // 6. bring the raw HTML back through the allowlist
  s = s.replace(/\u0000TAG(\d+)\u0000/g, (_m, i) => restoreTag(tags[Number(i)]));
  // 7. restore the protected spans, escaped
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `<code>${tgEscape(codes[Number(i)])}</code>`);
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => `<pre><code>${tgEscape(fences[Number(i)])}</code></pre>`);
  // the fence/code bodies are the only place a \u0000 could still be hiding;
  // anything that survives is text the author typed, so make it visible.
  return s.replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A single raw HTML tag → the closest thing Telegram can render.
 *
 * Unknown tags are unwrapped rather than escaped: `<details>` is a container
 * the author clearly meant as structure, and showing its *contents* is what a
 * human reading the changelog on GitHub would have seen.
 */
export function restoreTag(tag: string): string {
  const m = tag.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)\/?>$/);
  if (!m) return "";
  const closing = m[1] === "/";
  const name = m[2].toLowerCase();
  const attrs = m[3] ?? "";
  if (!ALLOWED.has(name)) return "";
  const mapped = ALIAS[name] ?? name;
  if (mapped === "br") return closing ? "" : "\n";
  if (mapped === "a") {
    if (closing) return "</a>";
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    if (!/^https?:\/\//i.test(href)) return "";
    return `<a href="${tgEscape(href)}">`;
  }
  return closing ? `</${mapped}>` : `<${mapped}>`;
}

/**
 * Last line of defence before anything is sent.
 *
 * Operates on already-HTML text and guarantees the result is well-formed for
 * Telegram: unknown tags are unwrapped (keeping their text), void tags that
 * would dangle are removed, and every `<a href>` keeps only http(s).
 * This is what makes "AI wrote the post" safe to publish unattended.
 */
export function sanitizeHtml(html: string, opts: { allowLinks?: boolean } = {}): string {
  if (!html) return "";
  const allowLinks = opts.allowLinks !== false;
  // Kill the tags that are dangerous before anything else — their *content*
  // too, since a script body is not text a reader should ever see.
  let s = html
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*\/?>/gi, "");
  if (!allowLinks) s = s.replace(/<\/?a\b[^>]*>/gi, "");
  // balanceTags does the rest: every remaining tag goes through the allowlist,
  // unknown ones are unwrapped, and the result is closed.
  return balanceTags(s);
}

/**
 * Close anything left open, drop anything closed without being opened.
 *
 * Telegram rejects a message with an unclosed tag *outright* — the whole post
 * disappears with a 400. So a stray `<b>` in a changelog would not produce
 * slightly-off formatting, it would produce silence. This is the function that
 * makes "the model wrote it" safe to send.
 *
 * It also understands attributes, which the first version did not: `<a
 * href="…">` was invisible to the matcher, so its `</a>` looked like a closing
 * tag for something that was never opened and got deleted.
 */
export function balanceTags(html: string): string {
  const stack: string[] = [];
  const out = html.replace(/<\/?[a-zA-Z][^>]*>/g, (raw) => {
    const tag = restoreTag(raw);
    if (!tag) return "";            // unknown or unsafe → unwrap, keep the text
    if (tag === "\n") return "\n";  // <br>
    const name = tag.match(/^<\/?([a-z-]+)/)?.[1] ?? "";
    if (!name) return "";
    if (tag.startsWith("</")) {
      const at = stack.lastIndexOf(name);
      if (at === -1) return "";     // closing a tag that was never opened
      for (let i = stack.length - 1; i > at; i--) stack.pop();
      stack.pop();
      return `</${name}>`;
    }
    // `<pre>` and `<blockquote>` may not sit inside inline tags in Telegram's
    // parser, so close whatever inline tag is open before opening them.
    if (name === "pre" || name === "blockquote") {
      let closed = "";
      while (stack.length && stack[stack.length - 1] !== "code" && stack[stack.length - 1] !== "pre" && stack[stack.length - 1] !== "blockquote") {
        const open = stack.pop()!;
        closed += `</${open}>`;
      }
      stack.push(name);
      return closed + tag;
    }
    stack.push(name);
    return tag;
  });
  return out + stack.reverse().map((t) => `</${t}>`).join("");
}

// ── release assets ─────────────────────────────────────────────────────────

export interface Asset {
  name: string;
  size: number;
  url: string;
  downloads?: number;
  type?: string;
}

export type Platform = "mac" | "linux" | "windows" | "android" | "ios" | "source" | "other";

export interface ClassifiedAsset extends Asset {
  platform: Platform;
  arch?: "arm64" | "x64" | "armv7" | "universal";
  /** what a reader needs to know, not the raw filename */
  label: string;
}

const OS_ICON: Record<Platform, string> = {
  mac: "🍎", linux: "🐧", windows: "🪟", android: "🤖", ios: "📱", source: "📦", other: "📄",
};
const OS_FA: Record<Platform, string> = {
  mac: "مک", linux: "لینوکس", windows: "ویندوز", android: "اندروید", ios: "آی‌اواس", source: "سورس", other: "سایر",
};

/** Files nobody wants a button for: signatures, checksums, manifests, logs. */
const NOISE = /(\.sig|\.asc|\.pem|\.sha\d*|\.md5|\.txt$|\.json$|\.yml$|\.yaml$|\.blockmap$|\.log$|latest\.|\.zsync$)/i;

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1073741824).toFixed(2)}GB`;
}

export function classifyAsset(a: Asset): ClassifiedAsset | null {
  const n = a.name.toLowerCase();
  if (NOISE.test(n)) return null;
  let platform: Platform = "other";
  // `darwin` contains `win`, so the mac test has to come first and the Windows
  // test has to be anchored — otherwise every macOS build ships labelled
  // "ویندوز" to the channel. (Found by running the real sample release, not by
  // reading the regex.)
  if (/\.(dmg|pkg)$/.test(n) || /darwin|macos|osx|apple/.test(n)) platform = "mac";
  else if (/\.(deb|rpm|appimage|snap|flatpak)$/.test(n) || /linux/.test(n)) platform = "linux";
  else if (/(windows|win32|win64|[-_.]win[-_.]|[-_.]win$|^win[-_.])/.test(n) || /\.(exe|msi|msix|appx)$/.test(n)) platform = "windows";
  else if (/\.apk$/.test(n) || /android/.test(n)) platform = "android";
  else if (/\.ipa$/.test(n)) platform = "ios";
  else if (/\.(zip|tar\.gz|tgz|tar\.xz|tar\.zst|7z)$/.test(n)) platform = "source";
  else if (!/\.(dmg|deb|exe)$/.test(n) && /\.(js|py|sh)$/.test(n)) platform = "source";

  let arch: ClassifiedAsset["arch"];
  if (/aarch64|arm64|apple-?silicon|m1|m2|m3/.test(n)) arch = "arm64";
  else if (/armv7|armhf|arm32|\barm\b/.test(n)) arch = "armv7";
  else if (/x64|x86_64|amd64|win64|_64/.test(n)) arch = "x64";
  else if (/universal|all/.test(n)) arch = "universal";

  const archFa = arch === "arm64" ? "ARM64" : arch === "x64" ? "۶۴ بیتی" : arch === "armv7" ? "ARM32" : arch === "universal" ? "یونیورسال" : "";

  // Prefer the most specific signal: setup/portable beats the OS name.
  let flavor = "";
  const cleaner = /clean|portable/.test(n) ? "پرتابل" : /setup|installer/.test(n) ? "نصب" : "";
  if (platform === "source") flavor = "آرشیو";

  const label = [OS_FA[platform], archFa, cleaner, flavor].filter(Boolean).join(" · ");
  return { ...a, platform, arch, label };
}

/**
 * Order assets for reading, not for dumping: mac, linux, windows, android,
 * then everything else, largest first inside each group. The reader picks
 * "their" line and taps once.
 */
export function groupAssets(assets: Asset[]): ClassifiedAsset[] {
  const order: Platform[] = ["mac", "linux", "windows", "android", "ios", "source", "other"];
  const classified = (assets ?? []).map(classifyAsset).filter((a): a is ClassifiedAsset => a !== null);
  return classified.sort((a, b) => {
    const d = order.indexOf(a.platform) - order.indexOf(b.platform);
    if (d !== 0) return d;
    return b.size - a.size;
  });
}

/** Inline-keyboard rows: one tap per asset, label carries the platform. */
export function assetButtons(assets: Asset[], max = 8): Array<Array<{ text: string; url: string }>> {
  return groupAssets(assets)
    .slice(0, max)
    .map((a) => [{
      text: `${OS_ICON[a.platform]} ${a.label} — ${humanSize(a.size)}${a.downloads ? ` · ${a.downloads}⬇` : ""}`,
      url: a.url,
    }]);
}

// ── the post ───────────────────────────────────────────────────────────────

import { h2, h3, p as rp, aside, details, ul, table, hr, footer } from "../tg/rich";

export interface ReleasePostInput {
  repo: string;
  tag: string;
  name?: string;
  body?: string;
  url?: string;
  publishedAt?: string;
  prerelease?: boolean;
  assets?: Asset[];
  /** rewritten, in-channel voice (Persian); falls back to a cleaned body */
  editorial?: string;
  channel?: string;
  /** which AI models contributed — shown in the DNA footer, not the post */
  models?: string[];
  /** live repository facts. The connector fills these in; the post shows them
      instead of the placeholder that used to make a release look empty. */
  meta?: ReleaseMeta;
}

export interface ReleaseMeta {
  stars?: number;
  forks?: number;
  issues?: number;
  language?: string;
  license?: string;
  description?: string;
  topics?: string[];
}

export interface ComposedPost {
  text: string;
  markup: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
  /** how many buttons survived the noise filter */
  assetCount: number;
  /** the same post as a rich message: headings, a download table, an open
      changelog. Channels that accept it get this; the rest get `text`. */
  rich: string;
}

const faDate = (iso?: string): string => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
};

/**
 * The channel post.
 *
 * Layout (deliberately close to what a good Persian tech channel writes):
 *
 *     🚀 نسخهٔ جدید منتشر شد
 *     ┌ <repo>
 *     ├ نسخه  v2.5.5
 *     └ ۱۲ مهر ۱۴۰۴
 *
 *     <blockquote>چند خط خلاصهٔ خوانا از تغییرات</blockquote>
 *
 *     ⬇️ دانلود  (buttons below)
 */
export function composeReleasePost(input: ReleasePostInput): ComposedPost {
  const { repo, tag } = input;
  const name = (input.name ?? "").trim();
  const title = name && name !== tag ? name : tag;
  const page = input.url ?? `https://github.com/${repo}/releases`;
  const source = input.editorial || input.body || "";
  const bodyHtml = input.editorial
    ? sanitizeHtml(markdownToTelegramHtml(input.editorial))
    : sanitizeHtml(markdownToTelegramHtml(releaseChangelog(input.body ?? "")));

  const kind = releaseKind(tag, !!input.prerelease);
  const highlights = extractHighlights(source, 5);
  const breaking = isBreaking(source);
  const groups = groupAssets(input.assets ?? []);
  const stats = releaseStats(input.meta, repo);
  const tags = releaseTags(input.meta, repo, kind);

  /* The plain post (what a text-only channel gets) and the rich one are built
     from the same facts, in the same order: what shipped, what changed, what to
     download, and where it came from. A release with no assets used to collapse
     into a single grey line — that is the "خشک و خالی" the owner objected to, so
     the highlights and the repository's real numbers carry the post instead. */
  const head =
    `${kind.icon} <b>${kind.fa}</b>\n` +
    `┌ <a href="${tgEscape(page)}">${tgEscape(repo)}</a>\n` +
    `├ <b>${tgEscape(title)}</b>\n` +
    `└ <code>${tgEscape(tag)}</code>${faDate(input.publishedAt) ? ` · ${faDate(input.publishedAt)}` : ""}`;

  const text = [
    head,
    stats ? stats : "",
    breaking ? "⚠️ <b>شکستن سازگاری</b> — قبل از آپدیت، بخش مهاجرت را بخوان" : "",
    highlights.length ? `📌 <b>مهم‌ترین تغییرات</b>\n` + highlights.map((h) => `• ${h}`).join("\n") : "",
    bodyHtml ? `<blockquote>${bodyHtml}</blockquote>` : "",
    groups.length
      ? `⬇️ <b>دانلود</b>\n` + groups.slice(0, 6).map((a) => `${OS_ICON[a.platform]} ${tgEscape(a.label)} — <code>${humanSize(a.size)}</code>`).join("\n")
      : `📦 <b>آرشیو سورس</b> — <a href="https://github.com/${tgEscape(repo)}">github.com/${tgEscape(repo)}</a>`,
    tags,
  ].filter(Boolean).join("\n\n");

  // One button per release asset, then exactly one link to the project itself.
  // The asset rows are the point of the post; the project button is where a
  // reader goes when none of the builds is the one they wanted.
  const rows = assetButtons(input.assets ?? []);
  rows.push([{ text: "🔗 لینک پروژه", url: `https://github.com/${repo}` }]);

  const richRows: string[][] = [["سیستم", "فایل", "حجم", "⬇️"]];
  for (const a of groups.slice(0, 8)) {
    richRows.push([
      `${OS_ICON[a.platform]} ${tgEscape(a.label)}`,
      `<code>${tgEscape(a.name.length > 34 ? a.name.slice(0, 31) + "…" : a.name)}</code>`,
      humanSize(a.size),
      a.downloads ? String(a.downloads) : "—",
    ]);
  }

  const rich = [
    h2(`${kind.icon} ${tgEscape(title)}`),
    rp(`<a href="${tgEscape(page)}"><b>${tgEscape(repo)}</b></a>` +
      (input.meta?.description ? `<br>${tgEscape(input.meta.description.slice(0, 160))}` : "") +
      (faDate(input.publishedAt) ? `<br>🗓 ${faDate(input.publishedAt)}` : "")),
    stats ? aside(stats, "repository") : "",
    breaking ? aside("⚠️ این نسخه سازگاری را می‌شکند — پیش از آپدیت یادداشت مهاجرت را بخوان.", "breaking change") : "",
    highlights.length ? h3("📌 مهم‌ترین تغییرات") + ul(highlights) : "",
    bodyHtml ? details("📜 متن کامل تغییرات", rp(bodyHtml), true) : "",
    groups.length
      ? h3("⬇️ دانلود") + table(richRows, { caption: `📦 ${groups.length} فایل برای این نسخه` })
      : rp(`📦 آرشیو سورس در <a href="https://github.com/${tgEscape(repo)}">github.com/${tgEscape(repo)}</a>`),
    hr() + footer(`${tgEscape(repo)} · ${kind.fa} · ${tags.replace(/<[^>]+>/g, "")}`),
  ].filter(Boolean).join("");

  return { text, markup: { inline_keyboard: rows }, assetCount: groups.length, rich };
}

/* ── what kind of release is this ─────────────────────────────────────────── */

export type ReleaseKind = "major" | "minor" | "patch" | "pre" | "other";

export function releaseKind(tag: string, prerelease = false): { kind: ReleaseKind; fa: string; icon: string } {
  if (prerelease || /-(rc|beta|alpha|pre|dev|next)\.?\d*$/i.test(tag)) {
    return { kind: "pre", fa: "نسخهٔ آزمایشی منتشر شد", icon: "🧪" };
  }
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  if (m) {
    if (m[3] !== "0") return { kind: "patch", fa: "نسخهٔ جدید منتشر شد", icon: "🚀" };
    if (m[2] !== "0") return { kind: "minor", fa: "نسخهٔ تازه با قابلیت‌های جدید", icon: "✨" };
    return { kind: "major", fa: "نسخهٔ اصلی منتشر شد", icon: "🆙" };
  }
  return { kind: "other", fa: "نسخهٔ جدید منتشر شد", icon: "🚀" };
}

const SECTION_ICON: Array<[RegExp, string]> = [
  [/feat|feature|new|add(ed)?|قابلیت|ویژگی|افزود/i, "✨"],
  [/fix|bug|patch|رفع|باگ|اصلاح/i, "🛠"],
  [/perf|speed|performance|کارایی|سرعت/i, "⚡️"],
  [/secur|vuln|امنیت|آسیب/i, "🛡"],
  [/doc|مستند|سند/i, "📝"],
  [/refactor|chore|internal|بازنویسی/i, "🧹"],
  [/break|migrat|سازگاری|مهاجرت/i, "⚠️"],
];

/**
 * Turn a changelog into the three-to-five lines a reader actually reads.
 *
 * GitHub changelogs are written for reviewers: sections, links, "full changelog"
 * boilerplate. The bullet list is real information; the rest is scaffolding. We
 * keep the bullets, label each with the section it came from, and drop the
 * plumbing (`* @user made their first contribution`, link-only lines, headings).
 */
export function extractHighlights(body: string, max = 5): string[] {
  const lines = String(body ?? "").split("\n");
  const out: string[] = [];
  let icon = "•";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*(.+?)\*\*:?$/.exec(line);
    if (heading) {
      const found = SECTION_ICON.find(([re]) => re.test(heading[1]));
      icon = found ? found[1] : "•";
      continue;
    }
    if (!/^(?:[-*•]|\d+[.)])\s+/.test(line)) continue;
    // strip *every* leading marker: a changelog writes «- • text» often enough
    // that one pass leaves a bullet behind and the post reads «• • text»
    let item = line;
    while (/^(?:[-*•]|\d+[.)])\s+/.test(item)) item = item.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    if (/first contribution|full changelog|what'?s changed|@\w+ made their|^thanks |sponsor/i.test(item)) continue;
    item = item
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")      // [text](url) → text
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`]{1,3}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!item || item.length < 4) continue;
    out.push(`${icon} ${item.slice(0, 140)}`);
    if (out.length >= max) break;
  }
  return out;
}

export const isBreaking = (body: string): boolean =>
  /(?:^|\n)\s*(?:[-*#]+\s*)?(?:breaking(?:[ -]change)?|incompatible|migration required|شکستن سازگاری|ناسازگار)/im.test(String(body ?? ""));

/** The repository's own numbers, laid out as one line. Real values only. */
export function releaseStats(meta: ReleaseMeta | undefined, repo: string): string {
  if (!meta) return "";
  const bits: string[] = [];
  const n = (v: number | undefined) => (typeof v === "number" && v > 0 ? fmtCompact(v) : "");
  if (n(meta.stars)) bits.push(`⭐ ${n(meta.stars)}`);
  if (n(meta.forks)) bits.push(`🍴 ${n(meta.forks)}`);
  if (n(meta.issues)) bits.push(`🐞 ${n(meta.issues)}`);
  if (meta.language) bits.push(`🧩 ${tgEscape(meta.language)}`);
  if (meta.license) bits.push(`⚖️ ${tgEscape(String(meta.license))}`);
  if (!bits.length) bits.push(`🐙 ${tgEscape(repo)}`);
  return `📊 <b>${tgEscape(repo)}</b> · ` + bits.join(" · ");
}

/** Topics and language, as channel hashtags. */
export function releaseTags(meta: ReleaseMeta | undefined, repo: string, kind: { kind: ReleaseKind }): string {
  const tags = new Set<string>();
  tags.add("#" + repo.split("/").pop()!.replace(/[^A-Za-z0-9_]/g, "").toLowerCase());
  if (kind.kind !== "other") tags.add("#release");
  for (const t of (meta?.topics ?? []).slice(0, 3)) tags.add("#" + String(t).replace(/[^A-Za-z0-9_]/g, ""));
  if (meta?.language) tags.add("#" + String(meta.language).replace(/[^A-Za-z0-9_]/g, "").toLowerCase());
  return [...tags].filter((t) => t.length > 2).join(" ");
}

/** 12400 → 12.4k — a channel reads compact numbers, not five digits. */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * The changelog as it belongs inside the post: boilerplate gone, capped.
 *
 * `clipChangelog` already stops at the "full changelog / contributors" footer;
 * this also drops the first-contribution and compare-link lines that survive
 * inside a section, and caps the length so an open `<details>` never buries the
 * download table under a wall of text.
 */
export function releaseChangelog(body: string, maxChars = 900): string {
  const cleaned = clipChangelog(body, 24)
    .split("\n")
    .filter((l) => !/first contribution|full changelog|compare\/v?\d|what'?s changed\s*$/i.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).replace(/\n[^\n]*$/, "") + "…" : cleaned;
}

/**
 * Changelogs are written for reviewers, not readers. Keep the first coherent
 * block and drop the trailing boilerplate that every project pastes in.
 */
export function clipChangelog(body: string, maxLines = 14): string {
  if (!body) return "";
  const lines = body.split("\n");
  const cut = lines.findIndex((l) => /^(full changelog|what'?s changed|contributors|new contributors|thank you|sponsor)/i.test(l.trim()));
  const kept = (cut > 2 ? lines.slice(0, cut) : lines).slice(0, maxLines);
  return kept.join("\n").trim();
}
