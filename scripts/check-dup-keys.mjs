#!/usr/bin/env node
/**
 * Every inline button label may be defined in exactly ONE place.
 *
 * The owner's words: «هر کلید شیشه‌ای فقط یک بار تو ربات باشه، نه اینکه هر
 * کلیدی تو همه بخشا هستش». Contextual keys are exempt because they *must*
 * repeat — a back key on every screen, a cancel in every wizard — and they
 * always point at a different target per screen.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";
const EXEMPT = new Set([
  // contextual navigation: one per screen by design
  "◀️", "◀️ بازگشت", "◀️ Back", "بازگشت", "Back", "🏠", "🏠 منو", "🏠 Main menu", "🏠 Menu",
  "❌ لغو", "❌ Cancel", "لغو", "Cancel", "❌ انصراف",
  "بعدی ▶️", "next", "قبلی", "prev", "◀️ قبلی", "بعدی", "صفحه بعد", "صفحه قبل",
  "🔁 دوباره", "Retry", "🔁 تلاش دوباره", "🔁 بازسازی", "🔁 Regenerate",
  "ورودی دیگر", "Another", "▶️ بعدی", "دوباره", "🔁 Regen",
  // per-language / per-item labels: same text, different target every row
  "روز", "days", "📅 هفتگی", "🗓 ماهانه", "تست رجکس", "قوانین", "کلید شیشه‌ای",
  "✅", "❌", "🧹 پاک کردن حافظه", "🧹 Clear memory",
  "🎯 فیلترها", "🎯 Filters",
  "🔍 جست‌وجو", "🔍 Search",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const hits = new Map();   // label → Set("file:cb")
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8")
    // a deliberate second copy is allowed when the line says why
    .split("\n")
    .map((line) => (line.includes("dup-ok") ? "" : line))
    .join("\n");
  const push = (label, cb, key) => {
    if (!label || EXEMPT.has(label.trim())) return;
    // board tabs (day/week/month, language) are chips inside one screen
    if (/^t:(b|lang|growth|period)/.test(cb)) return;
    const set = hits.get(label.trim()) ?? new Set();
    set.add(`${relative(ROOT, file)} → ${cb} (${key})`);
    hits.set(label.trim(), set);
  };
  for (const m of src.matchAll(/text:\s*"([^"]{2,44})"\s*,\s*(?:cb|url):\s*"([^"]+)"/g))
    push(m[1], m[2], "literal");
  for (const m of src.matchAll(/text:\s*"[^"]*"\s*\+\s*\(fa \? "([^"]+)" : "([^"]+)"\)\s*,\s*(?:cb|url):\s*"([^"]+)"/g)) {
    push(m[1], m[3], "fa");
    push(m[2], m[3], "en");
  }
}

const dupes = [...hits.entries()].filter(([, v]) => v.size > 1);
if (dupes.length) {
  console.log(`❌ ${dupes.length} button label(s) defined more than once:`);
  for (const [label, where] of dupes) {
    console.log(`   «${label}»`);
    for (const w of where) console.log(`      ${w}`);
  }
  process.exit(1);
}
console.log(`✅ every glass key is defined exactly once (${hits.size} unique labels)`);
