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
}

if (failed) { console.error(`\n${failed} rich-message check(s) failed`); process.exit(1); }
console.log("✅ rich messages: builders balanced, fallback lossless enough");
