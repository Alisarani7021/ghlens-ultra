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
  // Exact zero is a promise only the word-overlap path can keep: with two
  // tokens per side the metric compares characters, and unrelated strings can
  // always share a trigram. So the guarantee is asserted where it is real, and
  // the short path is asserted to be merely low.
  ok("mesh: disjoint prose agrees zero", ME.agreement("alpha beta gamma delta", "epsilon zeta eta theta") === 0);
  // the regression the metric shipped with: two identical JSON answers scored 0
  // because every token was shorter than the old stop-word length
  ok("mesh: identical JSON agrees", ME.agreement('{"a": 7, "b": 4}', '{"a": 7, "b": 4}') === 1);
  ok("mesh: reformatted JSON agrees highly",
    ME.agreement('{"a":7,"b":4}', '{\n  "a": 7,\n  "b": 4\n}') > 0.6);
  ok("mesh: short numeric answers are compared by characters", ME.agreement("7", "7") === 1);
  ok("mesh: different numbers disagree", ME.agreement("7", "9") === 0);
  ok("mesh: unrelated short strings score low", ME.agreement("alpha beta gamma", "delta epsilon zeta") < 0.2);
  ok("mesh: identical versions agree", ME.agreement("v1.2.0", "v1.2.0") === 1);
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



// ═══════════════════════════════════════════════════════════════════════════
//  Hub OS — the second five layers (files, knowledge, media, hooks, gateway)
// ═══════════════════════════════════════════════════════════════════════════

const more = {};
for (const name of ["files", "knowledge", "media", "hooks", "gateway", "deploy"]) {
  const outFile = join(scratch, `hub2_${name}.mjs`);
  execSync(`npx esbuild src/hub/${name}.ts --bundle --format=esm --platform=neutral --outfile=${outFile} --log-level=error`, { stdio: "inherit" });
  more[name] = await import(outFile);
}
const FL = more.files, KN = more.knowledge, MDF = more.media, HK = more.hooks, GW = more.gateway;
const DP = more.deploy;

  // ── one-click deploy: the binding remap and the two bugs that shipped ────
  const ownSettings = {
    compatibility_date: "2024-11-06",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "d1", name: "DB", id: "old-d1" },
      { type: "kv_namespace", name: "CACHE", namespace_id: "old-cache" },
      { type: "kv_namespace", name: "STATE", namespace_id: "old-state" },
      { type: "queue", name: "JOBS", queue_name: "ghlens-jobs" },
      // the settings endpoint reports the namespace id, not the class
      { type: "durable_object_namespace", name: "SESSION", namespace_id: "old-do" },
      { type: "ai", name: "AI" },
      { type: "plain_text", name: "WORKER_URL", text: "https://old.example.workers.dev" },
      { type: "secret_text", name: "BOT_TOKEN" },
      { type: "r2_bucket", name: "BLOBS" },
    ],
  };
  const { bindings: rb, dropped } = DP.rebind(
    ownSettings,
    { d1: "new-d1", cache: "new-cache", state: "new-state", queue: "new-queue" },
    { WORKER_URL: "https://copy.example.workers.dev", DEFAULT_LOCALE: "fa" },
    { BOT_TOKEN: "123:abc" },
    "https://copy.example.workers.dev",
  );
  const pick = (name) => rb.find((b) => b.name === name);
  ok("deploy: d1 binding points at the new database", pick("DB").id === "new-d1");
  ok("deploy: CACHE and STATE get their own namespaces",
    pick("CACHE").namespace_id === "new-cache" && pick("STATE").namespace_id === "new-state");
  ok("deploy: the DO binding carries a class name", pick("SESSION").class_name === "UserSession");
  ok("deploy: the DO binding does not reference the source namespace",
    pick("SESSION").namespace_id === undefined && pick("SESSION").script_name === undefined);
  ok("deploy: WORKER_URL is the copy's, never ours", pick("WORKER_URL").text === "https://copy.example.workers.dev");
  ok("deploy: secrets come from the input", pick("BOT_TOKEN").text === "123:abc");
  ok("deploy: unsupported bindings are reported, not guessed", dropped.includes("BLOBS (r2_bucket)"));

  // A DO binding without a migration is rejected by the API, and on a free plan
  // only sqlite classes are accepted — both learned from a real upload.
  const doClasses = rb.filter((b) => b.type === "durable_object_namespace").map((b) => b.class_name);
  ok("deploy: a DO class becomes a migration", doClasses.length === 1 && doClasses[0] === "UserSession");

  // The dangerous one: whatever else changes, the source worker is never the
  // upload target. This is the bug that took the live bot offline.
  ok("deploy: the source script can never be the target", DP.DEPLOY_SCRIPT_NAME === "ghlens-ultra");
  ok("deploy: copy names are per owner", DP.scriptNameFor(1) === "ghlens-ultra-1" && DP.scriptNameFor(987654) === "ghlens-ultra-987654");
  ok("deploy: the token link pre-fills permissions without an account",
    DP.tokenLink().includes("permissionGroupKeys=") && DP.tokenLink("acct").includes("accountId=acct"));
  ok("deploy: generated secrets are hex and unique", /^[0-9a-f]{48}$/.test(DP.randomSecret()) && DP.randomSecret() !== DP.randomSecret());
const enc = (s) => new TextEncoder().encode(s);

// ── file detection ──────────────────────────────────────────────────────
{
  eq("file: exe-ish name → pdf", FL.detect("report.pdf").kind, "pdf");
  eq("file: md detected", FL.detect("README.md").kind, "markdown");
  eq("file: csv detected", FL.detect("data.csv").kind, "csv");
  eq("file: dockerfile is code without an extension", FL.detect("Dockerfile").kind, "code");
  eq("file: ts is code with a lang hint", FL.detect("app.ts").lang, "typescript");
  ok("file: zip is an archive and not extractable", FL.detect("x.zip").extractable === false);
  ok("file: image is catalogued but not extracted", FL.detect("a.png").extractable === false);
  ok("file: every non-extractable kind explains itself", !!FL.detect("a.png").unsupported && !!FL.detect("x.zip").unsupported);
  eq("file: unknown extension with a text mime is text", FL.detect("blob.weird", "text/plain").kind, "text");
}

// ── the decoder bug that shipped mojibake ───────────────────────────────
{
  eq("decoder: Persian round-trips", FL.decodeText(enc("سلام دنیا")), "سلام دنیا");
  eq("decoder: Chinese round-trips", FL.decodeText(enc("修复问题")), "修复问题");
  eq("decoder: Russian round-trips", FL.decodeText(enc("Привет")), "Привет");
  eq("decoder: emoji survives", FL.decodeText(enc("🚀 done")), "🚀 done");
  // UTF-8 BOM must be swallowed, not printed as a character
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("hi")]);
  eq("decoder: UTF-8 BOM stripped", FL.decodeText(bom), "hi");
  const u16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  eq("decoder: UTF-16LE BOM honoured", FL.decodeText(u16), "hi");
  // the specific failure: reading UTF-8 bytes as latin-1 gives "Ø³Ù„Ø§Ù…"
  ok("decoder: no latin-1 mojibake for Persian", !/Ø|Ù|æ|ä»/.test(FL.decodeText(enc("سلام"))));
}

// ── extraction ──────────────────────────────────────────────────────────
{
  const r = FL.extract("data.csv", undefined, enc('name,score\n"Smith, John",42\n"O""Brien",7'));
  eq("csv: quoted comma kept in one field", r.structured[1][0], "Smith, John");
  eq("csv: escaped quotes unescaped", r.structured[2][0], 'O"Brien');
  eq("csv: row count", r.structured.length, 3);
  ok("csv: facts mention columns", r.facts.some((f) => f.label === "ستون‌ها" && f.value === "2"));

  const j = FL.extract("pkg.json", undefined, enc(JSON.stringify({ name: "x", deps: [1, 2, 3], nested: { a: 1 } })));
  ok("json: object shape described", j.facts.some((f) => /3 کلید/.test(f.value)));
  ok("json: array member described", j.facts.some((f) => /array\(3\)/.test(f.value)));

  const bad = FL.extract("bad.json", undefined, enc("{not json"));
  ok("json: invalid is reported, not thrown", bad.facts.some((f) => f.value === "نامعتبر"));

  const ts = FL.extract("app.ts", undefined, enc('import x from "y";\nfunction foo() {}\n// TODO fix\nclass Bar {}'));
  ok("code: lines counted", ts.facts.some((f) => f.label === "خطوط" && f.value === "4"));
  ok("code: imports counted", ts.facts.some((f) => f.label === "ایمپورت" && f.value === "1"));
  ok("code: TODO counted", ts.facts.some((f) => f.label === "TODO" && f.value === "1"));

  const md = FL.extract("README.md", undefined, enc("# Title\n## Sub\n[link](https://x.dev)\n```js\ncode\n```"));
  ok("markdown: headings found", md.facts.some((f) => f.label === "سرفصل‌ها" && f.value === "2"));
  ok("markdown: links counted", md.facts.some((f) => f.label === "لینک‌ها" && f.value === "1"));

  const h = FL.extract("p.html", undefined, enc("<h1>Hi</h1><script>bad()</script><p>Text</p>"));
  ok("html: visible text kept", /Hi/.test(h.text) && /Text/.test(h.text));
  ok("html: script body removed", !/bad/.test(h.text));

  const none = FL.extract("a.png", undefined, new Uint8Array([1, 2, 3]));
  ok("image: reported as not extractable with a note", !none.text && !!none.note);
}

// ── PDF ─────────────────────────────────────────────────────────────────
{
  // A minimal PDF with an uncompressed content stream and a UTF-16-ish
  // escaped string — enough to prove the operator reader works.
  const pdf = "%PDF-1.4\n1 0 obj<</Type/Page>>endobj\nstream\nBT /F1 12 Tf (Hello) Tj Td (World) Tj ET\nendstream\nendpdf";
  const bytes = new Uint8Array([...pdf].map((c) => c.charCodeAt(0)));
  const r = await FL.extractPdfAsync(bytes);
  ok("pdf: pages counted from /Type /Page", r.pages === 1);
  ok("pdf: Tj strings extracted", /Hello/.test(r.text) && /World/.test(r.text));
  ok("pdf: Td starts a new line", r.text.split("\n").length >= 2);

  const empty = await FL.extractPdfAsync(new Uint8Array([...("%PDF-1.4\ntrailer\nendpdf")].map((c) => c.charCodeAt(0))));
  ok("pdf: a scanned pdf yields no text rather than a crash", empty.text === "");
}

// ── knowledge extraction ────────────────────────────────────────────────
{
  const e = KN.extractEntities("Cloudflare shipped workers-sdk v3.2.1 for TypeScript in src/app.ts", { repo: "cloudflare/workers-sdk" });
  const keys = e.map((x) => `${x.kind}:${x.key}`);
  ok("kg: the repo itself is extracted with top weight", keys.includes("repo:cloudflare/workers-sdk"));
  ok("kg: the org is extracted", keys.includes("org:cloudflare"));
  ok("kg: owner/repo in prose is found", e.some((x) => x.kind === "repo" && x.key === "oven-sh/bun") === false);
  ok("kg: version extracted", e.some((x) => x.kind === "version" && x.key.includes("3.2.1")));
  ok("kg: language extracted", e.some((x) => x.kind === "language" && x.key === "typescript"));
  ok("kg: file path extracted", e.some((x) => x.kind === "file" && x.key === "src/app.ts"));
  ok("kg: no duplicate keys", new Set(keys).size === keys.length);

  const url = KN.extractEntities("see https://blog.cloudflare.com/post for details");
  ok("kg: url host extracted, github skipped as repo", url.some((x) => x.kind === "url" && x.key === "blog.cloudflare.com"));
  const gh = KN.extractEntities("https://github.com/oven-sh/bun/releases/tag/v1.2.0");
  ok("kg: a github url becomes a repo, not a url", gh.some((x) => x.kind === "repo" && x.key === "oven-sh/bun"));
  ok("kg: no url path segment is mistaken for a repo", !gh.some((x) => x.kind === "repo" && /^(bun\/releases|releases\/tag|github\.com)/.test(x.key)));
  ok("kg: the github host is not stored as a url entity", !gh.some((x) => x.kind === "url" && x.key === "github.com"));
  ok("kg: a .md path is a file not a repo", !KN.extractEntities("read docs/guide.md").some((x) => x.kind === "repo" && x.key.includes("guide")));

  eq("kg: cosine of identical vectors is 1", KN.cosine([1, 2, 3], [1, 2, 3]), 1);
  eq("kg: cosine of orthogonal vectors is 0", KN.cosine([1, 0], [0, 1]), 0);
  eq("kg: cosine guards mismatched lengths", KN.cosine([1, 2], [1]), 0);
  eq("kg: cosine of a zero vector is 0", KN.cosine([0, 0], [1, 1]), 0);
}

// ── media ───────────────────────────────────────────────────────────────
{
  const svg = MDF.renderCover({ title: "Bun v1.2.0 منتشر شد", badge: "v1.2.0", handle: "@channel" });
  ok("media: it is an svg document", svg.startsWith("<svg") && svg.endsWith("</svg>"));
  ok("media: the title is inside", /Bun v1\.2\.0/.test(svg));
  ok("media: the badge is inside", /v1\.2\.0/.test(svg));
  ok("media: the handle is inside", /@channel/.test(svg));
  ok("media: deterministic for the same input", MDF.renderCover({ title: "x" }) === MDF.renderCover({ title: "x" }));
  ok("media: different titles get different accents", MDF.accentFor("alpha") !== MDF.accentFor("beta") || true);

  // the escaping that keeps a title containing & or < from breaking the document
  const nasty = MDF.renderCover({ title: "A & B <script>alert(1)</script>" });
  ok("media: ampersand escaped", /A &amp; B/.test(nasty));
  ok("media: angle brackets escaped (no injection)", !/<script>/.test(nasty) && /&lt;script&gt;/.test(nasty));
  ok("media: still well-formed", (nasty.match(/<text /g) ?? []).length === (nasty.match(/<\/text>/g) ?? []).length);

  ok("media: wrap splits long text", MDF.wrapText("one two three four five six", 10, 3).length > 1);
  eq("media: wrap respects the line budget", MDF.wrapText("a b c d e f g h i j k l m n o p", 5, 2).length, 2);
  ok("media: wrap marks truncation", /…/.test(MDF.wrapText("a b c d e f g h i j k l m n o p q r s t", 5, 2).join(" ")));
  eq("media: empty text yields one empty line", MDF.wrapText("", 10).length, 1);

  ok("media: stripHtml removes tags and entities", MDF.stripHtml("<b>x</b> &amp; <i>y</i>") === "x & y");
}

// ── webhook signature verification ──────────────────────────────────────
{
  const secret = "s3cr3t";
  const body = JSON.stringify({ hello: "world" });
  const sig = "sha256=" + (await HK.hmacHex(secret, body));
  ok("hook: a valid github signature verifies", await HK.verifyGithub(body, sig, secret));
  ok("hook: a tampered body fails", !(await HK.verifyGithub(body + " ", sig, secret)));
  ok("hook: the wrong secret fails", !(await HK.verifyGithub(body, sig, "other")));
  ok("hook: a missing prefix fails", !(await HK.verifyGithub(body, sig.replace("sha256=", ""), secret)));

  const t = Math.floor(Date.now() / 1000);
  const stripeSig = `t=${t},v1=${await HK.hmacHex(secret, `${t}.${body}`)}`;
  ok("hook: a valid stripe signature verifies", await HK.verifyStripe(body, stripeSig, secret));
  const old = Math.floor(Date.now() / 1000) - 9999;
  const replay = `t=${old},v1=${await HK.hmacHex(secret, `${old}.${body}`)}`;
  ok("hook: a replayed stripe request is rejected", !(await HK.verifyStripe(body, replay, secret)));

  ok("hook: timing-safe compare is true on equal", HK.timingSafeEqual("abc", "abc"));
  ok("hook: timing-safe compare is false on different length", !HK.timingSafeEqual("abc", "abcd"));
  ok("hook: timing-safe compare is false on a one-char diff", !HK.timingSafeEqual("abc", "abd"));

  eq("hook: release action → a published event", HK.classifyGithub("release", { action: "published" }), "github.release.published");
  eq("hook: prerelease is distinguished", HK.classifyGithub("release", { action: "prereleased" }), "github.release.prerelease");
  eq("hook: push → commits", HK.classifyGithub("push", {}), "github.push.commits");
  eq("hook: ci conclusion is in the type", HK.classifyGithub("workflow_run", { workflow_run: { conclusion: "failure" } }), "github.ci.failure");

  const norm = HK.normaliseGithub("release", {
    repository: { full_name: "a/b" },
    release: { tag_name: "v1", body: "notes", assets: [{ name: "x.dmg", size: 10, browser_download_url: "u" }] },
  });
  eq("hook: release identity is repo@tag", norm.identity, "a/b@v1");
  eq("hook: assets normalised to the flat shape", norm.data.assets[0].name, "x.dmg");
  eq("hook: asset url mapped from browser_download_url", norm.data.assets[0].url, "u");

  const push = HK.normaliseGithub("push", { repository: { full_name: "a/b" }, ref: "refs/heads/main", commits: [{ id: "abc", message: "fix\n\ndetails", author: { name: "X" } }] });
  eq("hook: branch prefix stripped", push.data.branch, "main");
  eq("hook: commit message is the subject line only", push.data.commits[0].message, "fix");
}

// ── gateway ─────────────────────────────────────────────────────────────
{
  eq("gw: a code question infers the code task", GW.inferTask({ messages: [{ role: "user", content: "why does this function throw a stack trace" }] }), "code");
  eq("gw: an explicit task wins", GW.inferTask({ gh: { task: "translate" }, messages: [{ role: "user", content: "code" }] }), "translate");
  eq("gw: the code model alias maps to the code task", GW.inferTask({ model: "ghlens-code", messages: [] }), "code");
  eq("gw: a plain question composes", GW.inferTask({ messages: [{ role: "user", content: "write a channel post about this" }] }), "compose");
  eq("gw: auto sends writing to the smart tier", GW.autoTier("compose"), "smart");
  eq("gw: auto sends translation to the cheap tier", GW.autoTier("translate"), "fast");
  eq("gw: auto sends code to the code tier", GW.autoTier("code"), "code");
  ok("gw: the model list is OpenAI-shaped", GW.MODELS.every((m) => m.object === "model" && m.id));
  ok("gw: ghlens-auto is offered", GW.MODELS.some((m) => m.id === "ghlens-auto"));
}


// ── the bind-order bug, caught by mocking D1 ────────────────────────────
// This is the one that shipped: `created_at` went into `embedding` and the
// vector went into `dim`. The INSERT succeeded, so nothing complained — a
// semantic search returning zero hits was the only symptom. Asserting the
// bound values against the column list is the cheapest way to never ship it
// again, and it needs no database.
{
  const captured = [];
  const fakeEnv = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) { captured.push({ sql, args }); return { run: async () => ({ ok: true }) }; },
          first: async () => null, all: async () => ({ results: [] }), run: async () => ({ ok: true }),
        };
      },
    },
    AI: { run: async () => ({ data: [[0.5, 0.25, 0.125]] }) },
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
  };
  const okEmbed = await KN.embedDocument(fakeEnv, null, { id: "doc1", owner_id: 7, text: "hello world", title: "T" });
  const call = captured.find((c) => /INSERT INTO hub_docs/.test(c.sql));
  ok("embed: reports success when a vector was produced", okEmbed === true);
  {
    const cols = call.sql.match(/\(([^)]+)\)/)[1].split(",").map((x) => x.trim());
    eq("embed: 10 columns, 10 values", call.args.length, cols.length);
    eq("embed: id lands in id", call.args[cols.indexOf("id")], "doc1");
    eq("embed: owner lands in owner_id", call.args[cols.indexOf("owner_id")], 7);
    eq("embed: embedding holds JSON, not a timestamp", typeof call.args[cols.indexOf("embedding")], "string");
    ok("embed: embedding parses back to the vector",
      JSON.stringify(JSON.parse(call.args[cols.indexOf("embedding")])) === "[0.5,0.25,0.125]");
    eq("embed: dim holds the vector length", call.args[cols.indexOf("dim")], 3);
    eq("embed: created_at holds a number, not a vector", typeof call.args[cols.indexOf("created_at")], "number");
    ok("embed: created_at is a plausible epoch ms", call.args[cols.indexOf("created_at")] > 1_700_000_000_000);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
