/**
 * Live button/command audit.
 *
 * Walks every callback action and command the bot can serve, fires each one at
 * the deployed worker through /selfcheck (which captures outgoing Telegram
 * calls instead of sending them) and reports what actually came back.
 *
 *   node scripts/audit.mjs                       # against WORKER_URL in .secrets
 *   node scripts/audit.mjs --only "s:,m:"        # filter by namespace prefix
 *   node scripts/audit.mjs --json out.json       # also dump the raw report
 *
 * Exit code is 1 when something failed, so it can gate a deploy.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── config ────────────────────────────────────────────────────────────────
const arg = (name, def = "") => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1] ?? def;
};
function readSecrets() {
  const env = {};
  try {
    const txt = readFileSync(".secrets.local.sh", "utf8");
    for (const m of txt.matchAll(/export ([A-Z_0-9]+)='([^']*)'/g)) env[m[1]] = m[2];
  } catch { /* ignore */ }
  return env;
}
const S = readSecrets();
const URL_BASE = arg("--url", process.env.WORKER_URL || "https://ghlens-ultra.gitguts.workers.dev");
const SECRET = process.env.TG_HOOK_SECRET || S.TG_HOOK_SECRET;
const UID = Number(arg("--uid", "5982315292"));
if (!SECRET) {
  console.error("no TG_HOOK_SECRET — run `source .secrets.local.sh` first");
  process.exit(2);
}

// ── collect every callback target from the source ─────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && p !== "src/index.ts") files.push(p);
  }
})("src");

/**
 * Replace template-built callbacks with the exact syntax the router expects.
 *
 * Validated live (do not "simplify" these shapes — they were the source of a
 * whole round of false "dead button" readings):
 *   s:t:<idx>,<full>        d:go:<full>|<fmt>|<ref>      ai:tr:<full>
 *   r:card:<full>           n:q:<enc>                    t:b:0,<period>,<lang>
 */
function materialise(cb) {
  let out = cb.replace(/\$\{[^}]*\}/g, "").replace(/\{[^}]*\}/g, "");

  const RULES = [
    [/^s:t::?/, "s:t:0,vuejs/core"],
    [/^(s:(go|card|cmp)):$/, "$1:vuejs/core"],
    [/^d:(go|split):\|?/, "d:$1:vuejs/core|zip|main"],
    [/^d:(a7z|repo|link):$/, "d:$1:vuejs/core"],
    [/^ai:(tr|trpdf|repo):$/, "ai:$1:vuejs/core"],
    [/^ai:tre:$/, "ai:tre:vuejs/core:en"],
    [/^ai:trmore:$/, "ai:trmore:vuejs/core:1"],
    [/^ai:cmp:\|?$/, "ai:cmp:vuejs/core|facebook/react"],
    [/^r:(card|chart|files|share):$/, "r:$1:vuejs/core"],
    [/^r:cmpcard:\|?$/, "r:cmpcard:vuejs/core|facebook/react"],
    [/^c:repo:$/, "c:repo:vuejs/core"],
    [/^sec:repo:$/, "sec:repo:vuejs/core"],
    [/^f:(add|rm):$/, "f:$1:vuejs/core"],
    [/^sub:add:$/, "sub:add:vuejs/core"],
    [/^sub:add:.*:$/, "sub:add:vuejs/core:release"],
    [/^n:q:$/, "n:q:react"],
    [/^n:mode:sem:$/, "n:mode:sem:react hooks"],
    [/^n:advanced:$/, "n:advanced:language:go stars:>1000"],
    [/^n:filters:$/, "n:filters:stars:>1000"],
    [/^t:b::?,?/, "t:b:0"],
    [/^t:lang:$/, "t:lang:daily"],
    [/^b:c:$/, "b:c:ai"],
    [/^b:l:\d+,,/, "b:l:0,stars:>1000,stars"],
    [/^me:t:$/, "me:t:daily"],
    [/^dvu:regex:\|/, "dvu:regex:^v?(\\d+)$|v1.2.3"],
    [/^a:wf:$/, "a:wf:ci node with tests and cache on pull_request"],
    [/^a:repochat:$/, "a:repochat:vuejs/core"],
    [/^p:text:$/, "p:text:me"],
  ];
  for (const [re, to] of RULES) if (re.test(out)) { out = out.replace(re, to); break; }

  out = out
    .replace(/::+/g, ":")            // never two colons in a row
    .replace(/,\s*$/, "")
    .replace(/\|\s*$/, "")
    .replace(/:\s*$/, "");
  return out;
}

const found = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/cb:\s*[`"']([^`"']+)[`"']/g)) {
    const raw = m[1];
    if (raw.includes("${") && !/^[a-z]+:[a-z]+:\$\{/.test(raw)) continue; // template-built
    found.add(materialise(raw));
  }
}
// dynamic-but-important targets that never appear as literals
const extra = [
  "m:home", "h:main", "lang:menu", "lang:set:en", "lang:set:fa",
  "n:search", "t:menu", "t:growth:7", "t:growth:30", "t:new", "t:chart",
  "t:b:0,daily,all", "t:b:0,weekly,all", "t:b:0,monthly,all", "t:b:0,all,all", "t:lang:daily",
  "b:menu", "b:orgs", "b:time", "b:awesome", "b:users", "b:users:1",
  "s:home", "s:fromtrending", "s:go:vuejs/core", "s:t:0,vuejs/core", "s:t:5,vuejs/core", "s:t:11,vuejs/core",
  "d:home", "d:repo:vuejs/core", "d:recent", "d:trending", "d:favs", "d:link:vuejs/core",
  "a:home", "a:new", "a:clear", "a:workflow", "a:code", "a:review", "a:voice", "a:cont",
  "dvu:home", "dvu:id", "dvu:b64", "dvu:b64d",
  "me:home", "me:link", "me:unlink", "me:token", "me:interests", "me:board", "me:ref", "me:plan", "me:export",
  "p:today", "p:weekly", "sec:home", "adm:home", "noop:noop",
];
for (const e of extra) found.add(e);

const only = arg("--only");
let targets = [...found].sort();
if (only) targets = targets.filter((t) => only.split(",").some((p) => t.startsWith(p)));

// ── run them ──────────────────────────────────────────────────────────────
const FAIL_PATTERNS = [/^❌/m, /پیدا نشد یا دسترسی ندارم/, /Repo not found/, /Error:/, /\bNaN\b/, /undefined/];
const report = [];
let pass = 0, fail = 0, empty = 0;

console.log(`auditing ${targets.length} callback(s) against ${URL_BASE}\n`);
for (const cb of targets) {
  const url = `${URL_BASE}/selfcheck?deep=${SECRET}&uid=${UID}&cb=${encodeURIComponent(cb)}&capture=1`;
  let row;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const d = await res.json();
    const replies = (d.replies ?? []).map((r) => ({ m: r.m, text: (r.text ?? "").slice(0, 400) }));
    const body = replies.map((r) => r.text).join("\n");
    const bad = FAIL_PATTERNS.filter((p) => p.test(body)).map(String);
    const content = replies.filter((r) => r.m === "sendMessage" || r.m === "editMessageText" || r.m === "sendDocument")
      .filter((r) => (r.text ?? "").trim() || (r.kb ?? 0) > 0 || (r.doc ?? 0) > 0);
    const status = !d.ok ? "error" : bad.length ? "bad-text" : content.length ? "ok" : "silent";
    row = { cb, ms: d.ms, status, error: d.error, bad, logs: d.logs, replies: replies.map((r) => r.text.slice(0, 160)) };
  } catch (e) {
    row = { cb, status: "threw", error: String(e.message) };
  }
  report.push(row);
  const icon = row.status === "ok" ? "✅" : row.status === "silent" ? "⚪" : "❌";
  const detail = row.status === "ok" ? (row.replies[0] ?? "").replace(/\s+/g, " ").slice(0, 70)
    : row.status === "silent" ? "(no visible reply)"
    : (row.error ?? row.bad?.join(",") ?? "").slice(0, 90);
  console.log(`${icon} ${cb.padEnd(34)} ${String(row.ms ?? "").padStart(6)}ms  ${detail}`);
  if (row.status === "ok") pass++; else if (row.status === "silent") empty++; else fail++;
}

console.log(`\n${pass} ok · ${empty} silent · ${fail} failing  (of ${targets.length})`);
const out = arg("--json");
if (out) {
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`report → ${out}`);
}
process.exit(fail ? 1 : 0);
