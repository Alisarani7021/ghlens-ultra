/**
 * Pure-function self-test. Bundles the Worker sources with esbuild (already
 * present via wrangler) and asserts the algorithmic parts behave correctly.
 *
 *   node scripts/selftest.mjs
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "ghlens-")), "devutils.mjs");
execSync(`npx esbuild src/features/devutils.ts --bundle --format=esm --platform=neutral --outfile=${out} --log-level=error`, { stdio: "inherit" });

const mod = await import(out);
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `\n     got: ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok = (name, cond) => eq(name, !!cond, true);

// ── cron ────────────────────────────────────────────────────────────────
ok("cron: explain */15", /دقیقه/.test(mod.explainCron("*/15 * * * *", true)));
ok("cron: explain weekday", /دوشنبه/.test(mod.explainCron("0 9 * * 1", true)));
eq("cron: invalid rejected", mod.explainCron("* * * *", true), null);
{
  const runs = mod.nextRuns("0 6 * * *", 3);
  eq("cron: next runs length", runs.length, 3);
  ok("cron: runs are hourly=6 UTC", runs.every((d) => d.getUTCHours() === 6 && d.getUTCMinutes() === 0));
  ok("cron: strictly increasing", runs[0] < runs[1] && runs[1] < runs[2]);
}
{
  const runs = mod.nextRuns("*/15 * * * *", 4);
  ok("cron: 15-min steps", runs.every((d) => d.getUTCMinutes() % 15 === 0));
}

// ── CIDR ────────────────────────────────────────────────────────────────
{
  const r = mod.cidrCalc("192.168.1.10/24");
  ok("cidr: parsed", !!r);
  ok("cidr: network correct", /Network:\s+192\.168\.1\.0\/24/.test(r.table));
  ok("cidr: broadcast correct", /Broadcast:\s+192\.168\.1\.255/.test(r.table));
  ok("cidr: 254 usable hosts", /Usable hosts:\s+254/.test(r.table));
  ok("cidr: mask correct", /Netmask:\s+255\.255\.255\.0/.test(r.table));
  ok("cidr: private flagged", /PRIVATE/.test(r.table));
}
eq("cidr: invalid rejected", mod.cidrCalc("999.1.1.1/24"), null);
ok("cidr: bare ip becomes /32", /\b32\b/.test(mod.cidrCalc("8.8.8.8")?.table ?? ""));

// ── JSON stats ──────────────────────────────────────────────────────────
{
  const s = mod.jsonStats({ a: 1, b: [1, 2, { c: null }], d: "x" });
  eq("json: keys", s.keys, 4);
  eq("json: arrays", s.arrays, 1);
  eq("json: nulls", s.nulls, 1);
  eq("json: strings", s.strings, 1);
}

// ── IDs ─────────────────────────────────────────────────────────────────
ok("id: uuid-shaped", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(crypto.randomUUID()));
ok("id: ulid is 26 chars", mod.genUlid().length === 26);
ok("id: nanoid length", mod.genNano(21).length === 21);
ok("id: nanoid unique", mod.genNano(21) !== mod.genNano(21));

// ── colour ──────────────────────────────────────────────────────────────
{
  const hsl = mod.rgbToHsl(255, 0, 0);
  eq("color: pure red hue", Math.round(hsl.h), 0);
  eq("color: saturation 100", Math.round(hsl.s), 100);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
