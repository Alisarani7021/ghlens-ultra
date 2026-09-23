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

const scratch = mkdtempSync(join(tmpdir(), "ghlens-"));
const out = join(scratch, "devutils.mjs");
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


// ═══════════════════════════════════════════════════════════════════════════
//  Hub OS — the pure core (sanitiser, policy, mesh, graph, planner)
// ═══════════════════════════════════════════════════════════════════════════
// These are the parts that decide what gets published, so they get tested
// against the exact failures this project has already shipped once: a leaked
// `<details>` tag, a post published twice, an unapproved post going out.

const hubMods = {};
for (const name of ["editor", "policy", "mesh", "content", "event", "connectors", "mission", "engine"]) {
  const outFile = join(scratch, `hub_${name}.mjs`);
  execSync(`npx esbuild src/hub/${name}.ts --bundle --format=esm --platform=neutral --outfile=${outFile} --log-level=error`, { stdio: "inherit" });
  hubMods[name] = await import(outFile);
}
const ED = hubMods.editor, PO = hubMods.policy, ME = hubMods.mesh;
const CG = hubMods.content, EV = hubMods.event, CN = hubMods.connectors;
const MS = hubMods.mission, EN = hubMods.engine;

// ── the sanitiser: the bug that shipped to a real channel ─────────────────
{
  const md = "### What's changed\n- **Fix** a `fetch()` leak\n\n```sh\nbun install\n```";
  const html = ED.markdownToTelegramHtml(md);
  ok("md: heading → bold", /<b>What's changed<\/b>/.test(html));
  ok("md: bold kept", /<b>Fix<\/b>/.test(html));
  ok("md: inline code kept", /<code>fetch\(\)<\/code>/.test(html));
  ok("md: fence → pre/code", /<pre><code>bun install<\/code><\/pre>/.test(html));
  ok("md: no raw markdown asters", !/\*\*/.test(html));
}
{
  // The exact shape that leaked: literal <details><summary><strong> in a body.
  const raw = "<details><summary><strong>🐛 修复问题</strong></summary>\n- 修复缓存路径问题\n</details>";
  const html = ED.sanitizeHtml(ED.markdownToTelegramHtml(raw));
  ok("san: no <details> survives", !/<\/?details/i.test(html));
  ok("san: no <summary> survives", !/<\/?summary/i.test(html));
  ok("san: no <strong> survives", !/<\/?strong/i.test(html));
  ok("san: text inside is kept", /修复缓存路径问题/.test(html));
  ok("san: the bold was preserved as <b>", /<b>/.test(html));
}
{
  ok("san: script is removed with its body", !/alert/.test(ED.sanitizeHtml("<script>alert(1)</script>hi")));
  ok("san: onload attr cannot survive", !/onload/i.test(ED.sanitizeHtml('<b onload="x()">t</b>')));
  ok("san: javascript: href dropped", !/javascript/i.test(ED.sanitizeHtml('<a href="javascript:alert(1)">x</a>')));
  ok("san: https href kept", /<a href="https:\/\/x\.dev">x<\/a>/.test(ED.sanitizeHtml('<a href="https://x.dev">x</a>')));
  ok("san: unbalanced <b> is closed", /^<b>x<\/b>$/.test(ED.sanitizeHtml("<b>x")));
  ok("san: stray </b> is dropped", ED.sanitizeHtml("x</b>") === "x");
  ok("san: pre closes inline tags first", /<\/b><pre>/.test(ED.sanitizeHtml("<b>t<pre>c</pre>")));
}

// ── assets: the twelve-buttons problem ───────────────────────────────────
{
  const a = ED.classifyAsset({ name: "Clash.Verge_2.5.5_x64-setup.exe", size: 29_000_000, url: "u" });
  ok("asset: exe → windows", a?.platform === "windows");
  ok("asset: x64 detected", a?.arch === "x64");
  ok("asset: label is human", /ویندوز/.test(a?.label ?? "") && /۶۴/.test(a?.label ?? ""));
  const b = ED.classifyAsset({ name: "App_2.5.5_aarch64.dmg", size: 40_000_000, url: "u" });
  ok("asset: dmg → mac arm64", b?.platform === "mac" && b?.arch === "arm64");
  // darwin contains "win" — the regression that shipped macOS builds as Windows
  const d = ED.classifyAsset({ name: "bun-darwin-aarch64.zip", size: 34_000_000, url: "u" });
  ok("asset: darwin is mac, not windows", d?.platform === "mac");
  ok("asset: darwin arm64 detected", d?.arch === "arm64");
  const dl = ED.classifyAsset({ name: "bun-linux-x64.zip", size: 33_000_000, url: "u" });
  ok("asset: plain .zip with linux in the name → linux", dl?.platform === "linux");
  const dw = ED.classifyAsset({ name: "bun-windows-x64.zip", size: 35_000_000, url: "u" });
  ok("asset: windows in the name → windows", dw?.platform === "windows");
  {
    const grouped = ED.groupAssets([
      { name: "bun-darwin-aarch64.zip", size: 34_000_000, url: "u" },
      { name: "bun-linux-x64.zip", size: 33_000_000, url: "u" },
      { name: "bun-windows-x64.zip", size: 35_000_000, url: "u" },
    ]);
    eq("asset: one of each platform", grouped.map((g) => g.platform), ["mac", "linux", "windows"]);
  }
  ok("asset: signature filtered out", ED.classifyAsset({ name: "release.sig", size: 10, url: "u" }) === null);
  ok("asset: checksum file filtered out", ED.classifyAsset({ name: "SHASUMS256.txt", size: 900, url: "u" }) === null);
  ok("asset: blockmap filtered out", ED.classifyAsset({ name: "app.exe.blockmap", size: 900, url: "u" }) === null);

  const grouped = ED.groupAssets([
    { name: "x_windows_x64.zip", size: 30, url: "u" },
    { name: "x_aarch64.dmg", size: 40, url: "u" },
    { name: "x_amd64.deb", size: 20, url: "u" },
  ]);
  eq("asset: order is mac → linux → windows", grouped.map((g) => g.platform), ["mac", "linux", "windows"]);
  ok("asset: size formatting", ED.humanSize(29_000_000) === "27.7MB" && ED.humanSize(512) === "512B");
}

// ── the post ────────────────────────────────────────────────────────────
{
  const post = ED.composeReleasePost({
    repo: "hamedp-71/Hamed_Panel",
    tag: "v2.5.5",
    name: "v2.5.5",
    body: "## v2.5.5\n- 修复 Windows 服务启动问题\n- 修复 DNS 覆写\n\nFull Changelog: https://x",
    url: "https://github.com/hamedp-71/Hamed_Panel/releases/tag/v2.5.5",
    publishedAt: "2026-09-22T12:30:00Z",
    assets: [
      { name: "App_aarch64.dmg", size: 41_000_000, url: "https://a" },
      { name: "App_x64-setup.exe", size: 28_000_000, url: "https://b" },
      { name: "App_amd64.deb", size: 12_000_000, url: "https://c" },
      { name: "latest.yml", size: 100, url: "https://d" },
    ],
  });
  ok("post: has the release header", /نسخهٔ جدید منتشر شد/.test(post.text));
  ok("post: repo link present", /hamedp-71\/Hamed_Panel/.test(post.text));
  ok("post: three real assets, noise gone", post.assetCount === 3);
  ok("post: exactly 3 buttons", post.markup.inline_keyboard.length === 3);
  ok("post: every button is a url", post.markup.inline_keyboard.every((r) => !!r[0].url));
  ok("post: body is wrapped in a quote", /<blockquote>/.test(post.text));
  ok("post: no raw tags leaked", !/<\/?details|<\/?summary|<\/?strong/i.test(post.text));
  ok("post: no markdown pipes/tables", !/\|/.test(post.text));
  ok("post: tags are balanced",
    (post.text.match(/<blockquote>/g) ?? []).length === (post.text.match(/<\/blockquote>/g) ?? []).length);
  ok("post: changelog boilerplate trimmed", !/Full Changelog/i.test(post.text));
  ok("post: under Telegram's 4096 limit", post.text.length < 4096);
}
{
  // A model that ignores instructions and returns markdown must still be safe.
  const post = ED.composeReleasePost({
    repo: "a/b", tag: "v1", editorial: "**تازه**\n\n> یک نقل قول\n\n```js\nconst x=1\n```",
  });
  ok("post: editorial markdown converted", /<b>تازه<\/b>/.test(post.text));
  ok("post: blockquote merged", (post.text.match(/<blockquote>/g) ?? []).length === 1);
}

// ── the policy engine ───────────────────────────────────────────────────
{
  const ctx = { hasChannel: true, autonomy: "manual" };
  const dup = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r", duplicate: true, duplicateScore: 0.82 }, ctx);
  ok("policy: duplicate is blocked", dup.allow === false && dup.verdicts.some((v) => v.code === "duplicate"));
  ok("policy: the reason names the similarity", /82/.test(dup.summary));

  const noSrc = PO.evaluate({ destination: "channel", text: "x" }, ctx);
  ok("policy: no source is publishable only by hand", noSrc.allow === true && noSrc.require === "approval");
  const draftNoSrc = PO.evaluate({ destination: "draft", text: "x" }, { hasChannel: true });
  ok("policy: a draft with no source is fine", draftNoSrc.require === null);

  const noChannel = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r" }, { hasChannel: false });
  ok("policy: publishing without a channel is blocked", noChannel.allow === false);

  const manual = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r", confidence: 0.9 }, ctx);
  ok("policy: manual autonomy requires approval", manual.require === "approval");

  const auto = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r", confidence: 0.9 }, { hasChannel: true, autonomy: "auto" });
  ok("policy: auto autonomy publishes", auto.allow === true && auto.require === null);

  const low = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r", confidence: 0.5 }, ctx);
  ok("policy: low confidence still allowed but gated", low.allow === true && low.require === "approval");

  const stale = PO.evaluate({ destination: "channel", text: "x", sourceRef: "r", stale: true, confidence: 0.9 }, ctx);
  ok("policy: stale content is not published", stale.allow === false);
  ok("policy: every rule reports", stale.verdicts.length === PO.RULES.length);
}

// ── the mesh ────────────────────────────────────────────────────────────
{
  eq("mesh: code routes to the code tier first", ME.route("code", 3)[0], "code");
  eq("mesh: breadth 1 returns one tier", ME.route("compose", 1).length, 1);
  eq("mesh: breadth caps at the tier count", ME.route("compose", 9).length <= 3, true);
  ok("mesh: identical answers agree fully", ME.agreement("alpha beta gamma", "alpha beta gamma") === 1);
  ok("mesh: disjoint answers agree zero", ME.agreement("alpha beta gamma", "delta epsilon zeta") === 0);
  eq("mesh: empty agreement is not a crash", ME.agreement("", "x"), 0);
}

// ── the content graph ───────────────────────────────────────────────────
{
  const a = "Cloudflare released the Workers runtime as open source today under Apache 2.";
  eq("graph: identical text scores 1", CG.similarity(a, a), 1);
  ok("graph: unrelated text scores low", CG.similarity(a, "A recipe for sourdough bread with rye flour") < 0.1);
  ok("graph: near-duplicate is detected",
    CG.similarity("Cloudflare released the Workers runtime as open source today under Apache 2",
                  "Cloudflare released the Workers runtime as open source today under the Apache licence") > 0.4);
}

// ── events & routing ────────────────────────────────────────────────────
{
  ok("event: glob matches a child type", EV.matches("github.release.*", "github.release.published"));
  ok("event: glob rejects a sibling source", !EV.matches("github.release.*", "rss.item.new"));
  ok("event: star matches anything", EV.matches("*", "anything.at.all"));
  ok("event: exact match", EV.matches("rss.item.new", "rss.item.new"));
  ok("event: empty pattern matches nothing", !EV.matches("", "rss.item.new"));
  ok("event: ids are prefixed and unique", EV.hubId("evt") !== EV.hubId("evt") && EV.hubId("evt").startsWith("evt_"));
  const d1 = await EV.eventDedupe({ type: "github.release.published", source: "github", payload: { identity: "a/b@v1" } });
  const d2 = await EV.eventDedupe({ type: "github.release.published", source: "github", payload: { identity: "a/b@v1" } });
  const d3 = await EV.eventDedupe({ type: "github.release.published", source: "github", payload: { identity: "a/b@v2" } });
  ok("event: same release dedupes to one id", d1 === d2);
  ok("event: a different release does not", d1 !== d3);
}

// ── feeds ───────────────────────────────────────────────────────────────
{
  const xml = `<rss><channel>
    <item><title><![CDATA[Hello &amp; welcome]]></title><link>https://x.dev/1</link><guid>g1</guid><description>Body &lt;b&gt;text&lt;/b&gt;</description></item>
    <item><title>Second</title><link>https://x.dev/2</link><pubDate>Tue, 22 Sep 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = CN.parseFeed(xml, 5);
  eq("feed: two items parsed", items.length, 2);
  eq("feed: title unescaped", items[0].title, "Hello & welcome");
  eq("feed: guid used as identity", items[0].guid, "g1");
  eq("feed: link used when guid is missing", items[1].guid, "https://x.dev/2");
  ok("feed: html stripped from summary", !/<b>/.test(items[0].summary ?? ""));

  const atom = `<feed><entry><title>Atom entry</title><link href="https://y.dev/a"/><id>a1</id></entry></feed>`;
  const entries = CN.parseFeed(atom, 5);
  eq("feed: atom href read", entries[0].link, "https://y.dev/a");
  eq("feed: atom id used", entries[0].guid, "a1");
}

// ── the planner ─────────────────────────────────────────────────────────
{
  const plan = MS.repairPlan({
    name: "تست",
    on_event: "github.release.published",
    nodes: [
      { id: "a", kind: "ai", cfg: { prompt: "x" }, next: ["b"] },
      { id: "b", kind: "telegram_post", cfg: {}, next: [] },        // invented kind
      { id: "c", kind: "stop", cfg: {} },
    ],
  });
  ok("plan: repaired", plan?.repaired === true);
  ok("plan: invented kind mapped to a real one",
    plan?.nodes.every((n) => ["trigger","ai","compose.release","http","transform","condition","policy","content","approval","notify","connector","delay","stop"].includes(n.kind)));
  eq("plan: a trigger was hoisted to the front", plan?.nodes[0].kind, "trigger");
  ok("plan: a policy node was inserted before publishing", plan?.nodes.some((n) => n.kind === "policy"));
  ok("plan: the trigger feeds the chain", (plan?.nodes[0].next ?? []).length > 0);
  ok("plan: entry points at the trigger", plan?.entry === plan?.nodes[0].id);

  const empty = MS.repairPlan({ nodes: [] });
  eq("plan: an empty plan is rejected", empty, null);

  const mission = MS.bestPlaybook("هر نسخه جدید ریلیز شد در کانال منتشر کن");
  eq("plan: a release mission matches the release playbook", mission?.key, "release-to-channel");
  const feed = MS.bestPlaybook("هر آیتم تازه این فید RSS را خلاصه کن");
  eq("plan: a feed mission matches the rss playbook", feed?.key, "rss-digest");

  const dag = MS.describeDag({ entry: "in", nodes: [{ id: "in", kind: "trigger", next: ["a"] }, { id: "a", kind: "approval", next: [] }] });
  ok("plan: the dag renders as a tree", /🎯/.test(dag) && /🕹/.test(dag));
}

// ── the engine's small contract ─────────────────────────────────────────
{
  eq("engine: template interpolates", EN.render("repo={{event.payload.repo}}", { event: { payload: { repo: "a/b" } } }), "repo=a/b");
  eq("engine: missing paths render empty", EN.render("[{{event.payload.nope}}]", { event: { payload: {} } }), "[]");
  eq("engine: objects stringify", EN.render("{{x}}", { x: { a: 1 } }), '{"a":1}');
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
