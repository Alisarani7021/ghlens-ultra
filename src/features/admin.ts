import type { H } from "../core/handler";
import { setMode } from "../core/mode";
import { GithubRest } from "../github/rest";
import { fmt, meterBar } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";
import { isAdmin } from "../env";

/** Admin console: live metrics, quota/rate-limit health, broadcast, flags, job control. */
export class Admin {
  async home(h: H) {
    const fa = h.loc === "fa";
    if (!isAdmin(h.env, h.u.id)) return h.reply(fa ? "⛔️ دسترسی ندارید." : "⛔️ forbidden", undefined, !!h.cbId);

    const [counts, top, aiUse, dlUse] = await Promise.all([
      h.env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM users WHERE last_seen_at > ?) AS active7d,
          (SELECT COUNT(*) FROM repos) AS repos,
          (SELECT COUNT(*) FROM events WHERE ts > ?) AS events30d,
          (SELECT COUNT(*) FROM subscriptions) AS subs,
          (SELECT COUNT(*) FROM downloads) AS downloads,
          (SELECT COUNT(*) FROM action_jobs WHERE status='dispatched') AS jobs`,
      ).bind(Date.now() - 7 * 86400000, Date.now() - 30 * 86400000).first<any>().catch(() => null),
      h.env.DB.prepare(`SELECT kind, COUNT(*) AS c FROM events WHERE ts > ? GROUP BY kind ORDER BY c DESC LIMIT 8`)
        .bind(Date.now() - 7 * 86400000).all<any>().catch(() => ({ results: [] as any[] })),
      h.env.DB.prepare(`SELECT feature, SUM(calls) AS calls, SUM(tokens) AS tokens FROM ai_usage WHERE day = ? GROUP BY feature ORDER BY calls DESC`)
        .bind(new Date().toISOString().slice(0, 10)).all<any>().catch(() => ({ results: [] as any[] })),
      h.env.DB.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS n FROM downloads WHERE created_at > ?`)
        .bind(Date.now() - 7 * 86400000).first<{ bytes: number; n: number }>().catch(() => null),
    ]);

    const gh = new GithubRest(h.env);
    const rl = await gh.rateLimit().catch(() => null);
    const core = rl?.resources?.core;
    const search = rl?.resources?.search;
    const graphql = rl?.resources?.graphql;

    await h.reply(
      `🛡 <b>${fa ? "پنل مدیریت" : "Admin console"}</b>\n\n` +
        `👥 ${fa ? "کاربران" : "users"}: <b>${fmt(counts?.users ?? 0)}</b> (${fa ? "فعال ۷ روز" : "active 7d"}: ${counts?.active7d ?? 0})\n` +
        `📦 ${fa ? "مخازن فهرست‌شده" : "indexed repos"}: <b>${fmt(counts?.repos ?? 0)}</b>\n` +
        `⚡️ ${fa ? "رویداد ۳۰ روز" : "events 30d"}: <b>${fmt(counts?.events30d ?? 0)}</b>\n` +
        `🔔 ${fa ? "اشتراک‌ها" : "subs"}: ${counts?.subs ?? 0}   📥 ${fa ? "دانلودها" : "downloads"}: ${counts?.downloads ?? 0}\n` +
        `🏭 ${fa ? "کارهای Actions در جریان" : "Actions jobs"}: ${counts?.jobs ?? 0}\n` +
        `💾 ${fa ? "ترافیک ۷ روز" : "download volume 7d"}: ${fmt((dlUse?.bytes ?? 0) / 1048576)} MB\n\n` +
        `🐙 <b>${fa ? "سهمیه گیت‌هاب" : "GitHub quota"}</b>\n` +
        (core ? `core: ${core.remaining}/${core.limit} ${meterBar((core.remaining / core.limit) * 100)}\n` : "") +
        (search ? `search: ${search.remaining}/${search.limit} ${meterBar((search.remaining / search.limit) * 100)}\n` : "") +
        (graphql ? `graphql: ${graphql.remaining}/${graphql.limit}\n` : "") +
        `\n🤖 <b>${fa ? "مصرف AI امروز" : "AI usage today"}</b>\n` +
        ((aiUse.results ?? []).map((r) => `• ${r.feature}: ${r.calls} ${fa ? "تماس" : "calls"} · ${fmt(r.tokens)} tokens`).join("\n") || "—") +
        `\n\n📈 <b>${fa ? "فعالیت ۷ روز" : "activity 7d"}</b>\n` +
        ((top.results ?? []).map((r) => `• ${r.kind}: ${fmt(r.c)}`).join("\n") || "—"),
      kb(
        [
          { text: "📣 " + (fa ? "پیام همگانی" : "Broadcast"), cb: "adm:broadcast" },
          { text: "🚩 " + (fa ? "فلگ‌ها" : "Flags"), cb: "adm:flags" },
        ],
        [
          { text: "📊 " + (fa ? "اسنپ‌شات دستی" : "Force snapshot"), cb: "adm:snapshot" },
          { text: "🧹 " + (fa ? "پاکسازی" : "Cleanup"), cb: "adm:cleanup" },
        ],
        [
          { text: "🧪 " + (fa ? "تست AI" : "AI self-test"), cb: "adm:aitest" },
        ],
        
      ),
      !!h.cbId,
    );
  }

  async flags(h: H) {
    const fa = h.loc === "fa";
    if (!isAdmin(h.env, h.u.id)) return;
    const { results } = await h.env.DB.prepare(`SELECT key, value, updated_at FROM flags ORDER BY key`).all<any>().catch(() => ({ results: [] as any[] }));
    const rows = results ?? [];
    await h.reply(
      `🚩 <b>Feature flags</b>\n\n` +
        (rows.length ? rows.map((r) => `• <code>${tgEscape(r.key)}</code> = <b>${tgEscape(r.value)}</b>`).join("\n")
          : `<i>${fa ? "فلگی تنظیم نشده. با دستور زیر اضافه کن:" : "none set. add with:"}\n<code>/flag trending_engine off</code></i>`),
      kb(rows.slice(0, 8).map((r) => [{ text: `🔁 ${r.key} → ${r.value === "on" ? "off" : "on"}`, cb: `adm:flag:${r.key}:${r.value === "on" ? "off" : "on"}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "adm:home" }]),
      !!h.cbId,
    );
  }

  async setFlag(h: H, key: string, value: string) {
    if (!isAdmin(h.env, h.u.id)) return;
    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind(key, value, Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast(`🚩 ${key} = ${value}`);
    return this.flags(h);
  }

  async broadcast(h: H, text?: string) {
    const fa = h.loc === "fa";
    if (!isAdmin(h.env, h.u.id)) return;
    if (!text) {
      await setMode(h.session, "adm:broadcast");
      return h.reply(`📣 ${fa ? "متن پیام همگانی را بفرست (HTML مجاز است)." : "Send broadcast text."}`,
        kb([[{ text: "◀️ " + (fa ? "لغو" : "Cancel"), cb: "adm:home" }]]));
    }
    const count = await h.env.DB.prepare(`SELECT COUNT(*) AS c FROM users WHERE banned=0`).first<{ c: number }>().catch(() => null);
    await h.env.DB.prepare(`INSERT OR REPLACE INTO digest_queue (id, user_id, kind, payload, send_after) VALUES (?,?,?,?,?)`)
      .bind(`bcast:${Date.now()}`, 0, "broadcast", JSON.stringify({ text }), Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.reply(`📣 ${fa ? "پیام برای" : "Queued for"} <b>${count?.c ?? 0}</b> ${fa ? "کاربر در صف قرار گرفت." : "users."}`,
      kb([[{ text: "◀️", cb: "adm:home" }]]));
  }

  async aitest(h: H) {
    if (!isAdmin(h.env, h.u.id)) return;
    await h.loading("🧪 …");
    const probes: [string, () => Promise<string>][] = [
      ["fast (8B)", () => h.ai.chat("Reply with exactly: OK", { tier: "fast", max_tokens: 8 })],
      ["smart (70B)", () => h.ai.chat("Reply with exactly: OK", { tier: "smart", max_tokens: 8 })],
      ["code (Qwen)", () => h.ai.chat("Write the word OK", { tier: "code", max_tokens: 8 })],
      ["embed (bge-m3)", async () => ((await h.ai.embedOne("test")).length ? "1024-dim ✅" : "❌")],
      ["whisper", async () => "skip (needs audio input)"],
      ["translate", () => h.ai.translate("Hello world, this is a test.", "fa", "text")],
    ];
    const lines: string[] = [];
    for (const [name, fn] of probes) {
      const t0 = Date.now();
      try {
        const out = await fn();
        lines.push(`${out && !out.startsWith("❌") ? "✅" : "⚠️"} <b>${name}</b> — ${(Date.now() - t0) / 1000}s — <code>${tgEscape(String(out).slice(0, 80))}</code>`);
      } catch (e: any) {
        lines.push(`❌ <b>${name}</b> — <code>${tgEscape(String(e?.message ?? e).slice(0, 80))}</code>`);
      }
    }
    await h.reply(`🧪 <b>AI self-test</b>\n\n${lines.join("\n")}`, kb([[{ text: "◀️", cb: "adm:home" }]]));
  }
}
