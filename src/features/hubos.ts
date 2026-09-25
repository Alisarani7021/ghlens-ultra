import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { setMode, clearMode } from "../core/mode";
import { publish } from "../hub/bus";
import { readAutonomy, setAutonomy } from "../hub/policy";
import {
  describeDag, planMission, savePlan, installPlan, type MissionPlan,
} from "../hub/mission";
import { PLAYBOOKS, playbook } from "../hub/playbooks";
import {
  getWorkflow, listWorkflows, runWorkflow, saveWorkflow, loadConnectorConfig,
  type Workflow,
} from "../hub/engine";
import { CONNECTORS, configFor, connector, connectorKinds } from "../hub/connectors";
import { recentEvents, markEvent } from "../hub/event";
import * as CG from "../hub/content";
import * as KB from "../hub/knowledge";
import * as FU from "../hub/files";
import * as MD from "../hub/media";
import { resumeRun } from "../hub/engine";
import * as DP from "../hub/deploy";
import { D1_STATEMENTS } from "../hub/schema.gen";
import { hubId } from "../hub/event";
import { reposInMission, saveRepos, loadRepos, ensureGithubConnector, wiringReport, renderWiring, renderHookHelp } from "../hub/wiring";
import { MODELS } from "../hub/gateway";

function safeJson(s: any): any {
  try { return JSON.parse(String(s ?? "{}")); } catch { return {}; }
}

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

/**
 * Turn a typed line into a connector config — the way a person types it.
 *
 * `channel: "@my_channel" | "-100..."` is documentation, not syntax: the pipe
 * separates alternatives, the quotes are decoration, and `channel:`/`url:` is a
 * label people copy along with the value. All three were accepted by the hint
 * and rejected by the parser, which is how a working channel looked like a
 * missing one.
 *
 * For Telegram there is a second, better path: a message forwarded from the
 * channel already carries its id, so the owner never has to find `-100…`.
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
    const auto = (await readAutonomy(h.env, owner)) === "auto";

    const text = fa
      ? `🌌 <b>هاب جهانی — هستهٔ اتوماسیون</b>\n\n` +
        `<blockquote>هر اتفاقی که در دنیای بیرون می‌افتد به یک <b>رویداد</b> تبدیل می‌شود، ` +
        `هر ورک‌فلو به آن واکنش می‌دهد، و هر چیزی که ساخته می‌شود <b>منبع و نسبش</b> ثبت می‌شود.</blockquote>\n\n` +
        `<b>وضعیت زنده</b>\n` +
        `• 🔌 کانکتور فعال: <b>${wired}</b> از ${conns.length}\n` +
        `• ⚙️ ورک‌فلو فعال: <b>${live}</b> از ${wfs.length}\n` +
        `• 🕹 در انتظار تأیید تو: <b>${review.length}</b>\n` +
        `• ${auto ? "🔓" : "🔒"} انتشار: <b>${auto ? "خودکار، بدون تأیید" : "با تأیید تو"}</b>`
      : `🌌 <b>Universal Hub — automation core</b>\n\n` +
        `<blockquote>Everything that happens outside becomes an <b>event</b>; every workflow reacts; ` +
        `everything produced keeps its <b>lineage</b>.</blockquote>\n\n` +
        `• 🔌 connectors: <b>${wired}</b>/${conns.length} · ⚙️ workflows: <b>${live}</b>/${wfs.length} · 🕹 awaiting you: <b>${review.length}</b>\n` +
        `• ${auto ? "🔓" : "🔒"} publishing: <b>${auto ? "automatic" : "approval required"}</b>`;

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
        [
          { text: fa ? "🧠 دانش و جست‌وجوی معنایی" : "🧠 Knowledge & search", cb: "hos:know" },
          { text: fa ? "📚 کاوش موجودیت‌ها" : "📚 Entities", cb: "hos:ents" },
        ],
        [
          { text: fa ? "📄 کالبدشکافی فایل" : "📄 File dissection", cb: "hos:files" },
          { text: fa ? "🔌 وب‌هوک و گیت‌وی" : "🔌 Webhooks & gateway", cb: "hos:integ" },
        ],
        [
          { text: fa ? "🖼 کارخانهٔ رسانه" : "🖼 Media factory", cb: "hos:media" },
          { text: fa ? "📖 راهنما: از کجا چه کاری" : "📖 How to use", cb: "hos:guide" },
        ],
        [
          {
            text: auto
              ? (fa ? "🔓 انتشار خودکار: روشن" : "🔓 Auto-publish: on")
              : (fa ? "🔒 انتشار: با تأیید تو" : "🔒 Publishing: approval"),
            cb: "hos:auto",
          },
        ],
        [
          { text: fa ? "🚀 ساخت نمونهٔ شخصی (یک‌کلیکی)" : "🚀 Self-host a copy", cb: "hos:deploy" },
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
    // mirror the engine's rule: verified first, then newest
    const publishTargetId = [...rows]
      .filter((r) => r.kind === "telegram" && r.enabled)
      .sort((a, b) => (b.status === "ok" ? 1 : 0) - (a.status === "ok" ? 1 : 0))[0]?.id;
    const lines = rows.length
      ? rows.map((r) => {
          const c = connector(r.kind);
          const dot = !r.enabled ? "⚪️" : r.status === "ok" ? "🟢" : r.status === "error" ? "🔴" : "🟡";
          // Which connector a workflow would actually publish through is not
          // obvious when there are two of the same kind — so say it out loud.
          const target = r.id === publishTargetId ? `\n   🎯 ${fa ? "پست‌ها از این کانال منتشر می‌شوند" : "posts publish through this one"}` : "";
          return `${dot} <b>${tgEscape(c?.label ?? r.kind)}</b> — ${tgEscape(r.label || "—")}\n   <code>${r.id.slice(-6)}</code>${r.detail ? ` · ${tgEscape(String(r.detail).slice(0, 70))}` : ""}${target}`;
        }).join("\n\n")
      : (fa ? "<i>هنوز کانکتوری وصل نیست.</i>" : "<i>No connectors yet.</i>");

    /* Deleting a connector is a one-way door — a workflow that pointed at it
       silently stops receiving anything — so the row key opens a confirm card
       rather than removing it on the spot. */
    const delRows = rows.map((r) => [
      { text: `🗑 ${(r.label || r.kind).slice(0, 28)}`, cb: `hos:conndel:${r.id}` },
    ]);
    return h.reply(
      (fa
        ? `🔌 <b>کانکتورها</b>\n\n<blockquote>هر سرویس بیرونی یک آداپتور دارد: تست می‌شود، رویداد می‌فرستد، و دستور می‌گیرد.</blockquote>\n\n`
        : `🔌 <b>Connectors</b>\n\n`) + lines,
      kb(
        ...connectorKinds().map((k) => [{ text: `➕ ${CONNECTORS[k].label}`, cb: `hos:connadd:${k}` }]),
        rows.length ? [{ text: fa ? "🧪 تست همه" : "🧪 Test all", cb: "hos:conntest:all" }] : [],
        [{ text: fa ? "🧪 رویداد آزمایشی بفرست" : "🧪 Fire a test event", cb: "hos:selftest" }],
        ...delRows,
      ),
      !!h.cbId,
    );
  }

  /** «🗑 @iguts9» → "are you sure", because a connector is not a draft. */
  async connectorDeletePrompt(h: H, id: string) {
    const fa = h.loc === "fa";
    const row = await h.env.DB.prepare(
      `SELECT id, kind, label, config FROM hub_connectors WHERE id=? AND owner_id=?`,
    ).bind(id, h.u.id).first<any>().catch(() => null);
    if (!row) return h.toast(fa ? "پیدا نشد" : "not found");
    const c = connector(row.kind);
    let cfg: any = {};
    try { cfg = JSON.parse(row.config ?? "{}"); } catch { /* {} */ }
    const target = cfg.channel || cfg.url || (cfg.repos ?? []).join(", ") || "—";
    return h.reply(
      `🗑 <b>${fa ? "حذف کانکتور" : "Delete connector"}</b>\n\n` +
        `<blockquote>${tgEscape(c?.label ?? row.kind)} — <code>${tgEscape(String(target))}</code></blockquote>\n\n` +
        (fa
          ? "با حذف این کانکتور، ورک‌فلوهایی که به آن وصل بودند دیگر رویدادی نمی‌گیرند. می‌توانی بعداً از نو اضافه‌اش کنی."
          : "Workflows wired to it stop receiving events. You can add it again later."),
      kb(
        [{ text: fa ? "✅ بله، حذف کن" : "✅ Yes, delete", cb: `hos:conndel2:${id}` }],
        [{ text: fa ? "◀️ نگهش دار" : "◀️ Keep it", cb: "hos:conn" }],
      ),
      !!h.cbId,
    );
  }

  async deleteConnector(h: H, id: string) {
    const fa = h.loc === "fa";
    const row = await h.env.DB.prepare(`SELECT label FROM hub_connectors WHERE id=? AND owner_id=?`)
      .bind(id, h.u.id).first<any>().catch(() => null);
    await h.env.DB.prepare(`DELETE FROM hub_connectors WHERE id=? AND owner_id=?`).bind(id, h.u.id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast(fa ? "🗑 حذف شد" : "🗑 deleted", true);
    return this.connectors(h);
  }

  async connectorAddPrompt(h: H, kind: string) {
    const fa = h.loc === "fa";
    const c = connector(kind);
    if (!c) return h.toast("?");
    await setMode(h.session, "hos:conn:add", { kind });
    return h.reply(
      (kind === "telegram"
        ? (fa
          ? `🔌 <b>افزودن کانکتور تلگرام</b>\n\n` +
            `<blockquote>این کانکتور «منتشر می‌کند»: پست‌های هاب از اینجا به کانال می‌روند.</blockquote>\n\n` +
            `<b>راه اول (ساده‌تر):</b> یک پست از کانالت را همین‌جا <b>فوروارد</b> کن — آیدی کانال خودش خوانده می‌شود.\n\n` +
            `<b>راه دوم:</b> فقط این یک خط را بنویس:\n<code>channel: @your_channel</code>\n\n` +
            `<b>پیش‌نیاز:</b> ربات باید در آن کانال <b>ادمین</b> باشد (با اجازهٔ ارسال پیام). کانال خصوصی هم می‌شود: آیدی عددی مثل <code>-1001234567890</code>.`
          : `🔌 <b>Add the Telegram connector</b>\n\nForward any post from your channel, or send <code>channel: @your_channel</code>. The bot must be an admin there.`)
        : (fa
          ? `🔌 <b>افزودن کانکتور ${tgEscape(c.label)}</b>\n\n<blockquote>${tgEscape(c.configHint)}</blockquote>\n\n` +
            `فقط مقدار را در یک خط بنویس؛ برچسب و کوتیشن لازم نیست:\n`
          : `🔌 <b>Add ${c.label} connector</b>\n\n<code>${tgEscape(c.configHint)}</code>\n\n`) +
        (kind === "github"
          ? `<code>cloudflare/workers-sdk, oven-sh/bun</code>`
          : `<code>https://blog.cloudflare.com/rss/</code>`)),
      kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:conn" }]]) as any,
    );
  }

  async connectorAdd(h: H, kind: string, input: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    const c = connector(kind);
    if (!c) return h.toast("?");

    /* The owner typed the hint back at the bot — `channel: "@x" | "-100..."` —
       and the connector answered "کانال تنظیم نشده", because there was no
       telegram branch at all and the config stayed empty. Two lessons are baked
       into configFor(): the hint's `|` means "or" and its quotes are decoration,
       and a `key:` prefix is something people copy along with the value. */
    const config = configFor(kind, input, h.msg);
    const label = kind === "github" ? `${config.repos.length} مخزن`
      : (config.channel ? `${config.channel}` : (config.url ?? "")).slice(0, 60);

    const id = hubId("con");
    await h.env.DB.prepare(
      `INSERT INTO hub_connectors (id, owner_id, kind, label, config, enabled, status, created_at) VALUES (?,?,?,?,?,1,'new',?)`,
    ).bind(id, h.u.id, kind, label, JSON.stringify(config), Date.now())
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    // Test immediately — a connector that silently does nothing is worse than
    // one that says why it cannot work yet.
    const test = await c.test?.({ env: h.env, owner_id: h.u.id, config, cursor: null });
    // the label becomes the channel's real name, so the list reads
    // «🟢 ما می‌توانیم» instead of a username nobody recognises
    await h.env.DB.prepare(`UPDATE hub_connectors SET status=?, detail=?, label=COALESCE(?, label), last_poll=? WHERE id=?`)
      .bind(test?.ok ? "ok" : "error", (test?.detail ?? "").slice(0, 200), test?.title ?? null, Date.now(), id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    const hint = !test?.ok && kind === "telegram"
      ? (fa
        ? "\n\n👈 ربات را در کانال <b>ادمین</b> کن، بعد دوباره «➕ تلگرام» را بزن — یا یک پست از کانال را همین‌جا فوروارد کن."
        : "\n\nAdd the bot as an <b>admin</b> of the channel and retry, or forward a post from it here.")
      : "";
    await h.reply(
      (fa ? `✅ کانکتور <b>${tgEscape(c.label)}</b> اضافه شد\n\n` : `✅ ${c.label} connector added\n\n`) +
        `${test?.ok ? "🟢" : "🔴"} ${tgEscape(test?.detail ?? "—")}${hint}`,
      kb([[{ text: fa ? "🧪 دریافت رویدادها الان" : "🧪 Poll now", cb: `hos:poll:${id}` }]]) as any,
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
  /**
   * Publishing autonomy — the switch between «ask me» and «just do it».
   *
   * The policy engine always had the rule; what it lacked was a setting, so the
   * gate was permanent. This screen is that setting, stated in the owner's own
   * terms, with the consequences spelled out rather than implied.
   */
  async autonomy(h: H) {
    const fa = h.loc === "fa";
    const mode = await readAutonomy(h.env, h.u.id);
    const on = mode === "auto";
    const conns = await this.connectorRows(h);
    const chan = conns.find((c) => c.kind === "telegram" && c.enabled);
    const text = fa
      ? `🔓 <b>انتشار خودکار</b>\n\n` +
        `<blockquote>وقتی روشن باشد، ورک‌فلوها خودشان منتشر می‌کنند: رویداد می‌رسد، متن ساخته می‌شود، ` +
        `سیاست‌ها چک می‌شوند و پست بی‌پرسش می‌رود. وقتی خاموش باشد، هر پست اول به تو نشان داده می‌شود.</blockquote>\n\n` +
        `وضعیت الان: <b>${on ? "🔓 روشن — بدون تأیید منتشر می‌شود" : "🔒 خاموش — با تأیید تو"}</b>\n` +
        `مقصد: ${chan ? `«${tgEscape(chan.label || "@" + "")}»` : "❗️ کانالی وصل نیست"}\n\n` +
        `<b>هر دو حالت امن‌اند.</b> حتی در حالت خودکار، دروازهٔ قواعد قبل از انتشار کار می‌کند: ` +
        `محتوای تکراری، بدون منبع، یا با اطمینان پایین <b>مسدود یا برگشت داده می‌شود</b> و به تو گزارش می‌رسد. ` +
        `خودکار یعنی «بدون پرسیدن»، نه «بدون بررسی».`
      : `🔓 <b>Auto-publish</b>\n\nCurrently: <b>${on ? "ON — publishes without asking" : "OFF — asks you first"}</b>`;
    return h.reply(
      text,
      kb(
        on
          ? [{ text: fa ? "🔒 برگرد به حالت تأییدی" : "🔒 Back to approval", cb: "hos:auto:off" }]
          : [{ text: fa ? "🔓 روشن کن: بدون تأیید منتشر کن" : "🔓 Turn on auto-publish", cb: "hos:auto:on" }],
        [{ text: fa ? "🎯 رویدادها" : "Events", cb: "hos:events" }, { text: fa ? "🕹 صف تأیید" : "Queue", cb: "hos:queue" }],
      ),
      !!h.cbId,
    );
  }

  async setAutonomy(h: H, mode: "manual" | "auto") {
    const fa = h.loc === "fa";
    await setAutonomy(h.env, h.u.id, mode);
    await h.toast(
      mode === "auto"
        ? (fa ? "🔓 از این لحظه بدون تأیید منتشر می‌شود" : "🔓 auto-publish on")
        : (fa ? "🔒 دوباره با تأیید تو" : "🔒 approval required again"),
      true,
    );
    return this.autonomy(h);
  }

  async missionPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "hos:mission");
    return h.reply(
      fa
        ? `🧪 <b>مأموریت تازه</b>\n\n` +
          `<blockquote>هدف را با جملهٔ خودت بنویس. سیستم آن را به یک ورک‌فلو (DAG) ترجمه می‌کند.</blockquote>\n\n` +
          `<b>نمونه‌ها</b>\n` +
          `• «هر نسخهٔ جدید مخزن‌هایم را فارسی کن، کارت دانلود بساز و بعد از تأییدم در کانال بگذار»\n` +
          `• «هر آیتم تازهٔ این فید را خلاصه کن و برایم بفرست»\n` +
          `• «هر وقت نسخهٔ Bun عوض شد خبرم کن»`
        : `🧪 <b>New mission</b>\n\nDescribe the outcome you want and I'll compile it into a workflow.`,
      kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:home" }]]) as any,
    );
  }

  async compileMission(h: H, text: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    await h.loading(fa ? "🧠 در حال ترجمهٔ مأموریت به ورک‌فلو…" : "Compiling…");

    const plan: MissionPlan = await planMission(h.env, h.ai, h.u.id, text);

    /* A plan is not an installation. The repositories the mission talks about
       are extracted from the owner's own words, and installing the same mission
       again replaces its twin instead of piling up a second machine on the same
       event — three identical enabled workflows meant three posts per release. */
    const repos = reposInMission(text);
    const { id, replaced } = await installPlan(h.env, h.u.id, plan, text, repos);
    await saveRepos(h.env, id, repos);

    const badge = plan.source === "ai" ? (fa ? "🧠 ساختهٔ AI" : "🧠 AI") : plan.source === "repaired" ? (fa ? "🔧 ساختهٔ AI (اصلاح‌شده)" : "🔧 repaired") : (fa ? "📚 برنامهٔ آماده" : "📚 playbook");
    const twin = replaced
      ? `♻️ ${fa ? "نسخهٔ قبلی همین ورک‌فلو جایگزین شد (نه یکی دیگر روی همان رویداد)" : "replaced its twin"}\n\n`
      : "";

    return h.reply(
      twin +
      `🧪 <b>${tgEscape(plan.name)}</b>  ·  ${badge}\n\n` +
        `<blockquote>${tgEscape(plan.notes || text.slice(0, 200))}</blockquote>\n\n` +
        `<b>${fa ? "نقشهٔ اجرا" : "Plan"}</b>\n<pre>${tgEscape(describeDag(plan))}</pre>\n` +
        (plan.on_event ? `\n🎯 ${fa ? "محرک" : "trigger"}: <code>${tgEscape(plan.on_event)}</code>` : `\n🎯 ${fa ? "اجرای دستی" : "manual"}`),
      await this.wiringCard(h, id, repos, fa),
      !!h.cbId,
    );
  }

  /**
   * The wiring card for a workflow: what is connected, what is missing, and one
   * button that fixes the mechanical parts.
   */
  async wiringCard(h: H, wfId: string, repos: string[], fa: boolean): Promise<any> {
    const base = String(h.env.WORKER_URL ?? "").replace(/\/+$/, "");
    const report = await wiringReport({
      env: h.env, ownerId: h.u.id, repos, base, token: h.userToken, workflowId: wfId,
    });
    const rows: any[] = [];
    if (repos.length) {
      rows.push([{ text: fa ? "🔧 وصلش کن" : "🔧 Wire it up", cb: `hos:wire:${wfId}` }]);
    } else {
      rows.push([{ text: fa ? "➕ مخزن را مشخص کن" : "➕ Name the repo", cb: `hos:repo:${wfId}` }]);
    }
    rows.push([{ text: fa ? "📎 آدرس وب‌هوک" : "📎 Webhook", cb: `hos:whook:${wfId}` }, { text: fa ? "🧪 اجرای آزمایشی" : "🧪 Dry run", cb: `hos:wfrun:${wfId}` }]);
    rows.push([{ text: fa ? "🧩 جزئیات گره‌ها" : "🧩 Nodes", cb: `hos:wfv:${wfId}` }, { text: fa ? "🔌 کانکتورها" : "🔌 Connectors", cb: "hos:conn" }]);
    rows.push([{ text: fa ? "🗑 حذف" : "🗑 Delete", cb: `hos:wfdel:${wfId}` }]);
    return kb(...rows);
  }

  /** Render the readiness screen again, with fresh checks. */
  async wiring(h: H, wfId: string, runFix = false) {
    const fa = h.loc === "fa";
    const repos = await loadRepos(h.env, wfId);
    const base = String(h.env.WORKER_URL ?? "").replace(/\/+$/, "");

    if (runFix) {
      if (!repos.length) return this.repoPrompt(h, wfId);
      await h.loading(fa ? "🔧 در حال وصل‌کردن…" : "wiring…");
      await ensureGithubConnector(h.env, h.u.id, repos);
    }

    const report = await wiringReport({
      env: h.env, ownerId: h.u.id, repos, base, token: h.userToken, workflowId: wfId,
      // only the explicit "wire it up" press talks to GitHub about hooks
      checkHooks: runFix,
    });
    const body = renderWiring(report, fa) +
      (runFix && report.hooks.some((x) => !x.ok)
        ? `\n\n${fa ? "<i>روی هر مخزن که وب‌هوک نشد، لینک «افزودن دستی» را بزن — سه فیلد دارد و یک بار برای همیشه است.</i>" : ""}`
        : "");
    return h.reply(body, await this.wiringCard(h, wfId, repos, fa), !!h.cbId);
  }

  /** Ask for the repositories when the mission did not name them. */
  async repoPrompt(h: H, wfId: string) {
    const fa = h.loc === "fa";
    await setMode(h.session, "hos:wfrepo", { wfId });
    return h.reply(
      fa
        ? `📦 <b>کدام مخزن؟</b>\n\n` +
          `<blockquote>این ورک‌فلو باید بداند رویداد کدام مخزن مهم است. یک یا چند مورد را با کاما بنویس.</blockquote>\n\n` +
          `<code>panel-zeus/Z-E-U-S</code>\n<code>oven-sh/bun, cloudflare/workers-sdk</code>\n\n` +
          `<i>نام را همان‌طور که در گیت‌هاب است بنویس (owner/repo). اگر مطمئن نیستی، اول <code>/search</code> کن.</i>`
        : `📦 <b>Which repository?</b>\n\nSend one or more as \`owner/repo\`, comma separated.`,
      kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: `hos:wfv:${wfId}` }]]) as any,
    );
  }

  async setRepos(h: H, wfId: string, input: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    const repos = reposInMission(input);
    if (!repos.length) {
      return h.reply(
        fa ? `❌ چیزی که شبیه <code>owner/repo</code> باشد پیدا نشد.` : `❌ no owner/repo found`,
        kb([[{ text: fa ? "🔁 دوباره" : "Retry", cb: `hos:repo:${wfId}` }]]), true,
      );
    }
    await saveRepos(h.env, wfId, repos);
    const wire = await ensureGithubConnector(h.env, h.u.id, repos);
    await h.toast(fa ? `📦 ${repos.length} مخزن ثبت شد` : "saved", true);
    return h.reply(
      (fa
        ? `📦 <b>مخزن ثبت شد</b>\n\n` +
          repos.map((r) => `• <code>${tgEscape(r)}</code>`).join("\n") +
          `\n\n${wire.created ? "کانکتور گیت‌هاب ساخته شد" : "به کانکتور گیت‌هاب اضافه شد"} — الان <b>${wire.repos.length}</b> مخزن را رصد می‌کند.`
        : `📦 saved`) +
        `\n\n${fa ? "قدم بعدی: «🔧 وصلش کن» تا وب‌هوک هم ثبت شود و لحظه‌ای خبر بیاید." : ""}`,
      await this.wiringCard(h, wfId, repos, fa), true,
    );
  }

  /** The manual webhook screen. */
  async hookHelp(h: H, wfId: string) {
    const fa = h.loc === "fa";
    const repos = await loadRepos(h.env, wfId);
    const base = String(h.env.WORKER_URL ?? "").replace(/\/+$/, "");
    const report = await wiringReport({ env: h.env, ownerId: h.u.id, repos, base, token: h.userToken });
    return h.reply(
      renderHookHelp(report, fa),
      kb(
        repos.length ? [{ text: fa ? "🔧 خودت وصلش کن" : "Wire it up", cb: `hos:wire:${wfId}` }] : [],
        [{ text: fa ? "◀️ بازگشت" : "Back", cb: `hos:wfv:${wfId}` }],
      ),
      !!h.cbId,
    );
  }

  // ── workflows ───────────────────────────────────────────────────────────
  /**
   * Twin workflows: same name, same event, both enabled.
   *
   * Repeating a mission while tuning its wording used to install a second (and
   * third) copy of the same machine, so one release produced three posts. New
   * missions replace their twin; this finds the ones already installed, so the
   * owner can collapse them with one press instead of hunting through the list.
   */
  twins(wfs: { id: string; name: string; on_event: string; enabled: number }[]) {
    const seen = new Map<string, string>();
    const out: { keep: string; drop: string; name: string; on_event: string }[] = [];
    for (const w of wfs) {
      const key = `${w.name}|${w.on_event}|${w.enabled}`;
      const first = seen.get(key);
      if (first) out.push({ keep: first, drop: w.id, name: w.name, on_event: w.on_event });
      else seen.set(key, w.id);
    }
    return out;
  }

  async workflows(h: H) {
    const fa = h.loc === "fa";
    const wfs = await listWorkflows(h.env, h.u.id);
    const dups = this.twins(wfs as any);
    const body = wfs.length
      ? wfs.map((w) => {
          const steps = w.dag.nodes.length;
          return `${w.enabled ? "🟢" : "⚪️"} <b>${tgEscape(w.name)}</b>\n   ${steps} گره${w.on_event ? ` · روی <code>${tgEscape(w.on_event)}</code>` : " · دستی"} · ${w.runs} اجرا`;
        }).join("\n\n")
      : (fa ? "<i>هنوز ورک‌فلویی نساخته‌ای. از «برنامه‌های آماده» شروع کن.</i>" : "<i>No workflows yet.</i>");

    return h.reply(
      (fa ? `⚙️ <b>ورک‌فلوها</b>\n\n` : `⚙️ <b>Workflows</b>\n\n`) + body +
        (dups.length
          ? (fa
            ? `\n\n🧹 <b>${dups.length} نسخهٔ تکراری روی <code>${tgEscape(dups[0].on_event)}</code></b>\n` +
              `<blockquote>هر سه روی یک رویداد فعال‌اند؛ یعنی هر نسخهٔ جدید چند پست می‌شود. یکی می‌مانَد، بقیه پاک می‌شوند.</blockquote>`
            : `\n\n🧹 <b>${dups.length} duplicate(s)</b> on <code>${tgEscape(dups[0].on_event)}</code>`)
          : ""),
      kb(
        ...(dups.length ? [[{ text: fa ? `🧹 تکراری‌ها را جمع کن (${dups.length})` : `🧹 Collapse duplicates (${dups.length})`, cb: `hos:dedupe:${dups[0].keep}` }]] : []),
        ...wfs.slice(0, 4).map((w) => [{ text: `▶️ ${w.name.slice(0, 34)}`, cb: `hos:wfrun:${w.id}` }]),
        ...wfs.slice(0, 4).map((w) => [{ text: `🗑 ${w.name.slice(0, 34)}`, cb: `hos:wfdel:${w.id}` }]),
        [{ text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" }, { text: fa ? "🧪 مأموریت" : "🧪 Mission", cb: "hos:mission" }],
      ),
      !!h.cbId,
    );
  }

  /** Destructive, so it asks first — and it says which one survives. */
  async dedupePrompt(h: H, keep: string) {
    const fa = h.loc === "fa";
    const wfs = await listWorkflows(h.env, h.u.id);
    const dups = this.twins(wfs as any).filter((d) => d.keep === keep);
    if (!dups.length) return this.workflows(h);
    const name = (wfs.find((w) => w.id === keep) as any)?.name ?? keep;
    return h.reply(
      `🧹 <b>${fa ? "جمع‌کردن تکراری‌ها" : "Collapse duplicates"}</b>\n\n` +
        `<blockquote>${fa
          ? `«${tgEscape(name)}» می‌مانَد. ${dups.length} نسخهٔ دیگر روی همان رویداد پاک می‌شود — با اجراهایشان.`
          : `Keeping «${tgEscape(name)}» and deleting ${dups.length} twin(s).`}</blockquote>\n\n` +
        (fa ? "بعدش روی نسخهٔ مانده می‌توانی «اجرای آزمایشی» بزنی تا مطمئن شوی درست کار می‌کند." : ""),
      kb(
        [{ text: fa ? `✅ بله، ${dups.length} تکراری را پاک کن` : `✅ Yes, delete ${dups.length}`, cb: `hos:dedupe2:${keep}` }],
        [{ text: fa ? "◀️ نگهش دار" : "◀️ Keep them", cb: "hos:wf" }],
      ),
      !!h.cbId,
    );
  }

  async dedupe(h: H, keep: string) {
    const fa = h.loc === "fa";
    const wfs = await listWorkflows(h.env, h.u.id);
    const dups = this.twins(wfs as any).filter((d) => d.keep === keep);
    for (const d of dups) {
      await h.env.DB.prepare(`DELETE FROM hub_runs WHERE wf_id=? AND owner_id=?`).bind(d.drop, h.u.id)
        .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      await h.env.DB.prepare(`DELETE FROM hub_workflows WHERE id=? AND owner_id=?`).bind(d.drop, h.u.id)
        .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      await h.env.DB.prepare(`DELETE FROM flags WHERE key=?`).bind(`wf:repos:${d.drop}`)
        .run().catch(() => null);
    }
    await h.toast(fa ? `🧹 ${dups.length} تکراری پاک شد` : `🧹 ${dups.length} removed`, true);
    return this.workflows(h);
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

  /** Destructive buttons ask first — deleting a workflow also deletes its history. */
  async workflowDeletePrompt(h: H, id: string) {
    const fa = h.loc === "fa";
    const wf = await getWorkflow(h.env, id);
    if (!wf) return h.toast("?");
    const runs = await h.env.DB.prepare(`SELECT COUNT(*) AS n FROM hub_runs WHERE workflow_id=?`)
      .bind(id).first<{ n: number }>().catch(() => null);
    return h.reply(
      `🗑 <b>${fa ? "حذف ورک‌فلو" : "Delete workflow"}</b>\n\n` +
        `<blockquote>${tgEscape(wf.name)}</blockquote>\n\n` +
        `<b>${wf.dag.nodes.length}</b> ${fa ? "گره" : "nodes"} · <b>${Number(runs?.n ?? 0)}</b> ${fa ? "اجرا" : "runs"} · ` +
        (wf.on_event ? fa ? `روی <code>${tgEscape(wf.on_event)}</code>` : "manual" : fa ? "دستی" : "manual") +
        `\n\n${fa ? "اگر فقط می‌خواهی خاموش شود، «⏸ غیرفعال» کافی است — تاریخچه می‌ماند." : "To just stop it, disable it instead — the history stays."}`,
      kb(
        [{ text: fa ? "✅ بله، حذف کن" : "✅ Yes, delete", cb: `hos:wfdel2:${id}` }],
        [{ text: fa ? "⏸ غیرفعالش کن" : "⏸ Disable instead", cb: `hos:wftog:${id}` }],
        [{ text: fa ? "◀️ نگهش دار" : "◀️ Keep it", cb: `hos:wfv:${id}` }],
      ),
      !!h.cbId,
    );
  }

  async deleteWorkflow(h: H, id: string) {
    await h.env.DB.prepare(`DELETE FROM hub_workflows WHERE id=? AND owner_id=?`).bind(id, h.u.id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast("🗑", true);
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

    /* A run without a live event is a preview: it never publishes and never
       asks for approval. A run *with* an event (a replay, or a real delivery)
       behaves like production and honours the owner's autonomy setting. */
    const dry = !eventOverride;
    const sample = eventOverride ?? sampleEventFor(wf.on_event, h.u.id);
    const autonomy = dry ? "manual" : await readAutonomy(h.env, h.u.id);
    const res = await runWorkflow(
      { env: h.env, ai: h.ai, tg: h.tg, owner_id: h.u.id, trace: "tr_manual" + id.slice(-6), event: sample, autonomy, dry },
      wf, {},
    );

    const steps = res.steps.map((s) => `${s.ok ? "✅" : "❌"} <b>${tgEscape(s.kind)}</b> <i>${tgEscape(s.summary).slice(0, 70)}</i> · ${s.ms}ms`).join("\n");
    const published = res.bag.published ? `\n\n📤 ${fa ? "منتشر شد" : "published"}: <code>${tgEscape(JSON.stringify(res.bag.published))}</code>` : "";
    const gate = res.state === "waiting" ? `\n\n🕹 ${fa ? "منتظر تأیید تو در پیام بالا" : "awaiting your approval"}` : "";

    if (h.cbId) {
      return h.reply(
        `${res.state === "ok" ? "✅" : res.state === "waiting" ? "🕹" : "❌"} <b>${tgEscape(wf.name)}</b> — ${res.state}${gate}\n\n${steps}${published}` +
          (dry ? `\n\n🧪 <i>${fa ? "اجرای آزمایشی روی یک رویداد نمونه بود؛ هیچ‌چیز منتشر نشد." : "dry run on a sample event — nothing was published"}</i>` : ""),
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

  /**
   * Approve a draft and put it on the channel.
   *
   * Two id spaces land here. A card in the queue carries a **content id**
   * (`hos:ok:cnt_…`) and has nothing to resume. A card posted by a workflow's
   * approval gate carries a **run id** (`hos:ok:run_…`), and that run is
   * sitting parked in `hub_runs` with a frontier waiting behind the gate.
   *
   * Exactly one of them may publish. The first version of this resumed the run
   * *and* published here, and the channel received the same release twice
   * (verified live — two identical `sendMessage` calls, one from each path).
   * The run owns its publish step: it knows the channel, the markup, the asset
   * buttons and it records `published` in its bag. So this resumes first, looks
   * at what the run did, and only publishes itself when the run did not — which
   * is the queue case, and the case of a workflow whose gate sits *after* its
   * connector node.
   */
  async approve(h: H, contentId: string) {
    const fa = h.loc === "fa";
    let runId: string | null = null;

    if (contentId.startsWith("run_")) {
      runId = contentId;
      const row = await h.env.DB.prepare(`SELECT output FROM hub_runs WHERE id=?`)
        .bind(runId).first<any>().catch(() => null);
      if (!row) return h.toast("?");
      const out = safeJson(row.output) as any;
      const cid = String(out?.bag?.content_id ?? out?.bag?.id ?? "");
      if (!cid) {
        // A gate whose content node never ran has nothing to publish — but the
        // run still deserves to move on, or it waits forever.
        const moved = await resumeRun(
          { env: h.env, ai: h.ai, tg: h.tg, owner_id: h.u.id, trace: `tr_resume${runId.slice(-6)}` },
          runId, { approved: true },
        ).catch(() => null);
        return h.reply(
          moved
            ? `✅ <b>${fa ? "تأیید شد" : "approved"}</b>\n\n<i>${fa ? "این ورک‌فلو محتوایی برای انتشار نداشت؛ اجرا ادامه یافت." : "no content to publish; run resumed"}</i>`
            : `⚠️ <b>${fa ? "چیزی برای تأیید نبود" : "nothing to approve"}</b>`,
          kb([[{ text: fa ? "🕹 صف" : "🕹 Queue", cb: "hos:queue" }]]),
          !!h.cbId,
        );
      }
      contentId = cid;
    }

    const c = await CG.getContent(h.env, contentId);
    if (!c) {
      // A run can outlive its draft — the row was cleared, or deleted from the
      // queue. Answering "?" left the card dead *and* the run parked, which is
      // how a queue fills with gates that can never be answered. Close it and
      // say so.
      if (runId) await this.closeRun(h, runId, "🗑 پیش‌نویس پیدا نشد (پاک‌شده)");
      return h.reply(
        `⚠️ <b>${fa ? "پیش‌نویس این تأیید دیگر وجود ندارد" : "draft is gone"}</b>\n\n` +
          (fa ? "محتوا حذف شده، پس چیزی برای انتشار نیست. اجرای معلق هم بسته شد." : ""),
        kb([[{ text: fa ? "🕹 صف" : "🕹 Queue", cb: "hos:queue" }, { text: fa ? "🏃 اجراها" : "🏃 Runs", cb: "hos:runs" }]]),
        !!h.cbId,
      );
    }

    // ── hand the decision to the run, which publishes as its own step ──────
    if (runId) {
      const r = await resumeRun(
        { env: h.env, ai: h.ai, tg: h.tg, owner_id: h.u.id, trace: `tr_resume${runId.slice(-6)}` },
        runId,
        { approved: true, content_id: contentId },
      ).catch(() => null);
      const pub = r?.bag?.published;
      if (pub?.message_id) {
        await CG.markPublished(h.env, contentId, String(pub.chat ?? ""), Number(pub.message_id));
        await h.toast(fa ? "✅ منتشر شد" : "✅ published");
        return this.viewContent(h, contentId);
      }
      // The run either had nothing left to do or stopped short of publishing;
      // fall through and publish here, once.
    }

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

  /**
   * The «✏️ ویرایش متن» button had no handler at all: the keyboard offered it
   * and tapping it did nothing. It now parks the content id in the input mode
   * and asks for the replacement body — the same mode mechanism every other
   * text entry in the hub uses, so a stray message cannot edit a draft by
   * accident (the mode expires on its own).
   */
  async editPrompt(h: H, contentId: string) {
    const fa = h.loc === "fa";
    const c = await CG.getContent(h.env, contentId);
    if (!c) return h.toast("?");
    await setMode(h.session, "hos:edit", { id: contentId });
    return h.reply(
      `✏️ <b>${fa ? "ویرایش متن" : "Edit body"}</b>\n\n` +
        `<i>${tgEscape(String(c.title ?? c.kind))}</i>\n\n` +
        (fa
          ? "متن جدید را بفرست. متن فعلی جایگزین می‌شود و همان درخواست تأیید دوباره می‌آید."
          : "Send the new body. It replaces the current one and the approval card comes back."),
      kb([[{ text: fa ? "✖️ انصراف" : "✖️ Cancel", cb: `hos:view:${contentId}` }]]),
      !!h.cbId,
    );
  }

  /** Apply a typed body to the draft that is in edit mode. */
  async applyEdit(h: H, contentId: string, text: string) {
    const fa = h.loc === "fa";
    const body = text.trim();
    if (!body) return h.toast("?");
    const c = await CG.getContent(h.env, contentId);
    if (!c) return h.toast("?");
    const prev = c.body ?? "";
    await h.env.DB.prepare(`UPDATE hub_content SET body=?, version=version+1, updated_at=? WHERE id=?`)
      .bind(body.slice(0, 8000), Date.now(), contentId)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await clearMode(h.session);
    // An edit changes the text that was embedded and indexed, so both indexes
    // are refreshed — otherwise the search layer keeps serving the old body.
    await KB.embedDocument(h.env, h.ai, { id: contentId, owner_id: h.u.id, text: body, title: c.title ?? undefined, kind: c.kind, lang: c.lang })
      .catch(() => false);
    return h.reply(
      `✅ <b>${fa ? "متن جایگزین شد" : "body replaced"}</b>\n` +
        `<i>${fa ? `نسخهٔ قبلی ${prev.length} کاراکتر بود، نسخهٔ جدید ${body.length} کاراکتر` : `${prev.length} → ${body.length} chars`}</i>\n\n` +
        body.slice(0, 3000),
      kb(
        [{ text: fa ? "✅ تأیید و انتشار" : "✅ Approve & publish", cb: `hos:ok:${contentId}` }],
        [{ text: fa ? "🕸 گراف" : "🕸 Graph", cb: "hos:graph" }, { text: fa ? "🕹 صف" : "🕹 Queue", cb: "hos:queue" }],
      ),
    );
  }

  /**
   * Rejecting is a decision too: the draft is blocked, and a workflow sitting
   * on the same gate is closed out with an honest step instead of staying in
   * `waiting` for an answer that already arrived. Left as it was, the queue
   * filled up with runs nobody could ever approve.
   */
  async reject(h: H, id: string) {
    const fa = h.loc === "fa";
    let runId: string | null = null;
    if (id.startsWith("run_")) {
      runId = id;
      const row = await h.env.DB.prepare(`SELECT output FROM hub_runs WHERE id=?`)
        .bind(runId).first<any>().catch(() => null);
      const bag = safeJson(row?.output)?.bag ?? {};
      id = String(bag.content_id ?? bag.id ?? "");
      if (!id) {
        await this.closeRun(h, runId, "🗑 رد شد توسط مالک");
        await h.toast("🗑");
        return this.runs(h);
      }
    }
    await CG.setState(h.env, id, "blocked");
    if (runId) await this.closeRun(h, runId, "🗑 رد شد توسط مالک");
    await h.toast("🗑");
    return this.queue(h);
  }

  /** Mark a parked run as finished because the owner declined it. */
  private async closeRun(h: H, runId: string, why: string) {
    const row = await h.env.DB.prepare(`SELECT steps FROM hub_runs WHERE id=?`)
      .bind(runId).first<any>().catch(() => null);
    const steps = safeJson(row?.steps);
    const list = Array.isArray(steps) ? steps : [];
    list.push({ node: "gate", kind: "approval", ms: 0, summary: why, ok: true });
    await h.env.DB.prepare(`UPDATE hub_runs SET state='ok', steps=?, ended_at=? WHERE id=?`)
      .bind(JSON.stringify(list).slice(0, 12000), Date.now(), runId)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return true;
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

  // ── knowledge graph & semantic search ───────────────────────────────────

  async knowledge(h: H) {
    const fa = h.loc === "fa";
    const [ents, docs] = await Promise.all([
      KB.topEntities(h.env, h.u.id, 8),
      h.env.DB.prepare(`SELECT COUNT(*) n FROM hub_docs WHERE owner_id=?`).bind(h.u.id).first<any>().catch(() => null),
    ]);
    const embedded = await h.env.DB.prepare(`SELECT COUNT(*) n FROM hub_docs WHERE owner_id=? AND embedding IS NOT NULL`).bind(h.u.id).first<any>().catch(() => null);
    const list = ents.length
      ? ents.map((e) => `${ENTITY_ICON[e.kind] ?? "•"} <b>${tgEscape(e.label)}</b> <i>${e.kind}</i> · ${e.mentions}×`).join("\n")
      : (fa ? "<i>هنوز چیزی استخراج نشده.</i>" : "<i>nothing indexed yet</i>");
    return h.reply(
      `🧠 <b>${fa ? "گراف دانش و جست‌وجوی معنایی" : "Knowledge graph & semantic search"}</b>\n\n` +
        `<blockquote>${fa
          ? "هر نوشته به موجودیت‌ها تجزیه می‌شود و به‌صورت برداری ذخیره می‌شود. جست‌وجو با معنا کار می‌کند، نه با کلمه."
          : "Artefacts become entities and vectors. Search works on meaning, not substrings."}</blockquote>\n\n` +
        `<b>${fa ? "پرتکرارترین موجودیت‌ها" : "Top entities"}</b>\n${list}\n\n` +
        `📄 ${fa ? "اسناد" : "docs"}: <b>${docs?.n ?? 0}</b> · ${fa ? "برداری‌شده" : "embedded"}: <b>${embedded?.n ?? 0}</b>`,
      kb(
        [{ text: fa ? "🔎 جست‌وجوی معنایی" : "🔎 Semantic search", cb: "hos:search" }],
        [{ text: fa ? "📚 همهٔ موجودیت‌ها" : "📚 All entities", cb: "hos:ents" }, { text: fa ? "🕸 گراف" : "🕸 Graph", cb: "hos:graph" }],
      ),
      !!h.cbId,
    );
  }

  async entities(h: H) {
    const fa = h.loc === "fa";
    const rows = await KB.topEntities(h.env, h.u.id, 24);
    const byKind = new Map<string, string[]>();
    for (const e of rows) {
      const arr = byKind.get(e.kind) ?? [];
      arr.push(`${ENTITY_ICON[e.kind] ?? "•"} ${e.label} <i>${e.mentions}</i>`);
      byKind.set(e.kind, arr);
    }
    const body = [...byKind.entries()].map(([k, arr]) => `<b>${k}</b>\n${arr.join(" · ")}`).join("\n\n") || (fa ? "<i>خالی</i>" : "<i>empty</i>");
    return h.reply(`📚 <b>${fa ? "موجودیت‌ها" : "Entities"}</b>\n\n${body}`, kb([[{ text: "◀️", cb: "hos:know" }]]), !!h.cbId);
  }

  async searchPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "hos:search");
    return h.reply(
      fa
        ? `🔎 <b>جست‌وجوی معنایی</b>\n\n<blockquote>هر چه یادت هست بنویس — لازم نیست کلمهٔ دقیق را بدانی. «اون پست مربوط به آپدیت کلادفلر ورکرز که هفته پیش ساختیم» کافی است.</blockquote>\n\n` +
          `سه مسیر جست‌وجو به ترتیب: <b>موجودیت</b> (اگر اسمی در گراف باشد) → <b>برداری</b> (معنا) → <b>کلیدواژه</b>. و همیشه می‌گوید از کدام مسیر جواب داده.`
        : `🔎 <b>Semantic search</b>`,
      kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:know" }]]) as any,
    );
  }

  async search(h: H, query: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    const q = query.trim();
    if (!q) return h.toast(fa ? "چیزی بنویس" : "type something");
    await h.loading(fa ? "🧠 در حال جست‌وجو…" : "Searching…");
    const r = await KB.search(h.env, h.ai, h.u.id, q, { limit: 6 });

    const viaLabel = r.via === "entity" ? "🧠 گراف دانش" : r.via === "semantic" ? "🧬 برداری (معنایی)" : "🔤 کلیدواژه";
    if (!r.hits.length) {
      return h.reply(
        `🔎 <b>${tgEscape(q)}</b>\n\n${fa ? "چیزی پیدا نشد." : "no hits."}\n\n` +
          `<i>${fa ? "مسیر جست‌وجو" : "via"}: ${viaLabel}</i>`,
        kb([[{ text: fa ? "📚 برنامه‌های آماده" : "📚 Playbooks", cb: "hos:books" }, { text: fa ? "🧠 دانش" : "🧠 Knowledge", cb: "hos:know" }]]),
        !!h.cbId,
      );
    }
    const hits = r.hits.map((hit, i) => {
      const preview = MD.stripHtml(hit.body ?? "").replace(/\s+/g, " ").slice(0, 140);
      return `<b>${i + 1}.</b> ${tgEscape(hit.title ?? hit.kind)}\n   <i>${tgEscape(preview)}…</i>\n   <code>${hit.id.slice(-8)}</code> · ${(hit.score * 100).toFixed(0)}٪`;
    }).join("\n\n");
    return h.reply(
      `🔎 <b>${tgEscape(q)}</b>\n\n${hits}\n\n<i>${fa ? "مسیر" : "via"}: ${viaLabel}${r.entity ? ` · ${tgEscape(r.entity.label)}` : ""}</i>`,
      kb(
        ...r.hits.slice(0, 3).map((hit) => [{ text: `👁 ${(hit.title ?? hit.kind).slice(0, 28)}`, cb: `hos:view:${hit.id}` }]),
        [{ text: fa ? "🎯 رویدادها" : "🎯 Events", cb: "hos:events" }],
      ),
      !!h.cbId,
    );
  }

  // ── file universe ───────────────────────────────────────────────────────

  async filePrompt(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT name, kind, size, extracted_chars, created_at FROM hub_files WHERE owner_id=? ORDER BY created_at DESC LIMIT 8`,
    ).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] }));
    const list = (results ?? []).length
      ? (results ?? []).map((r) => `${FILE_ICON[r.kind] ?? "📄"} <b>${tgEscape(r.name)}</b>\n   <code>${r.kind}</code> · ${FU.humanBytes(r.size)} · ${r.extracted_chars ? `${FU.fmtNum(r.extracted_chars)} ${fa ? "نویسه" : "chars"}` : fa ? "بدون متن" : "no text"}`).join("\n\n")
      : (fa ? "<i>هنوز فایلی نفرستاده‌ای.</i>" : "<i>no files yet</i>");

    await setMode(h.session, "hos:file");
    return h.reply(
      (fa
        ? `📄 <b>کالبدشکافی فایل</b>\n\n` +
          `<blockquote>هر فایل متنی، PDF، CSV، JSON، XML، کد یا آرشیو را بفرست: نوعش تشخیص داده می‌شود، متن و ساختارش استخراج می‌شود، موجودیت‌هایش به گراف دانش می‌رود و قابل جست‌وجو می‌شود.</blockquote>\n\n` +
          `<b>پشتیبانی می‌شود:</b> txt · md · csv · json · xml · yaml · html · PDF (متنی) · همهٔ زبان‌های کد\n` +
          `<b>پشتیبانی نمی‌شود:</b> صوت و ویدیو (طبق درخواست خودت، هیچ بخش صوتی در ربات نیست)\n\n`
        : `📄 <b>File dissection</b>\n\nSend a document and I will extract, index and graph it.\n\n`) +
        `<b>${fa ? "آخرین فایل‌ها" : "Recent"}</b>\n${list}`,
      kb([[{ text: fa ? "◀️" : "◀️", cb: "hos:home" }]]) as any,
    );
  }

  /**
   * A document arriving in chat, run through the whole pipeline at once.
   *
   * The result is reported as *facts*, not as a wall of text: the owner asked
   * to dissect a file, and "1,284 lines, 12 imports, 3 TODOs, 47 entities
   * linked" answers that better than the first 4000 characters do.
   */
  async ingestFile(h: H, doc: { file_name?: string; mime_type?: string; file_id: string; file_size?: number }) {
    const fa = h.loc === "fa";
    const name = doc.file_name ?? "file.bin";
    await h.loading(fa ? `📄 در حال کالبدشکافی ${name}…` : `Dissecting ${name}…`);
    try {
      const bytes = await downloadTelegramFile(h, doc.file_id);
      if (!bytes) return h.reply(`❌ ${fa ? "دریافت فایل از تلگرام ناموفق بود (فایل بزرگ‌تر از ۲۰MB یا منقضی شده)" : "could not fetch file"}`, kb([[{ text: "◀️", cb: "hos:files" }]]));

      const r = await FU.ingest(h.env, h.ai, {
        name, mime: doc.mime_type, bytes, owner_id: h.u.id,
        skipEmbed: await aiHaltedSafe(h),
      });

      const facts = r.facts.map((f) => `• <b>${tgEscape(f.label)}</b>: ${tgEscape(f.value)}`).join("\n");
      const preview = r.preview.replace(/\s+/g, " ").slice(0, 400);
      return h.reply(
        `📄 <b>${tgEscape(name)}</b>\n\n` +
          `<blockquote>${facts}</blockquote>\n\n` +
          (r.note ? `⚠️ ${tgEscape(r.note)}\n\n` : "") +
          `🧠 ${fa ? "موجودیت‌های پیوند‌خورده" : "entities linked"}: <b>${r.entities}</b>` +
          (r.embedded ? ` · 🧬 ${fa ? "برداری شد" : "embedded"}` : ` · <i>${fa ? "بدون بردار (سهمیه)" : "not embedded"}</i>`) +
          (preview ? `\n\n<b>${fa ? "پیش‌نمایش" : "preview"}</b>\n<code>${tgEscape(preview)}</code>` : ""),
        kb(
          [{ text: fa ? "🔎 جست‌وجو در محتوا" : "🔎 Search inside", cb: "hos:search" }],
          [{ text: fa ? "📄 فایل دیگر" : "📄 Another file", cb: "hos:files" }, { text: fa ? "🧠 دانش" : "🧠 Knowledge", cb: "hos:know" }],
        ),
        !!h.cbId,
      );
    } catch (e: any) {
      return h.reply(`❌ <code>${tgEscape(String(e?.message ?? e).slice(0, 200))}</code>`, kb([[{ text: "◀️", cb: "hos:files" }]]));
    }
  }

  // ── media factory ───────────────────────────────────────────────────────

  async mediaPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "hos:media");
    return h.reply(
      fa
        ? `🖼 <b>کارخانهٔ رسانه</b>\n\n` +
          `<blockquote>موضوع یا متن پست را بفرست. یک کاور برداری (SVG) می‌سازم که برای عنوان یکسان همیشه یکسان است، و یک پرامپت هنری دقیق برای تولید تصویر.</blockquote>\n\n` +
          `<i>کاور رندر می‌شود نه تولید: برداری، شارپ در هر اندازه، با فارسی درست (نویسندهٔ تصویر نمی‌تواند متن فارسی را سالم بنویسد) و بدون هزینهٔ نورون.</i>`
        : `🖼 <b>Media factory</b>`,
      kb([[{ text: fa ? "✖️ لغو" : "✖️ Cancel", cb: "hos:home" }]]) as any,
    );
  }

  async buildMedia(h: H, subject: string) {
    const fa = h.loc === "fa";
    await clearMode(h.session);
    const s = subject.trim();
    if (!s) return h.toast("?");
    await h.loading(fa ? "🖼 در حال ساخت کیت رسانه…" : "Building media kit…");

    const firstLine = s.split("\n")[0].slice(0, 120);
    const spec = { title: firstLine, subtitle: s.split("\n")[1]?.slice(0, 90), badge: undefined as string | undefined, handle: undefined as string | undefined, theme: "dark" as const };
    const kit = await MD.mediaKit(h.env, h.ai, { title: spec.title, body: s, badge: spec.badge, handle: spec.handle }, { withPrompt: true });

    const svgBytes = new TextEncoder().encode(kit.cover);
    await h.tg.sendDocument(h.chatId, `${slug(firstLine)}.svg`, new Blob([svgBytes], { type: "image/svg+xml" }), undefined, {})
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    return h.reply(
      MD.mediaKitCaption(spec as any, kit.prompt, fa),
      kb(
        [{ text: fa ? "🖼 موضوع دیگر" : "🖼 Another", cb: "hos:media" }],
        [{ text: fa ? "🕸 گراف" : "🕸 Graph", cb: "hos:graph" }],
      ),
      !!h.cbId,
    );
  }

  // ── integrations: webhooks + gateway ────────────────────────────────────

  // ── the manual ──────────────────────────────────────────────────────────
  /**
   * A screen that answers "so how do I actually use this".
   *
   * Every feature is described by *where it opens* and *what you do there*, in
   * the order the console presents them — a list of capabilities without an
   * entry point is just a press release.
   */
  async guide(h: H) {
    const fa = h.loc === "fa";
    if (!fa) {
      return h.reply(
        `📖 <b>How to use the hub</b>\n\n` +
          `1. 🧪 <b>New mission</b> — type one sentence; the planner builds and runs a workflow\n` +
          `2. 📚 <b>Playbooks</b> — three tested workflows, installed with one tap\n` +
          `3. 🔌 <b>Connectors</b> — add github/rss/http/telegram → test → «Fetch now»\n` +
          `4. 🎯 <b>Events</b> — everything that arrived from outside\n` +
          `5. 🕹 <b>Approval queue</b> — ✅ publish / ✏️ edit / 🗑 reject\n` +
          `6. ⚙️ <b>Workflows</b> — the node graph, on/off, run now\n` +
          `7. 🕸 <b>Content graph</b> — lineage and DNA of everything produced\n` +
          `8. 📊 <b>Runs</b> — every node of every run, step by step\n` +
          `9. 🧠 <b>Knowledge &amp; semantic search</b> — type a sentence, no keyword needed\n` +
          `10. 📚 <b>Entities</b> — repos, orgs, versions, terms pulled from content\n` +
          `11. 📄 <b>File dissection</b> — send a file; text, structure, entities, searchable\n` +
          `12. 🖼 <b>Media factory</b> — a topic in, cover + image prompt out\n` +
          `13. 🔌 <b>Webhooks &amp; gateway</b> — hook URLs, OpenAI-compatible endpoint, 7-day stats\n` +
          `14. 🚀 <b>Self-host</b> — your own copy in your own Cloudflare account`,
        kb([[{ text: "🏠 Home", cb: "hos:home" }, { text: "🔌 Integrations", cb: "hos:integ" }]]),
        !!h.cbId,
      );
    }
    return h.reply(
      `📖 <b>راهنمای هاب جهانی</b>\n` +
        `<blockquote>هر قابلیت با «از کجا باز می‌شود» و «آنجا چه کار کن» نوشته شده. ` +
        `هر پیام متنی که در یک بخش می‌فرستی، به همان بخش می‌رود — و با زدن دکمهٔ بخش دیگر، از آن بخش بیرون می‌آیی.</blockquote>\n\n` +

        `🧪 <b>مأموریت تازه</b>\n` +
        `<i>دکمه را بزن و یک جمله بنویس.</i> مثال: «هر وقت نسخهٔ جدید bun منتشر شد، پست فارسی بساز و برای تأیید بفرست».\n` +
        `خودش گراف ورک‌فلو را می‌سازد، اجرا می‌کند و پیش‌نویس را در صف تأیید می‌گذارد.\n\n` +

        `📚 <b>برنامه‌های آماده</b>\n` +
        `سه ورک‌فلوی آمادهٔ تست‌شده: <i>انتشار نسخهٔ جدید در کانال</i> · <i>خلاصهٔ RSS</i> · <i>هشدار تغییر صفحه</i>. با یک لمس نصب می‌شوند.\n\n` +

        `🔌 <b>کانکتورها</b> — منبع رویداد\n` +
        `«افزودن» → نوع (گیت‌هاب / RSS / HTTP / تلگرام) → کانفیگ را بفرست → «تست» (واقعی است: سهمیهٔ گیت‌هاب، دسترسی کانال، …) → «🔄 دریافت الان» تا بدون انتظار کرون، اقلام تازه به رویداد تبدیل شوند.\n\n` +

        `🎯 <b>رویدادها</b>\n` +
        `هر چه از بیرون رسیده، با نوع و شناسه. دکمهٔ «🧪 رویداد آزمایشی» کل مسیر را با یک رویداد نمونه اجرا می‌کند — برای امتحان‌کردن همه‌چیز، بی‌آنکه منتظر سرویس بیرونی بمانی.\n\n` +

        `🕹 <b>صف تأیید</b> — قلب سیستم\n` +
        `هیچ‌چیز بدون اجازهٔ تو از مرز بیرون نمی‌رود: <b>✅ تأیید و انتشار</b> (می‌رود در کانال، دقیقاً یک‌بار) · <b>✏️ ویرایش متن</b> (متن تازه بفرست، جایگزین می‌شود و کارت برمی‌گردد) · <b>🗑 رد</b> (مسدود می‌شود و اجرای معلق هم بسته می‌شود).\n\n` +

        `⚙️ <b>ورک‌فلوها</b>\n` +
        `گراف گره‌ها را می‌بینی: روشن/خاموش کردن، حذف، و «▶️ اجرا» برای اجرای دستی.\n\n` +

        `🕸 <b>گراف محتوا</b> · 📊 <b>اجراها</b>\n` +
        `اولی نسب و DNA هر محتوا را نشان می‌دهد (والد/فرزند، اطمینان، مدل‌ها)؛ دومی می‌گوید هر اجرا گره‌به‌گره چه کرد، چند میلی‌ثانیه و با چه نتیجه‌ای.\n\n` +

        `🧠 <b>دانش و جست‌وجوی معنایی</b>\n` +
        `«🔎 جست‌وجوی معنایی» را بزن و یک جملهٔ معمولی بنویس — <i>لازم نیست کلمهٔ مشترکی با متن داشته باشد</i>. کنار هر نتیجه می‌گوید از کدام راه پیدا شده: موجودیت، برداری، یا واژه‌ای.\n\n` +

        `📄 <b>کالبدشکافی فایل</b>\n` +
        `فایل را بفرست: نوع، متن، ساختار و موجودیت‌هایش استخراج و برای جست‌وجو برداری می‌شود. PDF متنی بله؛ PDF اسکن‌شده صادقانه «متن پیدا نشد»؛ صوت و ویدیو پذیرفته نمی‌شود.\n\n` +

        `🖼 <b>کارخانهٔ رسانه</b>\n` +
        `یک موضوع بده: کاور ۱۲۰۰×۶۹۰ (فایل SVG) + پرامپت تصویر انگلیسی با سبک و نسبت تصویر + متن جانشین فارسی.\n\n` +

        `🔌 <b>وبهوک و گیت‌وی</b>\n` +
        `آدرس وبهوک هر کانکتور و دروازهٔ سازگار با OpenAI + مدل‌ها + آمار ۷ روز. (جزئیات فنی در <code>docs/USAGE-FA.md</code> مخزن.)\n\n` +

        `🚀 <b>ساخت نمونهٔ شخصی</b>\n` +
        `لینکِ توکن با همان هفت دسترسی لازم، بعد توکن را بفرست: ربات خودش را در حساب کلاودفلر خودت می‌سازد.\n\n` +

        `⏱ <b>خودکار، بدون تو:</b> هر ۱۵ دقیقه کانکتورها چک می‌شوند و اقلام تازه رویداد می‌سازند؛ کارهای ساعتی/روزانهٔ نگهداری هم در همان کرون‌ها اجرا می‌شوند.`,
      kb(
        [
          { text: "🧪 مأموریت", cb: "hos:mission" },
          { text: "📚 برنامه‌های آماده", cb: "hos:books" },
        ],
        [
          { text: "🔌 کانکتورها", cb: "hos:conn" },
          { text: "🕹 صف تأیید", cb: "hos:queue" },
        ],
        [
          { text: "🧠 دانش و جست‌وجو", cb: "hos:know" },
          { text: "🖼 کارخانهٔ رسانه", cb: "hos:media" },
        ],
        [{ text: "🏠 خانهٔ هاب", cb: "hos:home" }],
      ),
      !!h.cbId,
    );
  }

  // ── one-click self-hosting ──────────────────────────────────────────────
  /**
   * The screen behind «🚀 ساخت نمونهٔ شخصی».
   *
   * It has to answer three questions before anyone will paste a token: what it
   * is going to do, exactly which permissions the token needs (the link opens
   * the dashboard with only those boxes ticked), and what it will cost them
   * (nothing — everything created fits in the free tier).
   */
  async deployPrompt(h: H, note?: string) {
    const fa = h.loc === "fa";
    const link = DP.tokenLink();
    const perms = DP.TOKEN_PERMISSIONS.map(
      (p) => `• <code>${p.key}</code> <i>${p.type}</i> — ${p.why}`,
    ).join("\n");
    await setMode(h.session, "hos:deploy", { from: "hos:deploy" });
    return h.reply(
      (note ? `${note}\n\n` : "") +
        `🚀 <b>${fa ? "نمونهٔ شخصی خودت را بالا بیار" : "Self-host your own copy"}</b>\n\n` +
        `<blockquote>${fa
          ? "ربات، باندل نسخهٔ فعلی خودش را برمی‌دارد و در حساب کلاودفلر خودت می‌سازد: دیتابیس D1، دو فضای KV، یک صف، همهٔ جدول‌ها، آدرس workers.dev و وبهوک تلگرام. هیچ‌چیز روی کامپیوترت نصب نمی‌کنی و همه‌چیز در پلن رایگان جا می‌شود."
          : "The bot clones itself into your Cloudflare account."}</blockquote>\n\n` +
        `<b>${fa ? "۱) توکن بساز" : "1) Create a token"}</b>\n` +
        (fa ? "دکمهٔ زیر داشبورد را با همین دسترسی‌ها باز می‌کند:\n" : "The button opens the dashboard pre-filled with:\n") +
        `<blockquote>${perms}</blockquote>\n` +
        `<b>${fa ? "۲) توکن را همین‌جا بفرست" : "2) Send the token here"}</b>\n` +
        (fa
          ? `توکن را در یک پیام بفرست؛ اگر توکن رباتِ خودت را هم در خط دوم بگذاری، وبهوک همان‌جا وصل می‌شود.\n\n`
          : `Send the token. A bot token on the second line wires the webhook too.\n\n`) +
        `<code>&lt;CF API token&gt;</code>\n<code>&lt;bot token — اختیاری&gt;</code>`,
      kb(
        [{ text: fa ? "🔑 ساخت توکن با همین دسترسی‌ها" : "🔑 Create the token", url: link }],
        [{ text: fa ? "🔌 یکپارچه‌سازی" : "🔌 Integrations", cb: "hos:integ" }, { text: fa ? "🏠 خانه" : "🏠 Home", cb: "hos:home" }],
      ),
      !!h.cbId,
    );
  }

  /**
   * Run the deployment.
   *
   * Progress is a single edited message rather than a stream of sendMessage
   * calls: this takes half a minute and Cloudflare answers in steps, so one
   * message that keeps changing says more about where it is than fifteen lines
   * of history nobody reads. Edits are rate-limited to ~1.2s (Telegram starts
   * refusing them and the retry loop would stall the deploy).
   */
  async deployRun(h: H, input: string) {
    const fa = h.loc === "fa";
    const lines = input.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const cfToken = lines[0] ?? "";
    const botToken = lines.find((l) => /^\d{6,}:/.test(l)) ?? "";
    if (cfToken.length < 20) {
      return this.deployPrompt(h, `⚠️ ${fa ? "آن پیام شبیه توکن نبود. دوباره:" : "not a token"}`);
    }
    await clearMode(h.session);
    const progress = await h.tg.sendMessage(h.u.id, `🚀 <b>${fa ? "شروع شد…" : "starting…"}</b>`);
    const msgId = Number((progress as any)?.result?.message_id ?? 0);
    let lastEdit = 0;
    const body: string[] = [];
    const paint = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < 1200) return;
      lastEdit = now;
      if (!msgId) return;
      await h.tg.editMessageText(
        h.u.id, msgId,
        `🚀 <b>${fa ? "ساخت نمونهٔ شخصی" : "provisioning"}</b>\n\n` + body.slice(-12).join("\n"),
        { parse_mode: "HTML" } as any,
      ).catch(() => null);
    };
    let res: DP.ProvisionResult;
    try {
      res = await DP.provision(h.env, {
        token: cfToken,
        ownerId: h.u.id,
        botToken: botToken || undefined,
        statements: D1_STATEMENTS,
        onProgress: async (p) => {
          body.push(p.detail ? `${p.step}\n   <i>${tgEscape(p.detail)}</i>` : p.step);
          await paint();
        },
      });
    } catch (e: any) {
      res = { ok: false, steps: body, error: String(e?.message ?? e) };
    }
    await paint(true);

    if (!res.ok) {
      return h.reply(
        `❌ <b>${fa ? "ساخت نمونه متوقف شد" : "provisioning failed"}</b>\n\n` +
          `<blockquote>${tgEscape(String(res.error ?? "?").slice(0, 400))}</blockquote>\n\n` +
          (fa ? "تا اینجا انجام شد:\n" : "steps done:\n") + body.slice(-8).join("\n"),
        kb([[{ text: fa ? "🔁 تلاش دوباره" : "🔁 Retry", cb: "hos:deploy" }]]),
        !!h.cbId,
      );
    }

    // The health of the copy is already probed inside provision() (with retries —
    // a worker is not reachable the instant it is uploaded). Report its verdict
    // from the steps rather than probing a second time and contradicting it.
    const healthLine = (res.steps ?? []).find((x) => x.includes("نسخهٔ جدید"));
    const health = healthLine ?? "";
    await h.reply(
      `🎉 <b>${fa ? "نمونهٔ شخصی‌ات آماده است" : "your copy is live"}</b>\n\n` +
        (res.url ? `🌐 <code>${tgEscape(res.url)}</code>\n` : "") +
        (res.account ? `👤 ${tgEscape(res.account)}\n` : "") +
        `${health}\n\n` +
        (((res.steps ?? []).length ? `<blockquote>${res.steps.slice(-6).map((x) => tgEscape(x)).join("\n")}</blockquote>\n\n` : "")) +
        (fa
          ? "حالا در همان رباتِ خودت /start را بزن. توکنی که دادی در سکرت‌های همان ورکر ذخیره شده تا نسخهٔ جدید هم بتواند نسخهٔ بعدی را بسازد؛ هر وقت خواستی از داشبورد عوضش کن."
          : "Open your bot and press /start."),
      kb(
        res.url ? [{ text: fa ? "🌐 باز کردن نسخهٔ من" : "Open my copy", url: res.url }] : [{ text: fa ? "🏠 خانه" : "🏠 Home", cb: "hos:home" }],
        [{ text: fa ? "🔌 یکپارچه‌سازی" : "🔌 Integrations", cb: "hos:integ" }],
      ),
    );
  }

  async integrations(h: H) {
    const fa = h.loc === "fa";
    const base = String(h.env.WORKER_URL ?? "").replace(/\/+$/, "");
    const hooks = await h.env.DB.prepare(
      `SELECT id, kind, json_extract(config,'$.hook_key') hk FROM hub_connectors WHERE owner_id=? LIMIT 6`,
    ).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] }));
    const gw = await h.env.DB.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(prompt_tokens+completion_tokens),0) tok FROM hub_gateway_log WHERE ts > ?`,
    ).bind(Date.now() - 7 * 86400000).first<any>().catch(() => null);

    const hookUrls = (hooks.results ?? []).map((r) => `${base}/hooks/${r.kind}/${r.hk ?? r.id}`);
    const hookLines = hookUrls.length
      ? (hooks.results ?? []).map((r) => {
          const url = `${base}/hooks/${r.kind}/${r.hk ?? r.id}`;
          return `• <b>${tgEscape(r.kind)}</b>\n  <code>${tgEscape(url)}</code>`;
        }).join("\n\n")
      : (fa ? "<i>برای هر کانکتور یک آدرس هوم‌هوک ساخته می‌شود.</i>" : "<i>connect a connector first</i>");

    return h.reply(
      `🔌 <b>${fa ? "یکپارچه‌سازی: وب‌هوک و گیت‌وی" : "Integrations"}</b>\n\n` +
        `<b>${fa ? "آدرس‌های دریافت رویداد" : "Hook endpoints"}</b>\n` +
        `<blockquote>${fa ? "این آدرس را در تنظیمات وب‌هوک سرویس بیرونی بگذار. کلید داخل مسیر هم شناسه است و هم رمز — گیت‌هاب امضای HMAC را هم جدا بررسی می‌کند." : "Paste these into the provider's webhook settings."}</blockquote>\n\n` +
        hookLines +
        `\n\n<b>${fa ? "دروازهٔ هوش مصنوعی (سازگار با OpenAI)" : "AI gateway (OpenAI-compatible)"}</b>\n` +
        `<code>POST ${tgEscape(base)}/v1/chat/completions</code>\n` +
        `<code>GET  ${tgEscape(base)}/v1/models</code>\n\n` +
        `<blockquote>${fa ? "هر اپلیکیشنی که OpenAI را صدا می‌زند، می‌تواند آدرسش را به اینجا عوض کند و از مسیریابی خودکار، چندمدلی و گزارش توافق استفاده کند — بدون تغییر کد." : "Point any OpenAI client here."}</blockquote>\n\n` +
        (fa ? "مدل‌های در دسترس" : "Models") + `: ${MODELS.map((m) => `<code>${m.id}</code>`).join(" · ")}\n` +
        `📊 ${fa ? "۷ روز اخیر" : "last 7d"}: <b>${gw?.n ?? 0}</b> ${fa ? "درخواست" : "calls"} · ${FU.fmtNum(Number(gw?.tok ?? 0))} token`,
      kb(
        /* Real buttons. A URL written inside <code> cannot be tapped, and the one
           the owner retyped lost characters to line-wrapping — which is exactly
           how «دروازهٔ هوش مصنوعی» answered «Not found». */
        [{ text: "🌐 " + (fa ? "صفحهٔ دروازه" : "Gateway page"), url: `${base}/v1` },
         { text: "📋 " + (fa ? "فهرست مدل‌ها" : "Models"), url: `${base}/v1/models` }],
        hookUrls.length ? [{ text: "📎 " + (fa ? "کپی آدرس‌های وب‌هوک" : "Copy hook urls"), copy: hookUrls.join("\n") }] : [],
        [{ text: fa ? "🔌 کانکتورها" : "🔌 Connectors", cb: "hos:conn" }, { text: fa ? "📊 اجراها" : "📊 Runs", cb: "hos:runs" }],
      ),
      !!h.cbId,
    );
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
      // the same setting the webhook path reads: an event that arrives on its
      // own is published only if the owner asked for that
      const autonomy = await readAutonomy(env, row.owner_id);
      for (const ev of res.events.slice(0, 10)) {
        const r = await publish({ env, ai, tg, autonomy }, { ...ev, owner_id: row.owner_id });
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


const ENTITY_ICON: Record<string, string> = {
  repo: "📦", org: "🏢", version: "🏷", topic: "🎯", file: "📄",
  language: "⌨️", person: "👤", url: "🌐", term: "🔖",
};

const FILE_ICON: Record<string, string> = {
  text: "📃", markdown: "📘", csv: "📊", json: "🧾", xml: "🧩", yaml: "⚙️",
  html: "🌐", code: "⌨️", pdf: "📕", archive: "🗜", image: "🖼", binary: "🧱", unknown: "📄",
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cover";
}

/** The AI circuit breaker, without importing the whole brain into this file. */
async function aiHaltedSafe(h: H): Promise<boolean> {
  try {
    const { aiHalted } = await import("../ai/brain");
    return await aiHalted(h.env);
  } catch { return false; }
}

/**
 * Fetch a Telegram file into memory.
 *
 * The Bot API caps `getFile` downloads at 20MB, so the size is checked first
 * and a refusal is reported as a refusal rather than as a mysterious empty
 * buffer. Same translator rule as everywhere else: no shortcuts through
 * `atob`, which is what mangled non-ASCII text in the previous generation.
 */
async function downloadTelegramFile(h: H, fileId: string): Promise<Uint8Array | null> {
  const meta: any = await fetch(`https://api.telegram.org/bot${h.env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)
    .then((r) => r.json()).catch(() => null);
  if (!meta?.ok || !meta.result?.file_path) return null;
  if ((meta.result.file_size ?? 0) > 20 * 1024 * 1024) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${h.env.BOT_TOKEN}/${meta.result.file_path}`).catch(() => null);
  if (!res?.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
