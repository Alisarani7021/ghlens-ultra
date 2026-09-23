import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { setMode, clearMode } from "../core/mode";
import { publish } from "../hub/bus";
import {
  describeDag, planMission, savePlan, type MissionPlan,
} from "../hub/mission";
import { PLAYBOOKS, playbook } from "../hub/playbooks";
import {
  getWorkflow, listWorkflows, runWorkflow, saveWorkflow, loadConnectorConfig,
  type Workflow,
} from "../hub/engine";
import { CONNECTORS, connector, connectorKinds } from "../hub/connectors";
import { recentEvents, markEvent } from "../hub/event";
import * as CG from "../hub/content";
import { hubId } from "../hub/event";

/**
 *  The Hub OS console — the face of the bus, the connectors and the workflows.
 *
 *  Three screens carry the whole platform:
 *    • missions  — say what you want; get a workflow
 *    • connectors— wire the outside world in
 *    • graph     — see what you have made and where it came from
 *
 *  Everything is reachable from one place on purpose: a control plane with a
 *  treasure map is not a control plane.
 */
export class HubOS {
  // ── home ────────────────────────────────────────────────────────────────
  async home(h: H) {
    const fa = h.loc === "fa";
    const owner = h.u.id;
    const [wfs, conns, review] = await Promise.all([
      listWorkflows(h.env, owner),
      this.connectorRows(h),
      CG.queueForReview(h.env, owner, 5),
    ]);
    const live = wfs.filter((w) => w.enabled).length;
    const wired = conns.filter((c) => c.enabled).length;

    const text = fa
      ? `🌌 <b>هاب جهانی — هستهٔ اتوماسیون</b>\n\n` +
        `<blockquote>هر اتفاقی که در دنیای بیرون می‌افتد به یک <b>رویداد</b> تبدیل می‌شود، ` +
        `هر ورک‌فلو به آن واکنش می‌دهد، و هر چیزی که ساخته می‌شود <b>منبع و نسبش</b> ثبت می‌شود.</blockquote>\n\n` +
        `<b>وضعیت زنده</b>\n` +
        `• 🔌 کانکتور فعال: <b>${wired}</b> از ${conns.length}\n` +
        `• ⚙️ ورک‌فلو فعال: <b>${live}</b> از ${wfs.length}\n` +
        `• 🕹 در انتظار تأیید تو: <b>${review.length}</b>`
      : `🌌 <b>Universal Hub — automation core</b>\n\n` +
        `<blockquote>Everything that happens outside becomes an <b>event</b>; every workflow reacts; ` +
        `everything produced keeps its <b>lineage</b>.</blockquote>\n\n` +
        `• 🔌 connectors: <b>${wired}</b>/${conns.length} · ⚙️ workflows: <b>${live}</b>/${wfs.length} · 🕹 awaiting you: <b>${review.length}</b>`;

    return h.reply(
      text,
      kb(
        [
          { text: fa ? "🧪 مأموریت تازه (با جمله بگو)" : "🧪 New mission", cb: "hos:mission" },
          { text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" },
        ],
        [
          { text: fa ? "🎯 رویدادها" : "🎯 Events", cb: "hos:events" },
          { text: fa ? "🕹 صف تأیید" : "🕹 Approval queue", cb: "hos:queue" },
        ],
        [
          { text: fa ? "🔌 کانکتورها" : "🔌 Connectors", cb: "hos:conn" },
          { text: fa ? "⚙️ ورک‌فلوها" : "⚙️ Workflows", cb: "hos:wf" },
        ],
        [
          { text: fa ? "🕸 گراف محتوا" : "🕸 Content graph", cb: "hos:graph" },
          { text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" },
        ],
      ),
      !!h.cbId,
    );
  }

  // ── connectors ──────────────────────────────────────────────────────────
  async connectorRows(h: H): Promise<Array<{ id: string; kind: string; label: string; enabled: number; status: string; detail?: string; cursor?: string }>> {
    const { results } = await h.env.DB.prepare(
      `SELECT id, kind, label, enabled, status, detail, cursor FROM hub_connectors WHERE owner_id=? ORDER BY created_at DESC LIMIT 20`,
    ).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] }));
    return (results ?? []) as any[];
  }

  async connectors(h: H) {
    const fa = h.loc === "fa";
    const rows = await this.connectorRows(h);
    const lines = rows.length
      ? rows.map((r) => {
          const c = connector(r.kind);
          const dot = !r.enabled ? "⚪️" : r.status === "ok" ? "🟢" : r.status === "error" ? "🔴" : "🟡";
          return `${dot} <b>${tgEscape(c?.label ?? r.kind)}</b> — ${tgEscape(r.label || "—")}\n   <code>${r.id.slice(-6)}</code>${r.detail ? ` · ${tgEscape(String(r.detail).slice(0, 70))}` : ""}`;
        }).join("\n\n")
      : (fa ? "<i>هنوز کانکتوری وصل نیست.</i>" : "<i>No connectors yet.</i>");

    return h.reply(
      (fa
        ? `🔌 <b>کانکتورها</b>\n\n<blockquote>هر سرویس بیرونی یک آداپتور دارد: تست می‌شود، رویداد می‌فرستد، و دستور می‌گیرد.</blockquote>\n\n`
        : `🔌 <b>Connectors</b>\n\n`) + lines,
      kb(
        ...connectorKinds().map((k) => [{ text: `➕ ${CONNECTORS[k].label}`, cb: `hos:connadd:${k}` }]),
        rows.length ? [{ text: fa ? "🧪 تست همه" : "🧪 Test all", cb: "hos:conntest:all" }] : [],
        [{ text: fa ? "🧪 رویداد آزمایشی بفرست" : "🧪 Fire a test event", cb: "hos:selftest" }],
      ),
      !!h.cbId,
    );
  }

  async connectorAddPrompt(h: H, kind: string) {
    const fa = h.loc === "fa";
    const c = connector(kind);
    if (!c) return h.toast("?");
    await setMode(h.session, "hos:conn:add", { kind });
    return h.tg.sendMessage(
      h.chatId,
      (fa
        ? `🔌 <b>افزودن کانکتور ${tgEscape(c.label)}</b>\n\n<blockquote>تنظیمات این کانکتور:\n<code>${tgEscape(c.configHint)}</code></blockquote>\n\n` +
          `مقادیر را در یک خط و با کاما بنویس. مثال:\n`
        : `🔌 <b>Add ${c.label} connector</b>\n\n<code>${tgEscape(c.configHint)}</code>\n\n`) +
        (kind === "github"
          ? `<code>cloudflare/workers-sdk, oven-sh/bun</code>`
          : kind === "rss"
            ? `<code>https://blog.cloudflare.com/rss/</code>`
            : `<code>https://api.github.com/repos/oven-sh/bun/releases/latest</code>`),
      { parse_mode: "HTML", reply_markup: kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:conn" }]]) as any },
    );
  }

  async connectorAdd(h: H, kind: string, input: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    const c = connector(kind);
    if (!c) return h.toast("?");
    const parts = input.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const config: Record<string, any> = {};
    if (kind === "github") config.repos = parts.map((p) => p.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "")).slice(0, 25);
    else if (kind === "rss" || kind === "http") config.url = parts[0] ?? "";
    const label = parts.length && kind === "github" ? `${config.repos.length} مخزن` : (config.url ?? "").slice(0, 60);

    const id = hubId("con");
    await h.env.DB.prepare(
      `INSERT INTO hub_connectors (id, owner_id, kind, label, config, enabled, status, created_at) VALUES (?,?,?,?,?,1,'new',?)`,
    ).bind(id, h.u.id, kind, label, JSON.stringify(config), Date.now())
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    // Test immediately — a connector that silently does nothing is worse than
    // one that says why it cannot work yet.
    const test = await c.test?.({ env: h.env, owner_id: h.u.id, config, cursor: null });
    await h.env.DB.prepare(`UPDATE hub_connectors SET status=?, detail=?, last_poll=? WHERE id=?`)
      .bind(test?.ok ? "ok" : "error", (test?.detail ?? "").slice(0, 200), Date.now(), id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    await h.tg.sendMessage(
      h.chatId,
      (fa ? `✅ کانکتور <b>${tgEscape(c.label)}</b> اضافه شد\n\n` : `✅ ${c.label} connector added\n\n`) +
        `${test?.ok ? "🟢" : "🔴"} ${tgEscape(test?.detail ?? "—")}`,
      { parse_mode: "HTML", reply_markup: kb([[{ text: fa ? "🧪 دریافت رویدادها الان" : "🧪 Poll now", cb: `hos:poll:${id}` }]]) as any },
    );
    return this.connectors(h);
  }

  async connectorTest(h: H, id: string) {
    const fa = h.loc === "fa";
    const rows = await this.connectorRows(h);
    const targets = id === "all" ? rows : rows.filter((r) => r.id === id);
    if (!targets.length) return h.toast(fa ? "کانکتوری نیست" : "none");
    const lines: string[] = [];
    for (const r of targets) {
      const c = connector(r.kind);
      let config: Record<string, any> = {};
      const cfgRow: any = await h.env.DB.prepare(`SELECT config FROM hub_connectors WHERE id=?`).bind(r.id).first().catch(() => null);
      try { config = JSON.parse(cfgRow?.config ?? "{}"); } catch { /* {} */ }
      const t = await c?.test?.({ env: h.env, owner_id: h.u.id, config, cursor: r.cursor ?? null });
      lines.push(`${t?.ok ? "🟢" : "🔴"} <b>${tgEscape(c?.label ?? r.kind)}</b> — ${tgEscape(t?.detail ?? "—")}`);
      await h.env.DB.prepare(`UPDATE hub_connectors SET status=?, detail=? WHERE id=?`)
        .bind(t?.ok ? "ok" : "error", (t?.detail ?? "").slice(0, 200), r.id)
        .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    return h.reply(`🧪 <b>${fa ? "نتیجهٔ تست" : "Test result"}</b>\n\n${lines.join("\n")}`, kb([[{ text: fa ? "◀️ کانکتورها" : "◀️ Connectors", cb: "hos:conn" }]]), !!h.cbId);
  }

  /**
   * Poll one connector and publish what it finds.
   *
   * This is the whole loop in one method — the same `publish()` the webhook
   * path uses, so a polled event and a pushed event are indistinguishable
   * downstream. That equivalence is what makes the bus worth having.
   */
  async connectorPoll(h: H, id: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "📡 در حال خواندن از منبع…" : "Polling…");
    const row = await h.env.DB.prepare(`SELECT * FROM hub_connectors WHERE id=? AND owner_id=?`).bind(id, h.u.id).first<any>().catch(() => null);
    if (!row) return h.toast("?");
    const c = connector(row.kind);
    if (!c?.poll) return h.toast(fa ? "این کانکتور خواندنی نیست" : "not pollable");

    let config: Record<string, any> = {};
    try { config = JSON.parse(row.config ?? "{}"); } catch { /* {} */ }

    let res;
    try {
      res = await c.poll({ env: h.env, owner_id: h.u.id, config, cursor: row.cursor ?? null });
    } catch (e: any) {
      await h.env.DB.prepare(`UPDATE hub_connectors SET status='error', detail=?, last_poll=? WHERE id=?`)
        .bind(String(e?.message ?? e).slice(0, 200), Date.now(), id)
        .run().catch((er: any) => console.error("lens-swallowed", String(er?.message ?? er)));
      return h.reply(`🔴 <b>${fa ? "خطای خواندن" : "Poll failed"}</b>\n<code>${tgEscape(String(e?.message ?? e).slice(0, 200))}</code>`, kb([[{ text: fa ? "◀️ کانکتورها" : "◀️ Connectors", cb: "hos:conn" }]]), !!h.cbId);
    }

    let accepted = 0, dupes = 0, runs = 0;
    const outcomes: string[] = [];
    for (const ev of res.events.slice(0, 10)) {
      const r = await publish({ env: h.env, ai: h.ai }, { ...ev, owner_id: h.u.id });
      if (r.duplicate) dupes++;
      else { accepted++; runs += r.runs.length; }
      if (!r.duplicate && r.runs[0]) outcomes.push(`• <code>${tgEscape(ev.type)}</code> → ${r.runs[0].state === "waiting" ? "🕹 منتظر تأیید" : r.runs[0].state === "ok" ? "✅ اجرا شد" : "❌ خطا"}`);
    }

    await h.env.DB.prepare(`UPDATE hub_connectors SET status='ok', detail=?, last_poll=?, cursor=? WHERE id=?`)
      .bind(`${res.events.length} event(s)`, Date.now(), res.cursor ?? row.cursor ?? null, id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    return h.reply(
      `📡 <b>${tgEscape(c.label)}</b>\n\n` +
        (fa
          ? `• رویداد تازه: <b>${accepted}</b>\n• تکراری (نادیده گرفته شد): <b>${dupes}</b>\n• ورک‌فلو اجراشده: <b>${runs}</b>`
          : `• new: <b>${accepted}</b> · duplicates: <b>${dupes}</b> · runs: <b>${runs}</b>`) +
        (outcomes.length ? `\n\n${outcomes.slice(0, 5).join("\n")}` : ""),
      kb(
        [{ text: fa ? "🔁 خواندن دوباره" : "🔁 Poll again", cb: `hos:poll:${id}` }],
        [{ text: fa ? "🎯 رویدادها" : "🎯 Events", cb: "hos:events" }, { text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" }],
      ),
      !!h.cbId,
    );
  }

  // ── playbooks ───────────────────────────────────────────────────────────
  async books(h: H) {
    const fa = h.loc === "fa";
    const body = PLAYBOOKS.map((p) => `🧩 <b>${tgEscape(p.name)}</b>\n   <i>${tgEscape(p.needs)}</i>`).join("\n\n");
    return h.reply(
      (fa ? `📚 <b>ورک‌فلوهای آماده</b>\n\n<blockquote>یک ضربه نصب می‌شود و از همان لحظه روی رویدادها فعال است.</blockquote>\n\n` : "") + body,
      kb(
        ...PLAYBOOKS.map((p) => [{ text: `⬇️ ${p.name}`, cb: `hos:book:${p.key}` }]),
        [{ text: fa ? "🧪 مأموریت سفارشی" : "🧪 Custom mission", cb: "hos:mission" }],
      ),
      !!h.cbId,
    );
  }

  async installBook(h: H, key: string) {
    const fa = h.loc === "fa";
    const p = playbook(key);
    if (!p) return h.toast("?");
    const id = await saveWorkflow(h.env, {
      owner_id: h.u.id, name: p.name, mission: p.mission,
      dag: p.dag, on_event: p.on_event, enabled: 1,
    });
    return h.reply(
      `✅ <b>${tgEscape(p.name)}</b>\n\n` +
        (fa ? `روی <code>${tgEscape(p.on_event)}</code> فعال شد.\n\nپیش‌نیاز: ${tgEscape(p.needs)}` : `Armed on <code>${p.on_event}</code>`),
      kb(
        [{ text: fa ? "🧪 اجرای آزمایشی" : "🧪 Dry run", cb: `hos:wfrun:${id}` }],
        [{ text: fa ? "⚙️ ورک‌فلوها" : "⚙️ Workflows", cb: "hos:wf" }],
      ),
      !!h.cbId,
    );
  }

  // ── mission ─────────────────────────────────────────────────────────────
  async missionPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "hos:mission");
    return h.tg.sendMessage(
      h.chatId,
      fa
        ? `🧪 <b>مأموریت تازه</b>\n\n` +
          `<blockquote>هدف را با جملهٔ خودت بنویس. سیستم آن را به یک ورک‌فلو (DAG) ترجمه می‌کند.</blockquote>\n\n` +
          `<b>نمونه‌ها</b>\n` +
          `• «هر نسخهٔ جدید مخزن‌هایم را فارسی کن، کارت دانلود بساز و بعد از تأییدم در کانال بگذار»\n` +
          `• «هر آیتم تازهٔ این فید را خلاصه کن و برایم بفرست»\n` +
          `• «هر وقت نسخهٔ Bun عوض شد خبرم کن»`
        : `🧪 <b>New mission</b>\n\nDescribe the outcome you want and I'll compile it into a workflow.`,
      { parse_mode: "HTML", reply_markup: kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:home" }]]) as any },
    );
  }

  async compileMission(h: H, text: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    await h.loading(fa ? "🧠 در حال ترجمهٔ مأموریت به ورک‌فلو…" : "Compiling…");

    const plan: MissionPlan = await planMission(h.env, h.ai, h.u.id, text);
    const id = await savePlan(h.env, h.u.id, plan, text);

    const badge = plan.source === "ai" ? (fa ? "🧠 ساختهٔ AI" : "🧠 AI") : plan.source === "repaired" ? (fa ? "🔧 ساختهٔ AI (اصلاح‌شده)" : "🔧 repaired") : (fa ? "📚 برنامهٔ آماده" : "📚 playbook");

    return h.reply(
      `🧪 <b>${tgEscape(plan.name)}</b>  ·  ${badge}\n\n` +
        `<blockquote>${tgEscape(plan.notes || text.slice(0, 200))}</blockquote>\n\n` +
        `<b>${fa ? "نقشهٔ اجرا" : "Plan"}</b>\n<pre>${tgEscape(describeDag(plan))}</pre>\n` +
        (plan.on_event ? `\n🎯 ${fa ? "محرک" : "trigger"}: <code>${tgEscape(plan.on_event)}</code>` : `\n🎯 ${fa ? "اجرای دستی" : "manual"}`) +
        (plan.requires.length ? `\n🔌 ${fa ? "نیازمند" : "needs"}: ${tgEscape(plan.requires.join(" · "))}` : ""),
      kb(
        [{ text: fa ? "🧪 اجرای آزمایشی" : "🧪 Dry run", cb: `hos:wfrun:${id}` }],
        [{ text: fa ? "🧩 جزئیات گره‌ها" : "🧩 Nodes", cb: `hos:wfv:${id}` }],
        [{ text: fa ? "🗑 حذف" : "🗑 Delete", cb: `hos:wfdel:${id}` }],
      ),
      !!h.cbId,
    );
  }

  // ── workflows ───────────────────────────────────────────────────────────
  async workflows(h: H) {
    const fa = h.loc === "fa";
    const wfs = await listWorkflows(h.env, h.u.id);
    const body = wfs.length
      ? wfs.map((w) => {
          const steps = w.dag.nodes.length;
          return `${w.enabled ? "🟢" : "⚪️"} <b>${tgEscape(w.name)}</b>\n   ${steps} گره${w.on_event ? ` · روی <code>${tgEscape(w.on_event)}</code>` : " · دستی"} · ${w.runs} اجرا`;
        }).join("\n\n")
      : (fa ? "<i>هنوز ورک‌فلویی نساخته‌ای. از «برنامه‌های آماده» شروع کن.</i>" : "<i>No workflows yet.</i>");

    return h.reply(
      (fa ? `⚙️ <b>ورک‌فلوها</b>\n\n` : `⚙️ <b>Workflows</b>\n\n`) + body,
      kb(
        ...wfs.slice(0, 4).map((w) => [{ text: `▶️ ${w.name.slice(0, 34)}`, cb: `hos:wfrun:${w.id}` }]),
        [{ text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" }, { text: fa ? "🧪 مأموریت" : "🧪 Mission", cb: "hos:mission" }],
      ),
      !!h.cbId,
    );
  }

  async workflowView(h: H, id: string) {
    const fa = h.loc === "fa";
    const wf = await getWorkflow(h.env, id);
    if (!wf) return h.toast("?");
    const nodes = wf.dag.nodes.map((n) => {
      const cfg = n.cfg && Object.keys(n.cfg).length ? ` <code>${tgEscape(JSON.stringify(n.cfg).slice(0, 90))}</code>` : "";
      return `• <b>${n.kind}</b>${n.label ? ` — ${tgEscape(n.label)}` : ""}\n  <code>${n.id}</code> → ${(n.next ?? []).map((x) => `<code>${x}</code>`).join(", ") || "پایان"}${cfg}`;
    }).join("\n");
    return h.reply(
      `⚙️ <b>${tgEscape(wf.name)}</b>\n\n<pre>${tgEscape(describeDag({ nodes: wf.dag.nodes, entry: wf.dag.entry }))}</pre>\n\n<blockquote>${tgEscape(wf.mission || "—")}</blockquote>\n\n${nodes}`,
      kb(
        [{ text: fa ? "▶️ اجرا" : "▶️ Run", cb: `hos:wfrun:${id}` }],
        [{ text: wf.enabled ? (fa ? "⏸ غیرفعال" : "⏸ Disable") : (fa ? "▶️ فعال" : "▶️ Enable"), cb: `hos:wftog:${id}` }],
        [{ text: fa ? "🗑 حذف" : "🗑 Delete", cb: `hos:wfdel:${id}` }],
      ),
      !!h.cbId,
    );
  }

  async toggleWorkflow(h: H, id: string) {
    const wf = await getWorkflow(h.env, id);
    if (!wf) return h.toast("?");
    await h.env.DB.prepare(`UPDATE hub_workflows SET enabled=? WHERE id=?`).bind(wf.enabled ? 0 : 1, id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast(wf.enabled ? "⏸" : "▶️");
    return this.workflowView(h, id);
  }

  async deleteWorkflow(h: H, id: string) {
    await h.env.DB.prepare(`DELETE FROM hub_workflows WHERE id=? AND owner_id=?`).bind(id, h.u.id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast("🗑");
    return this.workflows(h);
  }

  /**
   * Run a workflow by hand.
   *
   * Dry runs are the reason missions are safe to try: a plan can be executed
   * against a *sample* event before any connector exists, so the owner sees
   * exactly what it produces without wiring anything up.
   */
  async runWorkflowById(h: H, id: string, eventOverride?: any) {
    const fa = h.loc === "fa";
    const wf = await getWorkflow(h.env, id);
    if (!wf) return h.toast("?");
    await h.loading(fa ? "⚙️ در حال اجرا…" : "Running…");

    const sample = eventOverride ?? sampleEventFor(wf.on_event, h.u.id);
    const res = await runWorkflow(
      { env: h.env, ai: h.ai, tg: h.tg, owner_id: h.u.id, trace: "tr_manual" + id.slice(-6), event: sample, autonomy: "manual" },
      wf, {},
    );

    const steps = res.steps.map((s) => `${s.ok ? "✅" : "❌"} <b>${tgEscape(s.kind)}</b> <i>${tgEscape(s.summary).slice(0, 70)}</i> · ${s.ms}ms`).join("\n");
    const published = res.bag.published ? `\n\n📤 ${fa ? "منتشر شد" : "published"}: <code>${tgEscape(JSON.stringify(res.bag.published))}</code>` : "";
    const gate = res.state === "waiting" ? `\n\n🕹 ${fa ? "منتظر تأیید تو در پیام بالا" : "awaiting your approval"}` : "";

    if (h.cbId) {
      return h.reply(
        `${res.state === "ok" ? "✅" : res.state === "waiting" ? "🕹" : "❌"} <b>${tgEscape(wf.name)}</b> — ${res.state}${gate}\n\n${steps}${published}`,
        kb(
          [{ text: fa ? "🔁 اجرای دوباره" : "🔁 Re-run", cb: `hos:wfrun:${id}` }],
          [{ text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" }, { text: fa ? "🧩 گره‌ها" : "🧩 Nodes", cb: `hos:wfv:${id}` }],
        ),
      );
    }
    return h.reply(`${res.state}\n\n${steps}`, kb([[{ text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" }]]));
  }

  // ── approvals ───────────────────────────────────────────────────────────
  async queue(h: H) {
    const fa = h.loc === "fa";
    const rows = await CG.queueForReview(h.env, h.u.id, 8);
    const body = rows.length
      ? rows.map((r) => {
          const dot = r.state === "stale" ? "🟠" : "🟡";
          return `${dot} <b>${tgEscape(r.title ?? r.kind)}</b> · ${r.kind}\n   <code>${r.id.slice(-8)}</code> · ${CG.dnaLine(r.dna)}`;
        }).join("\n\n")
      : (fa ? "<i>صف خالی است.</i>" : "<i>Queue empty.</i>");

    return h.reply(
      (fa ? `🕹 <b>صف تأیید</b>\n\n<blockquote>هیچ‌چیز بدون اجازهٔ تو از مرز بیرون رد نمی‌شود.</blockquote>\n\n` : "") + body,
      kb(
        ...rows.slice(0, 5).map((r) => [{ text: `👁 ${(r.title ?? r.kind).slice(0, 30)}`, cb: `hos:view:${r.id}` }]),
      ),
      !!h.cbId,
    );
  }

  async viewContent(h: H, id: string) {
    const fa = h.loc === "fa";
    const c = await CG.getContent(h.env, id);
    if (!c) return h.toast("?");
    const parents = await CG.parentsOf(h.env, id);
    const kids = await CG.childrenOf(h.env, id);
    const chain =
      (parents.length ? `⬆️ ${fa ? "از" : "from"}: ${parents.map((p) => `<code>${p.id.slice(-6)}</code>`).join(" ")}\n` : "") +
      (kids.length ? `⬇️ ${fa ? "ساخته‌شده" : "derived"}: ${kids.map((k) => `<code>${k.id.slice(-6)}</code>`).join(" ")}` : "");
    return h.reply(
      `${c.state === "published" ? "✅" : c.state === "stale" ? "🟠" : "🟡"} <b>${tgEscape(c.title ?? c.kind)}</b>\n` +
        `<i>${tgEscape(CG.dnaLine(c.dna))}</i>\n` +
        (chain ? `\n${chain}\n` : "") +
        `\n${(c.body ?? "").slice(0, 3000)}`,
      kb(
        c.state !== "published"
          ? [{ text: fa ? "✅ تأیید و انتشار" : "✅ Approve & publish", cb: `hos:ok:${c.id}` }, { text: fa ? "🗑 رد" : "🗑 Reject", cb: `hos:no:${c.id}` }]
          : [{ text: fa ? "📊 عملکرد" : "📊 Performance", cb: "hos:graph" }],
        [{ text: fa ? "🕸 گراف" : "🕸 Graph", cb: "hos:graph" }, { text: fa ? "🕹 صف" : "🕹 Queue", cb: "hos:queue" }],
      ),
      !!h.cbId,
    );
  }

  async approve(h: H, contentId: string) {
    const fa = h.loc === "fa";
    const c = await CG.getContent(h.env, contentId);
    if (!c) return h.toast("?");
    const cfg = await loadConnectorConfig(h.env, h.u.id, "telegram");
    if (!cfg.channel) {
      await CG.setState(h.env, contentId, "approved");
      return h.reply(
        `⚠️ <b>${fa ? "کانالی وصل نیست" : "No channel"}</b>\n\n` +
          (fa ? `محتوا تأیید شد ولی برای انتشار باید اول کانال را در «کانکتورها» وصل کنی.` : ""),
        kb([[{ text: fa ? "🔌 کانکتورها" : "🔌 Connectors", cb: "hos:conn" }]]),
        !!h.cbId,
      );
    }
    const c2 = connector("telegram");
    try {
      const out = await c2?.act?.({ env: h.env, owner_id: h.u.id, config: cfg }, "publish", { text: c.body ?? "", channel: cfg.channel });
      await CG.markPublished(h.env, contentId, String(cfg.channel), Number(out?.message_id ?? 0));
      await h.toast(fa ? "✅ منتشر شد" : "✅ published");
      return this.viewContent(h, contentId);
    } catch (e: any) {
      return h.reply(`❌ <code>${tgEscape(String(e?.message ?? e).slice(0, 200))}</code>`, kb([[{ text: fa ? "🔁 تلاش دوباره" : "🔁 Retry", cb: `hos:ok:${contentId}` }]]), !!h.cbId);
    }
  }

  async reject(h: H, contentId: string) {
    await CG.setState(h.env, contentId, "blocked");
    await h.toast("🗑");
    return this.queue(h);
  }

  // ── graph & runs ────────────────────────────────────────────────────────
  async graph(h: H) {
    const fa = h.loc === "fa";
    const rows = await CG.recentContent(h.env, h.u.id, 10);
    if (!rows.length) {
      return h.reply(
        fa ? `🕸 <b>گراف محتوا</b>\n\n<i>هنوز چیزی ساخته نشده. یک برنامهٔ آماده نصب کن یا مأموریت بساز.</i>` : `🕸 empty`,
        kb([[{ text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" }]]),
        !!h.cbId,
      );
    }
    const lines: string[] = [];
    for (const r of rows.slice(0, 6)) {
      const kids = await CG.childrenOf(h.env, r.id);
      const dot = r.state === "published" ? "✅" : r.state === "stale" ? "🟠" : "🟡";
      lines.push(`${dot} <b>${tgEscape((r.title ?? r.kind).slice(0, 40))}</b>\n   <code>${r.id.slice(-8)}</code> · ${r.kind}${kids.length ? ` · ↳ ${kids.length}` : ""}`);
    }
    const stale = rows.filter((r) => r.state === "stale").length;
    return h.reply(
      `🕸 <b>${fa ? "گراف محتوا" : "Content graph"}</b>\n\n` +
        `<blockquote>${fa ? `هر گره می‌داند از کجا آمده و چه چیزی از آن ساخته شده.` : "Every node knows its parents and its children."}</blockquote>\n\n` +
        lines.join("\n\n") +
        (stale ? `\n\n🟠 <b>${stale}</b> ${fa ? "محتوا کهنه شده — منبعش عوض شده" : "stale"}` : ""),
      kb(
        ...rows.slice(0, 4).map((r) => [{ text: `👁 ${(r.title ?? r.kind).slice(0, 28)}`, cb: `hos:view:${r.id}` }]),
        [{ text: fa ? "🕹 صف تأیید" : "🕹 Queue", cb: "hos:queue" }],
      ),
      !!h.cbId,
    );
  }

  async events(h: H) {
    const fa = h.loc === "fa";
    const rows = await recentEvents(h.env, h.u.id, 10);
    const body = rows.length
      ? rows.map((e) => {
          const dot = e.handled ? "✅" : e.error ? "❌" : "🕐";
          const when = new Date(e.ts).toISOString().slice(11, 16);
          return `${dot} <code>${tgEscape(e.type)}</code>\n   ${tgEscape(String(e.source))} · ${when} UTC · <code>${e.trace.slice(-6)}</code>`;
        }).join("\n\n")
      : (fa ? "<i>هنوز رویدادی نیامده.</i>" : "<i>No events yet.</i>");
    return h.reply(`🎯 <b>${fa ? "رویدادها" : "Events"}</b>\n\n${body}`, kb([[{ text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" }]]), !!h.cbId);
  }

  async runs(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT id, wf_id, state, steps, started_at, error FROM hub_runs WHERE owner_id=? ORDER BY started_at DESC LIMIT 8`,
    ).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] }));
    const body = (results ?? []).length
      ? (results ?? []).map((r) => {
          let steps: any[] = [];
          try { steps = JSON.parse(r.steps ?? "[]"); } catch { /* [] */ }
          const dot = r.state === "ok" ? "✅" : r.state === "waiting" ? "🕹" : r.state === "failed" ? "❌" : "🕐";
          const last = steps[steps.length - 1];
          return `${dot} <code>${r.id.slice(-8)}</code> · ${steps.length} گره · ${new Date(r.started_at).toISOString().slice(11, 16)} UTC` +
            (last ? `\n   ↳ ${tgEscape(String(last.kind))}: ${tgEscape(String(last.summary).slice(0, 60))}` : "") +
            (r.error ? `\n   ⚠️ <code>${tgEscape(String(r.error).slice(0, 80))}</code>` : "");
        }).join("\n\n")
      : (fa ? "<i>اجرایی ثبت نشده.</i>" : "<i>No runs.</i>");
    return h.reply(`📊 <b>${fa ? "اجراها" : "Runs"}</b>\n\n${body}`, kb([[{ text: fa ? "🎯 رویدادها" : "🎯 Events", cb: "hos:events" }]]), !!h.cbId);
  }

  /**
   * Fire a synthetic event so the owner can watch the machine work before any
   * external service is wired up. Real payload shapes, sample data.
   */
  async selfTest(h: H) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🧪 ارسال رویداد آزمایشی…" : "Firing test event…");
    const ev = sampleEvent("github.release.published", h.u.id);
    const r = await publish({ env: h.env, ai: h.ai, tg: h.tg }, ev);
    const first = r.runs[0];
    return h.reply(
      r.duplicate
        ? `🔁 ${fa ? "این رویداد قبلاً پردازش شده بود (تست ایدمپوتنسی ✓)" : "duplicate ignored ✓"}`
        : `🧪 <b>${fa ? "رویداد آزمایشی" : "Test event"}</b>\n\n` +
          `<code>${tgEscape(ev.type)}</code>\n` +
          (first
            ? `\n${first.steps.map((s) => `${s.ok ? "✅" : "❌"} ${tgEscape(s.summary).slice(0, 70)}`).join("\n")}`
            : `\n<i>${fa ? "ورک‌فلویی روی این رویداد فعال نیست — از «برنامه‌های آماده» نصب کن." : "no workflow matches"}</i>`),
      kb(
        [{ text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" }, { text: fa ? "🎯 رویدادها" : "🎯 Events", cb: "hos:events" }],
      ),
      !!h.cbId,
    );
  }
}

/** A believable sample payload per trigger, used by dry runs and the tester. */
export function sampleEvent(type: string, ownerId?: number): any {
  const base = { id: hubId("evt"), ts: Date.now(), trace: "tr_sample" + Math.random().toString(36).slice(2, 8), owner_id: ownerId };
  if (type.startsWith("github.release")) {
    return {
      ...base, type: "github.release.published", source: "github",
      payload: {
        identity: "oven-sh/bun@v1.2.0", repo: "oven-sh/bun", tag: "v1.2.0", name: "Bun v1.2.0",
        url: "https://github.com/oven-sh/bun/releases/tag/v1.2.0",
        published_at: new Date().toISOString(),
        body: "### What's changed\n- Add `bun build --target=browser` for direct browser bundles\n- Fix a memory leak in `fetch()` when the response body was never read\n- 30% faster cold starts on Linux\n- Breaking: `Bun.serve()` now requires an explicit `port` option\n\n### Full changelog\nhttps://github.com/oven-sh/bun/compare/v1.1.0...v1.2.0",
        assets: [
          { name: "bun-darwin-aarch64.zip", size: 34_200_000, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/bun-darwin-aarch64.zip", downloads: 4210 },
          { name: "bun-darwin-x64.zip", size: 36_100_000, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/bun-darwin-x64.zip", downloads: 2100 },
          { name: "bun-linux-x64.zip", size: 33_400_000, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/bun-linux-x64.zip", downloads: 9800 },
          { name: "bun-linux-aarch64.zip", size: 32_800_000, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/bun-linux-aarch64.zip", downloads: 1400 },
          { name: "bun-windows-x64.zip", size: 35_900_000, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/bun-windows-x64.zip", downloads: 7700 },
          { name: "SHASUMS256.txt", size: 1200, url: "https://github.com/oven-sh/bun/releases/download/v1.2.0/SHASUMS256.txt" },
        ],
      },
    };
  }
  if (type.startsWith("rss")) {
    return {
      ...base, type: "rss.item.new", source: "rss",
      payload: {
        identity: `sample-${Date.now()}`, title: "Cloudflare opens its Workers runtime",
        link: "https://blog.cloudflare.com/workers-runtime-open-source/",
        summary: "The runtime that runs Workers is now open source under Apache 2.0, including the isolate scheduler and the fetch implementation.",
        feed: "https://blog.cloudflare.com/rss/",
      },
    };
  }
  return {
    ...base, type: "http.value.changed", source: "http",
    payload: { identity: `sample-${Date.now()}`, url: "https://api.github.com/repos/oven-sh/bun/releases/latest", value: "v1.2.0" },
  };
}

function sampleEventFor(onEvent: string, ownerId?: number): any {
  if (!onEvent) return undefined;
  if (onEvent.startsWith("rss")) return sampleEvent("rss.item.new", ownerId);
  if (onEvent.startsWith("http")) return sampleEvent("http.value.changed", ownerId);
  return sampleEvent("github.release.published", ownerId);
}

export const hubOS = new HubOS();

/** Re-exported for the cron drain, which polls connectors on a schedule. */
export async function pollDueConnectors(env: any, ai: any, tg: any, limit = 8) {
  // Only connectors whose last poll is stale enough to bother: polling every
  // 15-minute tick would spend the GitHub quota to rediscover the same release,
  // and the dedupe index would (correctly) throw all of it away.
  const cutoff = Date.now() - 10 * 60_000;
  const { results } = await env.DB.prepare(
    `SELECT * FROM hub_connectors
      WHERE enabled=1 AND kind IN ('github','rss','http') AND (last_poll IS NULL OR last_poll < ?)
      ORDER BY last_poll ASC LIMIT ?`,
  ).bind(cutoff, limit).all().catch(() => ({ results: [] as any[] }));
  let events = 0, runs = 0;
  for (const row of results ?? []) {
    const c = connector(row.kind);
    if (!c?.poll) continue;
    let config: Record<string, any> = {};
    try { config = JSON.parse(row.config ?? "{}"); } catch { /* {} */ }
    try {
      const res = await c.poll({ env, owner_id: row.owner_id, config, cursor: row.cursor ?? null });
      for (const ev of res.events.slice(0, 10)) {
        const r = await publish({ env, ai, tg }, { ...ev, owner_id: row.owner_id });
        if (!r.duplicate) { events++; runs += r.runs.length; }
      }
      await env.DB.prepare(`UPDATE hub_connectors SET status='ok', detail=?, last_poll=?, cursor=? WHERE id=?`)
        .bind(`${res.events.length} event(s)`, Date.now(), res.cursor ?? row.cursor ?? null, row.id)
        .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    } catch (e: any) {
      await env.DB.prepare(`UPDATE hub_connectors SET status='error', detail=?, last_poll=? WHERE id=?`)
        .bind(String(e?.message ?? e).slice(0, 200), Date.now(), row.id)
        .run().catch((er: any) => console.error("lens-swallowed", String(er?.message ?? er)));
    }
  }
  return { connectors: (results ?? []).length, events, runs };
}
