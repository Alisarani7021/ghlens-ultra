import type { H } from "../core/handler";
import { botUsername } from "../env";
import { GithubRest } from "../github/rest";
import { fmt, rel } from "./cards";
import { bar } from "../github/rest";
import { code, i, tgEscape } from "../tg/types";
import { kb, L } from "../tg/keyboards";
import { Store } from "../core/db";

/** Profile, gamification, favourites, subscriptions, dashboard and referral. */
export class ProfileFeature {
  async home(h: H) {
    const fa = h.loc === "fa";
    const u = (await h.store.user(h.u.id)) ?? null;
    const xp = u?.xp ?? 0;
    const level = u?.level ?? 1;
    const nextAt = (120 * level * (level + 1)) / 2;
    const pct = Math.min(100, Math.round((xp / nextAt) * 100));
    const badges: string[] = safeJson(u?.badges) ?? [];
    const interests: string[] = safeJson(u?.interests) ?? [];
    const favs = (await h.store.favs(h.u.id, 100)).results?.length ?? 0;
    const subs = (await h.store.subsOf(h.u.id)).results?.length ?? 0;
    const rank = await this.rank(h);
    const github = u?.github_login;

    await h.reply(
      `👤 <b>${tgEscape(u?.first_name ?? h.u.first_name ?? "—")}</b>${u?.username ? ` <code>@${tgEscape(u.username)}</code>` : ""}\n` +
        (github ? `🐙 GitHub: <a href="https://github.com/${tgEscape(github)}">@${tgEscape(github)}</a>\n` : "") +
        `\n🎖 ${fa ? "سطح" : "Level"} <b>${level}</b> ${"⭐".repeat(Math.min(5, Math.ceil(level / 7)))}   ` +
        `🏆 ${fa ? "رتبه هفتگی" : "weekly rank"}: <b>${rank ? "#" + rank : "—"}</b>\n` +
        `📈 XP: <b>${fmt(xp)}</b> / ${fmt(Math.round(nextAt))}  ${bar(pct, 12)} ${pct}%\n` +
        `💠 ${fa ? "پلن" : "plan"}: <b>${u?.plan ?? "free"}</b>   🔎 ${fa ? "جست‌وجو" : "queries"}: ${u?.daily_queries ?? 0}\n` +
        `⭐ ${fa ? "علاقه‌مندی" : "favourites"}: <b>${favs}</b>   🔔 ${fa ? "اشتراک" : "subs"}: <b>${subs}</b>\n\n` +
        (badges.length ? `🎖 ${fa ? "نشان‌ها" : "badges"}: ${badges.join(" ")}\n\n` : "") +
        (interests.length ? `🧠 ${fa ? "علاقه‌مندی‌ها" : "interests"}: ${interests.map((t) => code(t)).join(" ")}\n` : `<i>${fa ? "علاقه‌مندی‌هایت را تنظیم کن تا فید شخصی‌سازی‌شده بگیری." : "Set interests for a personalised feed."}</i>`),
      kb(
        [
          { text: "⭐ " + (fa ? "علاقه‌مندی‌ها" : "Favourites"), cb: "f:list" },
          { text: "🔔 " + (fa ? "اشتراک‌ها" : "Subscriptions"), cb: "sub:list" },
        ],
        [
          { text: "📊 " + (fa ? "داشبورد" : "Dashboard"), cb: "me:dash" },
          { text: "🧠 " + (fa ? "علاقه‌مندی‌ها را تنظیم کن" : "Set interests"), cb: "me:interests" },
        ],
        [
          { text: "🏆 " + (fa ? "لیدربورد" : "Leaderboard"), cb: "me:board" },
          { text: "🎁 " + (fa ? "دعوت دوستان" : "Refer friends"), cb: "me:ref" },
        ],
        github
          ? [{ text: "🐙 " + (fa ? "وضعیت حساب" : "Account status"), cb: "gh:home" }]
          : [{ text: "🐙 " + (fa ? "اتصال گیت‌هاب" : "Link GitHub"), cb: "me:link" },
             { text: "🤝 " + (fa ? "اهدای کلید AI" : "Donate AI key"), cb: "keys:home" }],
        [
          { text: "⚡ " + (fa ? "ارتقای حساب" : "Upgrade account"), cb: "me:plan" },
          { text: "📤 " + (fa ? "خروجی داده‌های من" : "Export my data"), cb: "me:export" },
        ],
      ),
      !!h.cbId,
    );
  }

  private async rank(h: H) {
    const board = await h.store.leaderboard("queries", 50);
    const idx = board.findIndex((r: any) => r.user_id === h.u.id);
    return idx >= 0 ? idx + 1 : null;
  }

  /** Personal dashboard: activity, streak, top languages, AI usage. */
  async dash(h: H) {
    const fa = h.loc === "fa";
    const userId = h.u.id;
    const [events, aiUse, favLangs, subs] = await Promise.all([
      h.env.DB.prepare(
        `SELECT kind, COUNT(*) AS c FROM events WHERE user_id=? AND ts > ? GROUP BY kind ORDER BY c DESC LIMIT 8`,
      ).bind(userId, Date.now() - 30 * 86400000).all<{ kind: string; c: number }>().catch(() => ({ results: [] as any[] })),
      h.env.DB.prepare(
        `SELECT feature, SUM(calls) AS calls, SUM(tokens) AS tokens FROM ai_usage WHERE user_id=? GROUP BY feature ORDER BY calls DESC LIMIT 6`,
      ).bind(userId).all<any>().catch(() => ({ results: [] as any[] })),
      h.env.DB.prepare(
        `SELECT r.language, COUNT(*) AS c FROM favorites f JOIN repos r ON r.full_name=f.full_name WHERE f.user_id=? GROUP BY r.language ORDER BY c DESC LIMIT 6`,
      ).bind(userId).all<{ language: string; c: number }>().catch(() => ({ results: [] as any[] })),
      h.env.DB.prepare(`SELECT COUNT(*) AS c FROM subscriptions WHERE user_id=?`).bind(userId).first<{ c: number }>().catch(() => null),
    ]);

    // 30-day activity sparkline of queries
    const daily = await h.env.DB.prepare(
      `SELECT date(ts/1000,'unixepoch') AS d, COUNT(*) AS c FROM events WHERE user_id=? AND kind IN ('search','scout','rag','dossier') AND ts > ? GROUP BY d ORDER BY d ASC`,
    ).bind(userId, Date.now() - 30 * 86400000).all<{ d: string; c: number }>().catch(() => ({ results: [] as any[] }));
    const spark = sparkline((daily.results ?? []).map((r) => r.c));

    const streak = computeStreak((daily.results ?? []).map((r) => r.d));
    const totals = (events.results ?? []).reduce((s, r) => s + r.c, 0);

    await h.reply(
      `📊 <b>${fa ? "داشبورد ۳۰ روز اخیر" : "30-day dashboard"}</b>\n\n` +
        `⚡ ${fa ? "کل فعالیت‌ها" : "total actions"}: <b>${fmt(totals)}</b>   🔥 ${fa ? "روزهای پیوسته" : "streak"}: <b>${streak}</b> 🔥\n` +
        (spark ? `📈 <code>${spark}</code>\n\n` : "") +
        `<b>${fa ? "فعالیت‌ها" : "Activity"}</b>\n` +
        ((events.results ?? []).map((r) => `• ${activityLabel(r.kind, fa)}: <b>${fmt(r.c)}</b>`).join("\n") || "—") +
        `\n\n<b>🤖 ${fa ? "مصرف هوش مصنوعی" : "AI usage"}</b>\n` +
        ((aiUse.results ?? []).map((r) => `• ${r.feature}: ${r.calls} ${fa ? "درخواست" : "calls"} · ${fmt(r.tokens)} tokens`).join("\n") || "—") +
        `\n\n<b>🧩 ${fa ? "زبان‌های مورد علاقه‌ات" : "Your languages"}</b>\n` +
        ((favLangs.results ?? []).map((r) => `• ${tgEscape(r.language ?? "—")} — ${r.c}`).join("\n") || "—") +
        `\n\n🔔 ${fa ? "اشتراک‌های فعال" : "active subscriptions"}: <b>${subs?.c ?? 0}</b>`,
      kb(
        [
          { text: "⭐ " + (fa ? "علاقه‌مندی‌ها" : "Favourites"), cb: "f:list" },
          { text: "🔔 " + (fa ? "اشتراک‌ها" : "Subs"), cb: "sub:list" },
        ],
        [{ text: "🏆 " + (fa ? "لیدربورد" : "Leaderboard"), cb: "me:board" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  async interests(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const cur: string[] = safeJson(u?.interests) ?? [];
    const options = [
      "llm", "agents", "python", "typescript", "golang", "rust", "docker", "kubernetes",
      "security", "privacy", "vpn", "networking", "database", "frontend", "react", "flutter",
      "devops", "selfhosted", "osint", "cli", "machine-learning", "webassembly", "telegram", "automation",
    ];
    const rows: { text: string; cb: string }[][] = [];
    for (let i = 0; i < options.length; i += 3) {
      rows.push(options.slice(i, i + 3).map((o) => ({ text: (cur.includes(o) ? "✅ " : "➕ ") + o, cb: `me:t:${o}` })));
    }
    await h.reply(
      `🧠 <b>${fa ? "علاقه‌مندی‌ها" : "Interests"}</b>\n\n${fa
        ? "انتخاب‌هایت فید روزانه، پیشنهاد پروژه و هشدار ریلیز را شخصی‌سازی می‌کند."
        : "Choices personalise your daily feed and recommendations."}\n\n` +
        `${fa ? "انتخاب‌شده" : "selected"}: ${cur.map((t) => code(t)).join(" ") || "—"}`,
      kb(...rows, [{ text: "✅ " + (fa ? "تمام" : "Done"), cb: "me:home" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]),
      !!h.cbId,
    );
  }

  async toggleInterest(h: H, tag: string) {
    const u = await h.store.user(h.u.id);
    const cur: string[] = safeJson(u?.interests) ?? [];
    const next = cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag];
    await h.store.setInterests(h.u.id, next);
    await h.toast(cur.includes(tag) ? `➖ ${tag}` : `➕ ${tag}`);
    return this.interests(h);
  }

  // ── favourites ──────────────────────────────────────────────────────────
  async favs(h: H, page = 0) {
    const fa = h.loc === "fa";
    const { results } = await h.store.favs(h.u.id, 100);
    const rows = results ?? [];
    if (!rows.length) {
      return h.reply(
        `⭐ <b>${fa ? "علاقه‌مندی‌ها" : "Favourites"}</b>\n\n${fa ? "خالی است. روی هر مخزنی ⭐ را بزن تا اینجا جمع شود." : "Empty — star repos to collect them here."}`,
        kb([[{ text: "🔥 " + (fa ? "کشف پروژه" : "Discover"), cb: "x:gems" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]]),
        !!h.cbId,
      );
    }
    const slice = rows.slice(page * 10, page * 10 + 10);
    const metas = await Promise.all(slice.map((r) => h.store.repoFresh(r.full_name, 86400)));
    const body = slice.map((r, i2) => {
      const m: any = metas[i2];
      return `${page * 10 + i2 + 1}. <b>${tgEscape(r.full_name)}</b>${m ? ` — ⭐ ${fmt(m.stars)}${m.language ? ` · ${tgEscape(m.language)}` : ""}` : ""}\n` +
        (r.note ? `   📝 ${i(r.note)}\n` : "") +
        `   ➕ ${rel(new Date(r.created_at).toISOString(), fa)}`;
    }).join("\n");
    await h.reply(
      `⭐ <b>${fa ? "علاقه‌مندی‌ها" : "Favourites"}</b> (${rows.length})\n\n${body}`,
      kb(
        ...slice.slice(0, 6).map((r, i2) => [{ text: `${page * 10 + i2 + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        slice.length > 1
          ? [
              { text: "🗑 " + (fa ? "حذف" : "Remove"), cb: `f:rm:${slice[0].full_name}` },
              { text: "📤 " + (fa ? "خروجی JSON" : "Export JSON"), cb: "f:export" },
            ]
          : [],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  async addFav(h: H, full: string) {
    const fa = h.loc === "fa";
    await h.store.fav(h.u.id, full);
    await h.store.addXp(h.u.id, 1, "fav");
    await h.toast(`⭐ ${fa ? "ذخیره شد" : "saved"}`);
    await h.reply(
      `⭐ <b>${tgEscape(full)}</b> ${fa ? "به علاقه‌مندی‌ها اضافه شد." : "added to favourites."}\n\n` +
        (fa ? "می‌خواهی از ریلیزها و تغییرات مهمش باخبر شوی؟" : "Want notifications for its releases?"),
      kb(
        [
          { text: "🔔 " + (fa ? "فقط ریلیزها" : "Releases only"), cb: `sub:add:${full}:release` },
          { text: "📣 " + (fa ? "ریلیز + امنیت" : "Releases + security"), cb: `sub:add:${full}:release,security` },
        ],
        [{ text: "⭐ " + (fa ? "فهرست من" : "My list"), cb: "f:list" }, { text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  async exportFavs(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.store.favs(h.u.id, 500);
    const md = `# ${fa ? "علاقه‌مندی‌های من" : "My favourites"} — GitHub Lens Ultra\n\n` +
      (results ?? []).map((r) => `- [${r.full_name}](https://github.com/${r.full_name})${r.note ? ` — ${r.note}` : ""} (${new Date(r.created_at).toISOString().slice(0, 10)})`).join("\n");
    await h.tg.sendDocument(h.chatId, "ghlens-favourites.md", new TextEncoder().encode(md), `📤 ${fa ? "خروجی علاقه‌مندی‌ها" : "Favourites export"}`);
  }

  // ── subscriptions ───────────────────────────────────────────────────────
  async subs(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.store.subsOf(h.u.id);
    const rows = results ?? [];
    await h.reply(
      `🔔 <b>${fa ? "اشتراک‌ها" : "Subscriptions"}</b>\n\n` +
        (rows.length
          ? rows.map((r, i2) => `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> — ${safeJson(r.events)?.join(", ") ?? "release"}${
              r.muted_until > Date.now() ? " 🔇" : ""}`).join("\n")
          : (fa ? "<i>هنوز چیزی را دنبال نمی‌کنی. با 🔔 روی هر مخزن، از ریلیزها و هشدارهای امنیتی باخبر شو.</i>" : "<i>Nothing yet.</i>")),
      kb(
        ...rows.slice(0, 6).map((r, i2) => [{ text: `${i2 + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        rows.length ? [{ text: "🔇 " + (fa ? "بی‌صدا کردن همه" : "Mute all"), cb: "sub:muteall" }, { text: "🗑 " + (fa ? "لغو همه" : "Unsubscribe all"), cb: "sub:clear" }] : [],
        [
          { text: "🧠 " + (fa ? "از علاقه‌مندی‌ها بساز" : "Build from interests"), cb: "me:interests" },
          { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" },
        ],
      ),
      !!h.cbId,
    );
  }

  async addSub(h: H, full: string, events = "release") {
    const fa = h.loc === "fa";
    const evs = events.split(",").map((e) => e.trim()).filter(Boolean);
    await h.store.subscribe(h.u.id, full, evs.length ? evs : ["release"]);
    await h.toast(`🔔 ${fa ? "فعال شد" : "subscribed"}`);
    await h.reply(
      `🔔 <b>${tgEscape(full)}</b>\n\n${fa ? "اشتراک فعال شد. رویدادها:" : "Subscribed to:"} ${evs.map((e) => code(e)).join(", ")}\n\n` +
        (fa ? "با هر ریلیز/هشدار جدید، همین‌جا پیام می‌گیری — از طریق Webhook لحظه‌ای گیت‌هاب." : "You'll get an instant webhook notification."),
      kb(
        [
          { text: "📣 " + (fa ? "اضافه‌کردن امنیت" : "Add security"), cb: `sub:add:${full}:release,security` },
          { text: "🕒 " + (fa ? "اضافه‌کردن کامیت" : "Add commits"), cb: `sub:add:${full}:release,commits` },
        ],
        [{ text: "🔔 " + (fa ? "اشتراک‌های من" : "My subs"), cb: "sub:list" }, { text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  // ── gamification ────────────────────────────────────────────────────────
  async board(h: H) {
    const fa = h.loc === "fa";
    const rows = await h.store.leaderboard("queries", 15);
    const me = await this.rank(h);
    const medals = ["🥇", "🥈", "🥉"];
    await h.reply(
      `🏆 <b>${fa ? "لیدربورد این هفته" : "Weekly leaderboard"}</b> — ${Store.week()}\n\n` +
        (rows.map((r, i2) => {
          const name = r.first_name ?? r.username ?? `#${r.user_id}`;
          const meMark = r.user_id === h.u.id ? " ⬅️" : "";
          return `${medals[i2] ?? `${i2 + 1}.`} ${tgEscape(name)} — <b>${fmt(r.value)}</b> ${fa ? "امتیاز" : "pts"} <i>(lvl ${r.level ?? 1})</i>${meMark}`;
        }).join("\n") || "—") +
        `\n\n${fa ? "رتبه تو" : "your rank"}: <b>${me ? "#" + me : "—"}</b>\n` +
        `<i>${fa ? "هر جست‌وجو، کاوش، ترجمه و دانلود امتیاز دارد. هفته‌ای ۵ برتر می‌توانند نشان طلایی بگیرند." : ""}</i>`,
      kb(
        [
          { text: "⭐ " + (fa ? "امتیاز من" : "My XP"), cb: "me:home" },
          { text: "🎁 " + (fa ? "دعوت دوستان" : "Invite"), cb: "me:ref" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  async referral(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const link = `https://t.me/${botUsername(h.env)}?start=ref_${u?.referral_code ?? "code"}`;
    const invited = await h.env.DB.prepare(`SELECT COUNT(*) AS c FROM users WHERE referral_by=?`).bind(h.u.id).first<{ c: number }>().catch(() => null);
    await h.reply(
      `🎁 <b>${fa ? "دعوت دوستان" : "Refer friends"}</b>\n\n` +
        `${fa ? "لینک دعوت تو" : "Your invite link"}:\n<code>${link}</code>\n\n` +
        `👥 ${fa ? "دعوت‌شده‌ها" : "invited"}: <b>${invited?.c ?? 0}</b>\n` +
        `🎖 ${fa ? "هر دعوت موفق ۵۰ XP و نشان ویژه دارد." : "Each successful invite = 50 XP."}`,
      kb(
        [{ text: "🔗 " + (fa ? "کپی لینک" : "Copy link"), copy: link }],
        [{ text: "📤 " + (fa ? "اشتراک‌گذاری" : "Share"), url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(fa ? "ربات لنز — کشف هوشمند گیت‌هاب" : "GitHub Lens Ultra")}` }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  async plans(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `⚡ <b>${fa ? "پلن‌ها" : "Plans"}</b>\n\n` +
        `🆓 <b>Free</b> — ${fa ? "روزی ۱۲۰ جست‌وجو، کاوش کامل، ترجمه README، دانلود تا ۱۰۰ مگ" : "120 queries/day"}\n` +
        `💎 <b>Pro</b> — ${fa ? "نامحدود، کاوش عمیق نامحدود، پادکست اختصاصی، دانلود بدون سقف، هشدار لحظه‌ای، آلرت امنیتی اختصاصی" : "unlimited"}\n` +
        `🏢 <b>Team</b> — ${fa ? "۵۰ عضو، داشبورد سازمانی، Webhook اختصاصی، SLA" : "50 seats, org dashboard"}\n\n` +
        `<i>${fa ? "نسخه فعلی این ربات کاملاً رایگان و اوپن‌سورس است؛ پلن‌ها فقط برای مصارف سنگین (Actions و AI) تعریف شده‌اند." : ""}</i>`,
      kb(
        [{ text: "💎 " + (fa ? "درخواست Pro" : "Request Pro"), cb: "me:pro" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Personalised feed, built from interests and favourites (used by /feed and daily digest). */
  async feed(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const interests: string[] = safeJson(u?.interests) ?? [];
    const { results: favs } = await h.store.favs(h.u.id, 30);
    const langs = new Set<string>();
    for (const f of favs ?? []) {
      const meta: any = await h.store.repo(f.full_name);
      if (meta?.language) langs.add(meta.language);
    }
    if (!interests.length && !langs.size) {
      return h.reply(
        `✨ <b>${fa ? "فید شخصی" : "Personal feed"}</b>\n\n${fa ? "برای شخصی‌سازی، علاقه‌مندی‌هایت را تنظیم کن." : "Set interests to personalise."}`,
        kb([[{ text: "🧠 " + (fa ? "تنظیم علاقه‌مندی" : "Set interests"), cb: "me:interests" }], []]),
        !!h.cbId,
      );
    }
    const q = [...interests.slice(0, 4).map((t) => `topic:${t}`), ...[...langs].slice(0, 2).map((l) => `language:${l}`)].join(" OR ") + " stars:>300 pushed:>2026-01-01";
    const res = await h.gh().searchRepos(q, "updated", "desc", 10).catch(() => null);
    const items = res?.items ?? [];
    await h.reply(
      `✨ <b>${fa ? "فید شخصی تو" : "Your feed"}</b>\n<i>${[...interests, ...langs].slice(0, 8).map((t) => code(t)).join(" ")}</i>\n\n` +
        (items.map((r: any, i2: number) =>
          `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stargazers_count)} · 🕒 ${rel(r.pushed_at, fa)}\n   ${i((r.description ?? "").slice(0, 90))}`).join("\n\n") || "—"),
      kb(
        ...items.slice(0, 5).map((r: any) => [{ text: `📦 ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        [{ text: "🧠 " + (fa ? "ویرایش علاقه‌مندی" : "Edit interests"), cb: "me:interests" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }
}

// helpers
function safeJson(s: string | null | undefined): any[] | null {
  try { const v = JSON.parse(s ?? "null"); return Array.isArray(v) ? v : null; } catch { return null; }
}
function sparkline(vals: number[]) {
  if (!vals.length) return "";
  const b = "▁▂▃▄▅▆▇█";
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0), span = max - min || 1;
  return vals.slice(-30).map((v) => b[Math.round(((v - min) / span) * (b.length - 1))]).join("");
}
function computeStreak(days: string[]): number {
  if (!days.length) return 0;
  const set = new Set(days);
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 400; i++) {
    const key = d.toISOString().slice(0, 10);
    if (set.has(key)) streak++;
    else if (i > 0) break;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}
function activityLabel(kind: string, fa: boolean): string {
  const map: Record<string, [string, string]> = {
    search: ["جست‌وجو", "searches"], scout: ["کاوش عمیق", "deep scouts"], rag: ["چت با مخزن", "repo chats"],
    dossier: ["تحلیل AI", "AI dossiers"], translate: ["ترجمه", "translations"], download: ["دانلود", "downloads"],
    download_part: ["پارت دانلود", "parts"], download_fetch: ["دریافت از GitHub", "fetches"],
    trending: ["مرور ترندها", "trending views"], workflow_gen: ["ورک‌فلو", "workflows"], pr_review: ["بازبینی PR", "PR reviews"],
    ai_ask: ["پرسش از AI", "AI asks"], tool: ["جعبه‌ابزار", "tools"], security: ["اسکن امنیت", "security scans"],
  };
  const v = map[kind];
  return v ? (fa ? v[0] : v[1]) : kind;
}
