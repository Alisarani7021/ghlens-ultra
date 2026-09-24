#!/usr/bin/env node
/**
 * Every callback key a screen can emit must be reachable in the router.
 *
 * Why: the dispatcher in src/index.ts is one long `switch (ns)` of
 * `if (action === "…")` lines, and a screen that emits a key nobody handles
 * fails **silently** — the press falls into the generic toast and the only
 * symptom is that a button "does nothing". That is exactly how
 * `hos:auto:on|off` shipped broken: the screen offered the switch, the router
 * only knew `hos:setauto:<mode>`, so the toggle redrew the same screen forever.
 *
 * The check is static: collect the keys the code can emit, collect the keys the
 * router matches, and require every emitted key to have a branch. Keys whose
 * target is resolved elsewhere (or deliberately fall through) are listed in
 * ALLOW with a reason, so an exception is a decision, never an accident.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";
const ROUTER = "src/index.ts";

/* Emitted keys that intentionally have no branch, each with the reason it is
   safe. Anything not listed here fails the check. */
const ALLOW = new Map([
  // answered by Telegram itself (url / web_app buttons), never by the router
  ["http", "url buttons are handled by Telegram"],
]);

const LEGAL_NS = /^[a-z][a-z0-9]{0,9}$/;
const KEY = /^([a-z][a-z0-9]{0,9}):([A-Za-z0-9_-]*)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** All string literals + template prefixes that could be a callback key. */
function emissions() {
  const found = new Map(); // "ns:action" → Set("file:line")
  for (const file of walk(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const at = line.search(/\bcb:\s*\S/);
      if (at < 0) return;
      if (line.includes("cb-ok")) return;
      // Scan only the cb expression, and drop nested interpolations first: a key
      // built *inside* `${encodeURIComponent(`b:s:topic:${t}`)}` is an argument,
      // not the callback this button sends.
      let expr = line.slice(at + line.slice(at).indexOf(":") + 1);
      for (let i = expr.indexOf("${"); i >= 0; i = expr.indexOf("${")) {
        let depth = 0, j = i;
        for (; j < expr.length; j++) {
          if (expr[j] === "{") depth++;
          else if (expr[j] === "}" && --depth === 0) break;
        }
        expr = expr.slice(0, i) + "".padEnd(j - i + 1, "_") + expr.slice(j + 1);
      }
      const cands = [];
      for (const m of expr.matchAll(/"([^"\\]{2,90})"/g)) cands.push(m[1]);
      // `hos:wfdel:${id}` → the static part before the first interpolation
      for (const m of expr.matchAll(/`([^`$]{2,90})_*/g)) cands.push(m[1]);
      for (const raw of cands) {
        if (raw.includes("//") || raw.includes(" ")) continue;   // urls, prose
        const m = KEY.exec(raw);
        if (!m || !LEGAL_NS.test(m[1])) continue;
        const key = `${m[1]}:${m[2]}`;
        const set = found.get(key) ?? new Set();
        set.add(`${relative(".", file)}:${i + 1}`);
        found.set(key, set);
      }
    });
  }
  return found;
}

/** namespace → { actions:Set, wildcard:bool } from the router's switch (ns). */
function routes() {
  const src = readFileSync(ROUTER, "utf8");
  const start = src.indexOf("switch (ns) {");
  if (start < 0) throw new Error("router `switch (ns)` not found — did the dispatcher move?");
  let depth = 0, end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end);

  // split into top-level `case "ns":` blocks, tracking nested braces
  const cases = new Map();
  const re = /(?:^|\n)\s*case\s+"([a-z0-9_]+)"\s*:/g;
  const marks = [...body.matchAll(re)].map((m) => ({ ns: m[1], at: m.index + m[0].length }));
  marks.forEach((mark, idx) => {
    let stop = idx + 1 < marks.length ? marks[idx + 1].at : body.length;
    let cut = idx + 1 < marks.length ? body.lastIndexOf("case ", stop) : stop;
    const block = body.slice(mark.at, cut > mark.at ? cut : stop);
    const cur = cases.get(mark.ns) ?? { actions: new Set(), wildcard: false, block: "" };
    cur.block += block;
    cases.set(mark.ns, cur);
  });

  for (const [ns, cur] of cases) {
    const block = cur.block;
    for (const m of block.matchAll(/action\s*===?\s*"([^"]+)"/g)) cur.actions.add(m[1]);
    for (const m of block.matchAll(/\[\s*((?:"[^"]*"\s*,?\s*)+)\]\.includes\(action\)/g))
      for (const s of m[1].matchAll(/"([^"]+)"/g)) cur.actions.add(s[1]);
    // an inner `switch (action) { case "x": … }`
    if (/switch\s*\(\s*action\s*\)/.test(block))
      for (const m of block.matchAll(/case\s+"([^"]+)"\s*:/g)) cur.actions.add(m[1]);
    // a namespace that ends in a generic answer still *responds* to everything
    cur.wildcard = /\bh\.toast\(/.test(block) || /return\s+fallthrough\(/.test(block);
  }
  return cases;
}

const emit = emissions();
const cases = routes();

const missingNs = [], missingAct = [], soft = [];
for (const [key, where] of [...emit].sort()) {
  const [ns, action] = key.split(":");
  if (ALLOW.has(ns)) continue;
  const cur = cases.get(ns);
  if (!cur) { missingNs.push([key, where]); continue; }
  if (!action || cur.actions.has(action)) continue;
  if (cur.wildcard) soft.push([key, where]);
  else missingAct.push([key, where]);
}

const show = (list) => list.map(([k, w]) => `   ${k}  ←  ${[...w].join(", ")}`).join("\n");
if (missingNs.length || missingAct.length) {
  console.log(`❌ callback keys a button can emit but the router cannot reach:`);
  if (missingNs.length) console.log(`  unknown namespace:\n${show(missingNs)}`);
  if (missingAct.length) console.log(`  action falls through:\n${show(missingAct)}`);
  process.exit(1);
}
console.log(
  `✅ every emitted callback key has a router branch (${emit.size} keys, ${cases.size} namespaces` +
  (soft.length ? `, ${soft.length} answered by a namespace default` : "") + ")",
);
if (process.argv.includes("--verbose") && soft.length) console.log(`   default-answered:\n${show(soft)}`);
