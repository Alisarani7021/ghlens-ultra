/**
 * Rich-message checks — run by scripts/check.sh.
 *
 * `src/tg/rich.ts` is bundled with esbuild (already a wrangler dependency) and
 * imported for real; nothing here re-implements it. The point of these checks is
 * the fallback path: `sendRichMessage` is new, and if a deployment's API does not
 * support it the welcome card must still arrive as a sane normal message.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "rich-")), "rich.mjs");
const esbuild = existsSync("node_modules/esbuild/bin/esbuild")
  ? "node_modules/esbuild/bin/esbuild"
  : "npx esbuild";
execFileSync(esbuild, ["src/tg/rich.ts", "--bundle", "--format=esm", "--platform=neutral", `--outfile=${out}`, "--log-level=error"], { stdio: "inherit" });

const R = await import(out);

const rich =
  R.h1("🔭 GitHub Lens Ultra") +
  R.aside("ایستگاهِ کاوشِ اوپن‌سورس") +
  R.table([["بخش", "کار"], ["🔍 جست‌وجو", "معنایی + متنی"], ["🌌 هاب", "رویداد → انتشار"]], { caption: "⚡ توانایی‌ها" }) +
  R.details("🎯 از کجا شروع کنیم؟", R.ul(["یک موضوع بنویس", "owner/repo بفرست"]), true) +
  R.hr() +
  R.footer("🐙 Alisarani7021 · 🧠 آماده");

const legacy = R.richToLegacy(rich);

let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); if (!cond) failed++; };

console.log("▸ rich builders");
ok("table is bordered and striped", rich.includes("<table bordered striped>"));
ok("table carries a caption", rich.includes("<caption>⚡ توانایی‌ها</caption>"));
ok("details is open when asked", rich.includes('<details open><summary>🎯 از کجا شروع کنیم؟</summary>'));
ok("all block tags are balanced", ["table", "tr", "td", "th", "details", "summary", "aside", "ul", "li", "h1", "footer"].every((t) => {
  const open = (rich.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length;
  const close = (rich.match(new RegExp(`</${t}>`, "g")) ?? []).length;
  return open === close;
}));

console.log("▸ legacy fallback");
ok("no rich-only tag survives", !/<(table|tr|td|th|caption|details|summary|aside|h1|hr|footer|ul|ol|li)\b/i.test(legacy));
ok("a table row becomes one line", legacy.includes("🔍 جست‌وجو · معنایی + متنی"));
ok("headings survive as bold", legacy.includes("<b>🔭 GitHub Lens Ultra</b>"));
ok("details titles survive as bold", legacy.includes("<b>🎯 از کجا شروع کنیم؟</b>"));
ok("list items become bullets", legacy.includes("• یک موضوع بنویس"));
ok("pull-quote becomes a blockquote", legacy.includes("<blockquote>"));
ok("no triple newlines", !/\n{3}/.test(legacy));
ok("nothing important was lost", legacy.length > 80);

console.log("▸ telegram-html screens → rich documents");
{
  /* The shape every scout tab writes: an emoji + bold header, blank-line
     sections, bullet items, a code sparkline, a blockquote, italic footnotes. */
  const tab = [
    "📊 <b>oven-sh/bun</b> — نمای کلی",
    "",
    "<i>استارت‌اپ سریع جاوااسکریپت</i>",
    "",
    "⭐ <b>52k</b>  🍴 1.6k  🐞 1.2k",
    "",
    "سلامت: <b>88</b>/100 🟢 ▰▰▰▰▰▰▰▰▱▱",
    "",
    "• <b>زبان‌ها:</b> Zig · JavaScript",
    "• <b>مجوز:</b> MIT",
    "",
    "<code>▁▂▄▆█▆▄▂▁</code>",
    "",
    "<blockquote>هر ۱۵ دقیقه اسنپ‌شات</blockquote>",
  ].join("\n");
  const doc = R.telegramHtmlToRich(tab);
  ok("the bold header becomes the document heading", doc.startsWith("<h1>oven-sh/bun — نمای کلی</h1>"));
  ok("inline tags are not re-escaped", !doc.includes("&lt;b&gt;"));
  ok("bullets become a list", doc.includes("<ul><li><b>زبان‌ها:</b> Zig · JavaScript</li>"));
  ok("a code-only line becomes pre", doc.includes("<pre>▁▂▄▆█▆▄▂▁</pre>"));
  ok("a quote becomes an aside", doc.includes("<aside>هر ۱۵ دقیقه اسنپ‌شات</aside>"));
  ok("plain lines become paragraphs", doc.includes("<p>⭐ <b>52k</b>  🍴 1.6k  🐞 1.2k</p>"));
  ok("blocks are balanced after conversion", ["h1", "p", "ul", "li", "pre", "aside"].every((t) => {
    const open = (doc.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length;
    const close = (doc.match(new RegExp(`</${t}>`, "g")) ?? []).length;
    return open === close;
  }));
  const back = R.richToLegacy(doc);
  ok("the document still degrades to sane legacy text", back.includes("oven-sh/bun") && back.includes("زبان‌ها") && !/\n{3}/.test(back));

  // multi-line shapes: the wiring checklist writes a blockquote over several
  // lines, and code screens write fenced <pre> blocks
  const multi = R.telegramHtmlToRich([
    "🔧 <b>زیرساخت</b>",
    "",
    "<blockquote>تا این‌ها حل نشود چیزی منتشر نمی‌شود:",
    "• وبهوک ثبت نشده",
    "• کانکتور تلگرام آماده نیست</blockquote>",
    "",
    "<pre>",
    "$ wrangler deploy",
    "$ wrangler tail",
    "</pre>",
  ].join("\n"));
  ok("a multi-line quote is one aside",
     multi.includes("<aside>تا این‌ها") && multi.includes("<br>• وبهوک ثبت نشده<br>") && multi.includes("کانکتور تلگرام آماده نیست</aside>") && !multi.includes("</blockquote>"));
  ok("a multi-line pre is one pre", multi.includes("<pre>$ wrangler deploy\n$ wrangler tail</pre>"));
  ok("the rest of the multi-line screen survives", multi.includes("<h1>زیرساخت</h1>"));
}

console.log("▸ the fallback never loses the message");
{
  /* What the whole-bot conversion leans on: if a rich send or edit is refused,
     the plain twin goes out — split when it is long, and as a fresh message
     when the old one can no longer be edited. */
  const longBody = "متن بلند ".repeat(900);   // ~7 000 chars — beyond one legacy message

  const tgRefused = {
    sendRichMessage: async () => ({ ok: false, description: "rich not supported" }),
    sendLong: async (chat, text, opts) => { tgRefused.sent = { text, opts }; return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage must not be used directly"); },
  };
  const how1 = await R.sendRich(tgRefused, 1, R.telegramHtmlToRich(`<b>عنوان</b>\n\n${longBody}`), { rtl: true, extra: { parse_mode: "HTML" } });
  ok("a refused rich send falls back to legacy", how1 === "legacy");
  ok("the fallback goes through the splitter, undamaged", tgRefused.sent && tgRefused.sent.text.length > 4000 && tgRefused.sent.opts.parse_mode === "HTML");

  const tgTooOld = {
    editRichMessage: async () => ({ ok: false, description: "message can't be edited" }),
    editMessageText: async () => ({ ok: false, description: "message to edit not found" }),
    sendLong: async (chat, text) => { tgTooOld.sent = text; return { ok: true }; },
  };
  const how2 = await R.editRich(tgTooOld, 1, 99, "<p>پاسخ تازه</p>", { rtl: true });
  ok("a too-old edit becomes a fresh message", how2 === "legacy" && tgTooOld.sent && tgTooOld.sent.includes("پاسخ تازه"));

  const tgNotModified = {
    editRichMessage: async () => ({ ok: false, description: "rich not supported" }),
    editMessageText: async () => ({ ok: false, description: "Bad Request: message is not modified" }),
    sendLong: async () => { throw new Error("«not modified» must not send a duplicate"); },
  };
  const how3 = await R.editRich(tgNotModified, 1, 99, "<p>همان متن</p>", { rtl: true });
  ok("«not modified» is left alone, not duplicated", how3 === "legacy");
}

if (failed) { console.error(`\n${failed} rich-message check(s) failed`); process.exit(1); }
console.log("✅ rich messages: builders balanced, fallback lossless enough");
