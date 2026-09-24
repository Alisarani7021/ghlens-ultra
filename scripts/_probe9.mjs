#!/usr/bin/env node
/** Batch /selfcheck probe: prints what a real press would show. */
const W = process.env.URL_BASE ?? "https://ghlens-ultra.gitguts.workers.dev";
const S = process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TG_HOOK_SECRET;
const UID = process.env.UID_BOT ?? "999999";

async function probe(label, params) {
  const q = new URLSearchParams({ deep: S, uid: UID, ...params });
  const t0 = Date.now();
  let d;
  try {
    d = await (await fetch(`${W}/selfcheck?${q}`, { signal: AbortSignal.timeout(120000) })).json();
  } catch (e) {
    console.log(`\n### ${label}\n   ✗ ${e.message}`);
    return;
  }
  console.log(`\n### ${label}   [${d.ms ?? "?"} ms]`);
  const vis = (d.replies ?? []).filter((r) => r.text || r.kb || r.doc || r.rich);
  for (const r of vis.slice(-3)) {
    const t = (r.text ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const head = r.rich ? `RICH(${r.rich_len}B rtl=${!!r.rtl}) ` : "";
    if (head || t) console.log(`   ${r.m}: ${head}${t.slice(0, 220)}`);
    if (r.doc) console.log(`      attachment: ${JSON.stringify(r.doc).slice(0, 90)}`);
    if (r.buttons?.length) console.log(`      keys: ${r.buttons.join(" | ").slice(0, 160)}`);
  }
  if (!vis.length) console.log(`   (no visible reply) ok=${d.ok} err=${d.error ?? ""}`);
}

const which = process.argv[2] ?? "all";
if (which === "1" || which === "all") {
  await probe("1) release post — the AI-written post itself", { cb: "hos:wf" });
  await probe("2) plans", { cb: "me:plan" });
  await probe("3) leaderboard", { cb: "me:board" });
}
if (which === "4" || which === "all") {
  await probe("4) custom repo wiring screen", { cb: "hos:wiring" });
  await probe("4b) workflows list", { cb: "hos:wf" });
}
if (which === "5" || which === "all") {
  await probe("5) gateway / integrations screen", { cb: "hos:integ" });
}
if (which === "7" || which === "all") {
  await probe("7) IP intel (real data?)", { text: "/ip 8.8.8.8" });
  await probe("7b) IP intel via callback", { cb: "u:ip" });
}
if (which === "8" || which === "all") {
  await probe("8a) AI analysis button", { cb: "ai:repo:anthropics/financial-services" });
  await probe("8b) download button", { cb: "d:repo:anthropics/financial-services" });
}
if (which === "9" || which === "all") {
  await probe("9a) architecture screen (rich?)", { cb: "ai:arch:anthropics/financial-services" });
  await probe("9b) README translate screen", { cb: "ai:tr:anthropics/financial-services" });
}
