/**
 * Static SQL guard: every `prepare("… ? …")` must be followed by a `.bind(…)`
 * with exactly as many values as there are placeholders — a mismatch makes D1
 * throw "Wrong number of parameter bindings" and, because the data layer used
 * to swallow errors, the bug went unnoticed. This catches it at build time.
 *
 *   node scripts/sqlcheck.mjs        # exit 1 on any mismatch
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})("src");

/** Count top-level commas in an argument list (handles nested calls/objects). */
function countArgs(src) {
  const s = src.trim().replace(/,\s*$/, ""); // ignore a trailing comma
  if (!s) return 0;
  let depth = 0, args = 1, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) args++;
    else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
    }
    i++;
  }
  return args;
}

/** Extract the balanced argument list that starts right after an opening paren. */
/**
 * Remove `//` and `/* *​/` comments, respecting string literals.
 *
 * Added after a real miss: bind arguments annotated inline
 * (`id,  // the row id`) made the trailing comment look like an eleventh
 * argument, so a correct 12-value bind reported as a 13-value mismatch. The
 * fix is here rather than in the source because annotating a bind list one
 * value per line is the style that prevents the bug this script hunts.
 */
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i]; i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

function argsAfter(src, openIdx) {
  let depth = 0, i = openIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
    }
  }
  return src.slice(openIdx + 1);
}

const problems = [];
const dynamic = [];   // `.bind(...args)` — arity cannot be checked statically
let checked = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const re = /\.prepare\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(src))) {
    const sql = m[1].slice(1, -1);
    // placeholders: `?` outside of string literals in the SQL
    const sqlNoStrings = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const holders = (sqlNoStrings.match(/\?/g) || []).length;
    const after = src.slice(re.lastIndex); // unmetered: arg lists can be long
    const semi = after.indexOf(";");
    const bind = after.indexOf(".bind(");
    if (bind === -1 || (semi !== -1 && semi < bind)) continue; // bound elsewhere
    const args = stripComments(argsAfter(after, bind + ".bind".length));
    const spread = /\.\.\./.test(args);
    if (spread) {
      // Not checkable, but *not* silent. A spread bind hides exactly the bug
      // this script exists to catch (values drifting out of column order), so
      // every one is listed and counted rather than quietly skipped.
      const line = src.slice(0, m.index).split("\n").length;
      dynamic.push(`${file}:${line}`);
      continue;
    }
    const n = countArgs(args);
    checked++;
    if (n !== holders) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${file}:${line} — ${holders} placeholder(s) vs ${n} bind value(s)\n      ${sql.replace(/\s+/g, " ").slice(0, 130)}`);
    }
  }
}

console.log(`SQL guard: checked ${checked} prepared statement(s) across ${files.length} file(s)`);
if (dynamic.length) {
  console.log(`\n⚠️  ${dynamic.length} unverifiable spread bind(s) — column order is unchecked here:`);
  for (const d of dynamic) console.log("  " + d);
}
if (problems.length) {
  console.log(`\n❌ ${problems.length} mismatch(es):\n`);
  for (const p of problems) console.log("  " + p + "\n");
  process.exit(1);
}
console.log("✅ all placeholder counts match their bind() values");
