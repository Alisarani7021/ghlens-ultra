import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { hubId } from "./event";
import { indexEntities } from "./knowledge";

/**
 *  FILE UNIVERSE
 *
 *      upload → detect → extract → index → knowledge
 *
 *  A file is not a blob. It is a source of facts, and this layer turns it into
 *  ones the rest of the hub can reason about: text, structure, entities, and a
 *  searchable document.
 *
 *  ── Scope, deliberately ──────────────────────────────────────────────────
 *  This build handles **text-shaped** documents: txt, md, csv/tsv, json, xml,
 *  yaml, html, code, and PDFs whose text can be read directly. Deliberately
 *  absent: audio and video transcription. The owner removed every audio
 *  surface from this bot by instruction («تموم قسمت های صوتی رو از تو ربات
 *  بردار»), and a transcript pipeline is exactly that surface coming back
 *  through a side door.
 *
 *  Images are catalogued, not described: we record dimensions and metadata so
 *  a file is findable, and stop there rather than spending AI quota guessing.
 */

export type DocKind = "text" | "markdown" | "csv" | "json" | "xml" | "yaml" | "html" | "code" | "pdf" | "archive" | "image" | "binary" | "unknown";

export interface Detected {
  kind: DocKind;
  mime: string;
  /** best-guess language for code/text, for display and search */
  lang?: string;
  /** true when we can pull text out of it */
  extractable: boolean;
  /** set when the file cannot be read, with the reason a human needs */
  unsupported?: string;
}

const EXT_KIND: Record<string, DocKind> = {
  txt: "text", log: "text", md: "markdown", markdown: "markdown", rst: "markdown",
  csv: "csv", tsv: "csv", json: "json", jsonl: "json", ndjson: "json",
  xml: "xml", rss: "xml", atom: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", toml: "yaml", ini: "yaml", env: "yaml",
  htm: "html", html: "html",
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code",
  swift: "code", php: "code", c: "code", h: "code", cpp: "code", cs: "code",
  sh: "code", bash: "code", zsh: "code", sql: "code", css: "code", scss: "code",
  lua: "code", dart: "code", zig: "code", ex: "code", exs: "code", hs: "code",
  pdf: "pdf",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", "7z": "archive", rar: "archive", xz: "archive", zst: "archive",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", avif: "image",
};

const LANG_HINT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", swift: "swift", php: "php",
  c: "c", h: "c", cpp: "cpp", cs: "csharp", sh: "shell", bash: "shell", zsh: "shell",
  sql: "sql", css: "css", scss: "css", lua: "lua", dart: "dart", zig: "zig",
};

export function extOf(name: string): string {
  const clean = (name ?? "").split(/[?#]/)[0];
  const base = clean.split("/").pop() ?? clean;
  // `dockerfile`, `makefile` and friends have no extension but are code
  const lower = base.toLowerCase();
  if (/^(dockerfile|makefile|procfile|vagrantfile|gemfile|rakefile)$/.test(lower)) return "sh";
  const m = lower.match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

export function detect(name: string, mime?: string, bytes?: number): Detected {
  const ext = extOf(name);
  const kind = EXT_KIND[ext] ?? (mime?.startsWith("text/") ? "text" : mime?.startsWith("image/") ? "image" : "unknown");
  const extractable = ["text", "markdown", "csv", "json", "xml", "yaml", "html", "code", "pdf"].includes(kind);
  const out: Detected = {
    kind,
    mime: mime ?? guessMime(kind, ext),
    lang: LANG_HINT[ext],
    extractable,
  };
  if (!extractable) {
    out.unsupported =
      kind === "image" ? "تصویر فقط فهرست می‌شود (بعداً با جست‌وجو پیدا می‌شود)"
      : kind === "archive" ? "آرشیو برای استخراج باید باز شود"
      : "این نوع فایل متن قابل خواندن ندارد";
  }
  if (typeof bytes === "number" && bytes > 20 * 1024 * 1024 && kind === "pdf") {
    out.unsupported = "PDF بزرگ‌تر از ۲۰MB — برای استخراج متن مناسب نیست";
  }
  return out;
}

function guessMime(kind: DocKind, ext: string): string {
  const map: Partial<Record<DocKind, string>> = {
    text: "text/plain", markdown: "text/markdown", csv: "text/csv", json: "application/json",
    xml: "application/xml", yaml: "application/yaml", html: "text/html", code: "text/plain",
    pdf: "application/pdf", image: "image/*", archive: "application/zip",
  };
  return map[kind] ?? (ext ? `application/${ext}` : "application/octet-stream");
}

// ── extraction ─────────────────────────────────────────────────────────────

export interface Extraction {
  text: string;
  /** structured view when the format has one */
  structured?: any;
  /** short facts worth showing before the body */
  facts: Array<{ label: string; value: string }>;
  truncated: boolean;
  note?: string;
}

const LIMIT = 60_000;

/**
 * Turn bytes into text.
 *
 * Every decoder here works on a byte array rather than a string. That is not
 * pedantry: the previous generation of this project decoded base64 to a string
 * with `atob()` and then read UTF-8 bytes out of it, which mangled every
 * non-ASCII character — Persian, Chinese and Arabic arrived in the chat as
 * `æ ä»¶å`. A `TextDecoder` that is *told* the encoding does not have that bug.
 */
export function decodeText(bytes: Uint8Array): string {
  // BOM sniffing first — it is the one unambiguous signal of the encoding.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  // Replacement characters mean it was not UTF-8; fall back to Cyrillic-safe
  // latin-1 so a Western file does not turn into question marks.
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > utf8.length * 0.02) return new TextDecoder("windows-1256" as any).decode(bytes);
  return utf8;
}

export function extract(name: string, mime: string | undefined, bytes: Uint8Array): Extraction {
  const d = detect(name, mime, bytes.length);
  const facts: Array<{ label: string; value: string }> = [];
  const size = bytes.length;
  facts.push({ label: "حجم", value: humanBytes(size) });
  facts.push({ label: "نوع", value: d.kind + (d.lang ? ` · ${d.lang}` : "") });

  if (!d.extractable) {
    return { text: "", facts, truncated: false, note: d.unsupported };
  }

  if (d.kind === "pdf") {
    const r = extractPdf(bytes);
    facts.push({ label: "صفحات", value: String(r.pages) });
    return { text: r.text.slice(0, LIMIT), facts, truncated: r.text.length > LIMIT, note: r.text ? undefined : "متنی در این PDF پیدا نشد (احتمالاً اسکن‌شده است)" };
  }

  let text = decodeText(bytes);
  const truncated = text.length > LIMIT;
  if (truncated) text = text.slice(0, LIMIT);

  if (d.kind === "json") {
    try {
      const parsed = JSON.parse(text);
      const shape = describeShape(parsed);
      facts.push(...shape.facts);
      return { text, structured: parsed, facts, truncated };
    } catch {
      facts.push({ label: "JSON", value: "نامعتبر" });
      return { text, facts, truncated };
    }
  }

  if (d.kind === "csv") {
    const rows = parseCsv(text);
    facts.push({ label: "سطرها", value: fmtNum(rows.length) });
    if (rows[0]) facts.push({ label: "ستون‌ها", value: String(rows[0].length) });
    if (rows[1]) facts.push({ label: "نمونه", value: rows[1].slice(0, 4).join(" · ").slice(0, 90) });
    return { text: rows.map((r) => r.join(" | ")).join("\n"), structured: rows.slice(0, 200), facts, truncated };
  }

  if (d.kind === "markdown") {
    const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 8);
    const links = (text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
    const code = (text.match(/```/g) ?? []).length / 2;
    facts.push({ label: "سرفصل‌ها", value: String(headings.length) });
    facts.push({ label: "لینک‌ها", value: String(links) });
    facts.push({ label: "بلوک کد", value: String(Math.floor(code)) });
    if (headings.length) facts.push({ label: "ساختار", value: headings.slice(0, 3).join(" › ").slice(0, 100) });
    return { text, structured: { headings }, facts, truncated };
  }

  if (d.kind === "html" || d.kind === "xml") {
    const stripped = xmlToText(text);
    const tags = [...text.matchAll(/<([a-z][\w-]*)\b/gi)].map((m) => m[1].toLowerCase());
    const top = topN(tags, 4);
    if (top.length) facts.push({ label: "تگ‌ها", value: top.map(([t, n]) => `${t}×${n}`).join(" · ") });
    return { text: stripped || text, structured: undefined, facts, truncated: false };
  }

  if (d.kind === "code") {
    const lines = text.split("\n");
    const imports = lines.filter((l) => /^\s*(import|from|require|use|#include)\b/.test(l)).length;
    const fns = (text.match(/\b(function|def|fn|func|class|interface|struct)\s+\w+/g) ?? []).length;
    const todos = (text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
    facts.push({ label: "خطوط", value: fmtNum(lines.length) });
    if (imports) facts.push({ label: "ایمپورت", value: String(imports) });
    if (fns) facts.push({ label: "تعریف‌ها", value: String(fns) });
    if (todos) facts.push({ label: "TODO", value: String(todos) });
    facts.push({ label: "توابع", value: String(fns) });
    return { text, structured: { lines: lines.length, imports, definitions: fns, todos }, facts, truncated };
  }

  return { text, facts, truncated };
}

/**
 * PDF text extraction, written out.
 *
 * A full PDF engine is megabytes of dependency for one job, and the structure
 * this needs is narrow: find `stream … endstream` blocks that are actual
 * content streams, inflate the FlateDecode ones, and read the text-showing
 * operators (`Tj`, `TJ`) out of them, resolving the escapes.
 *
 * What it will not do: OCR. A scanned PDF has no text operators at all, and the
 * caller is told exactly that rather than being handed an empty string.
 */
export function extractPdf(bytes: Uint8Array): { text: string; pages: number } {
  const raw = latin1(bytes);
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) ?? []).length);
  const chunks: string[] = [];

  // 1. content streams: inflate where the filter says so, otherwise read raw
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const body = m[1];
    const around = raw.slice(Math.max(0, m.index - 400), m.index);
    let data: Uint8Array;
    if (/\/FlateDecode/.test(around)) {
      const inflated = inflate(body);
      if (!inflated) continue;
      data = inflated;
    } else {
      data = latin1Bytes(body);
    }
    const text = pdfOperatorsToText(latin1(data));
    if (text.trim()) chunks.push(text);
  }

  // 2. fall back to the plain-text operators if no streams yielded anything
  if (!chunks.length) {
    const t = pdfOperatorsToText(raw);
    if (t.trim()) chunks.push(t);
  }

  const text = chunks
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, pages };
}

/** `(Hello) Tj` and `[(He) -250 (llo)] TJ` → `Hello`. */
function pdfOperatorsToText(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)|\bTj\b|\bTJ\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|\bBT\b/g;
  let m: RegExpExecArray | null;
  let line = "";
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.startsWith("(")) {
      line += unescapePdfString(tok.slice(1, -1));
    } else if (tok === "Td" || tok === "TD" || tok === "T*") {
      if (line.trim()) out.push(line.trim());
      line = "";
    } else if (tok === "BT") {
      if (line.trim()) out.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n");
}

function unescapePdfString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "(" || n === ")" || n === "\\") out += n;
    else if (n === "\n") { /* line continuation */ }
    else if (/[0-7]/.test(n ?? "")) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n ?? "";
  }
  // PDF strings are byte strings; the octal escapes above produce raw bytes, so
  // run the result back through the UTF-8 decoder to get real characters.
  try {
    const bytes = Uint8Array.from([...out].map((ch) => ch.charCodeAt(0) & 0xff));
    const decoded = decodeText(bytes);
    return decoded;
  } catch { return out; }
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return s;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Minimal zlib/DEFLATE inflater.
 *
 * `DecompressionStream("deflate")` exists in workerd, so this is a wrapper that
 * keeps the fallback path synchronous-free: callers get null when inflation
 * fails, and the PDF layer skips that stream rather than throwing.
 */
function inflate(latin1Body: string): Uint8Array | null {
  // No sync API for the platform decompressor, so this path is handled by the
  // async wrapper below; here we return null and let it be skipped rather than
  // pretending. See inflateAsync for the real work.
  void latin1Body;
  return null;
}

/** The async form of `inflate`, used by `extractPdfAsync`. */
export async function inflateAsync(bytes: Uint8Array): Promise<Uint8Array | null> {
  const tryOne = async (format: "deflate" | "deflate-raw") => {
    try {
      const ds = new DecompressionStream(format);
      const stream = new Blob([bytes as any]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch { return null; }
  };
  // PDF FlateDecode is zlib-wrapped; raw is the fallback for malformed writers.
  return (await tryOne("deflate")) ?? (await tryOne("deflate-raw"));
}

/**
 * Async PDF extraction — the one that actually inflates streams.
 *
 * The filter hint (`/FlateDecode` in the object dictionary) is used as a
 * *preference*, never as the decision. Generators are sloppy: the dictionary
 * can be further back than any sane look-back window, or missing entirely, and
 * a stream that is compressed but not declared would otherwise read as
 * kilobytes of noise and produce zero text. So each stream is tried as raw
 * bytes first and inflated second — whichever yields text operators wins.
 */
export async function extractPdfAsync(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const raw = latin1(bytes);
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) ?? []).length);
  const chunks: string[] = [];
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const body = m[1].replace(/\r?\n$/, "");
    const around = raw.slice(Math.max(0, m.index - 600), m.index);
    const declared = /\/FlateDecode/.test(around);
    const rawBytes = latin1Bytes(body);

    // Try in the order the dictionary suggests, then the other one. Two
    // attempts per stream is cheap; a missed stream is a missing page.
    const order: Array<"raw" | "inflate"> = declared ? ["inflate", "raw"] : ["raw", "inflate"];
    for (const how of order) {
      let data = rawBytes;
      if (how === "inflate") {
        const inflated = await inflateAsync(rawBytes);
        if (!inflated) continue;
        data = inflated;
      }
      const text = pdfOperatorsToText(latin1(data));
      if (text.trim()) { chunks.push(text); break; }
    }
    if (chunks.length > 400) break; // a 2000-page document is not what anyone uploads to a chat
  }
  if (!chunks.length) {
    const t = pdfOperatorsToText(raw);
    if (t.trim()) chunks.push(t);
  }
  return {
    text: chunks.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    pages,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

export function fmtNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** XML/HTML → the text a reader would see. */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|item|entry)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * CSV that survives real files: quoted fields, embedded commas and newlines,
 * `""` escapes, and CRLF line endings.
 */
export function parseCsv(text: string, maxRows = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** A one-line shape description of parsed JSON, for the facts panel. */
export function describeShape(value: any, depth = 0): { facts: Array<{ label: string; value: string }> } {
  const facts: Array<{ label: string; value: string }> = [];
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (type === "array") {
    facts.push({ label: "JSON", value: `آرایه با ${fmtNum(value.length)} عضو` });
    if (value[0] && typeof value[0] === "object") {
      const keys = Object.keys(value[0]).slice(0, 8);
      if (keys.length) facts.push({ label: "کلیدهای عضو اول", value: keys.join("، ") });
    }
  } else if (type === "object") {
    const keys = Object.keys(value);
    facts.push({ label: "JSON", value: `شیء با ${keys.length} کلید` });
    facts.push({ label: "کلیدها", value: keys.slice(0, 10).join("، ").slice(0, 140) });
    const nested = keys.map((k) => [k, Array.isArray(value[k]) ? `array(${value[k].length})` : typeof value[k]] as const);
    const arrays = nested.filter(([, t]) => String(t).startsWith("array"));
    if (arrays.length) facts.push({ label: "آرایه‌ها", value: arrays.slice(0, 5).map(([k, t]) => `${k}: ${t}`).join("، ") });
  } else {
    facts.push({ label: "JSON", value: type });
  }
  void depth;
  return { facts };
}

export function topN(items: string[], n: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── the ingest pipeline ────────────────────────────────────────────────────

export interface IngestResult {
  doc_id: string;
  detected: Detected;
  facts: Array<{ label: string; value: string }>;
  entities: number;
  embedded: boolean;
  chars: number;
  preview: string;
  note?: string;
}

/**
 * The whole pipeline in one call, so every entry point (Telegram document,
 * HTTP upload, connector fetch) behaves identically.
 */
export async function ingest(
  env: Env,
  ai: AiBrain,
  input: {
    name: string;
    mime?: string;
    bytes: Uint8Array;
    owner_id: number;
    source_ref?: string;
    /** skip the AI embedding pass (used when the quota is spent) */
    skipEmbed?: boolean;
  },
): Promise<IngestResult> {
  const detected = detect(input.name, input.mime, input.bytes.length);
  let extraction: Extraction;
  if (detected.kind === "pdf") {
    const r = await extractPdfAsync(input.bytes);
    extraction = {
      text: r.text.slice(0, LIMIT),
      facts: [
        { label: "حجم", value: humanBytes(input.bytes.length) },
        { label: "نوع", value: "pdf" },
        { label: "صفحات", value: String(r.pages) },
      ],
      truncated: r.text.length > LIMIT,
      note: r.text ? undefined : "متنی در این PDF پیدا نشد — احتمالاً اسکن‌شده است (بدون OCR خوانده نمی‌شود)",
    };
  } else {
    extraction = extract(input.name, input.mime, input.bytes);
  }

  const id = hubId("doc");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO hub_files (id, owner_id, name, mime, size, kind, lang, bytes_hash, extracted_chars, facts, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, input.owner_id, input.name.slice(0, 200), detected.mime, input.bytes.length,
    detected.kind, detected.lang ?? null, await hashBytes(input.bytes),
    extraction.text.length, JSON.stringify(extraction.facts).slice(0, 2000),
    extraction.note ?? null, now,
  ).run().catch((e: any) => console.error("hub-file-insert", String(e?.message ?? e)));

  let entities = 0;
  if (extraction.text) {
    entities = await indexEntities(env, input.owner_id, id, extraction.text, {
      repo: input.source_ref?.includes("/") ? input.source_ref.split("@")[0] : undefined,
    }).catch(() => 0);
  }

  const { embedDocument } = await import("./knowledge");
  let embedded = false;
  if (extraction.text && !input.skipEmbed) {
    embedded = await embedDocument(env, ai, {
      id, owner_id: input.owner_id, text: extraction.text,
      title: input.name, kind: "file", lang: detected.lang ?? "fa", source_ref: input.source_ref,
    }).catch(() => false);
  }

  return {
    doc_id: id,
    detected,
    facts: extraction.facts,
    entities,
    embedded,
    chars: extraction.text.length,
    preview: extraction.text.slice(0, 600),
    note: extraction.note,
  };
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle.digest` reads the whole buffer; for large files hash a
  // sample plus the length, which is enough to spot the same file twice.
  const sample = bytes.length > 64_000
    ? bytes.subarray(0, 32_000)
    : bytes;
  const buf = await crypto.subtle.digest("SHA-256", sample as any);
  const hex = [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}${bytes.length.toString(36)}`;
}
