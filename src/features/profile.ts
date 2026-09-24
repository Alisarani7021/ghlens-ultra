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

    /* The profile as a document: a stats table, the XP meter as an aside,
       badges and interests as their own lines. */
    const { richDoc } = await import("../hub/richdoc");
    const { table, aside, p } = await import("../tg/rich");
    await h.replyRich(
      richDoc({
        title: `👤 ${tgEscape(u?.first_name ?? h.u.first_name ?? "—")}${u?.username ? ` <code>@${tgEscape(u.username)}</code>` : ""}`,
        meta: github ? `🐙 GitHub: <a href="https://github.com/${tgEscape(github)}">@${tgEscape(github)}</a>` : "",
        body: [
          table([
            [fa ? "شاخص" : "stat", fa ? "مقدار" : "value"],
            [`🎖 ${fa ? "سطح" : "level"}`, `<b>${level}</b> ${"⭐".repeat(Math.min(5, Math.ceil(level / 7)))}`],
            [`📈 XP`, `${fmt(xp)} / ${fmt(Math.round(nextAt))}`],
            [`🏆 ${fa ? "رتبهٔ هفتگی" : "weekly rank"}`, `<b>${rank ? "#" + rank : "—"}</b>`],
            [`💠 ${fa ? "پلن" : "plan"}`, `<b>${u?.plan ?? "free"}</b>`],
            [`🔎 ${fa ? "جست‌وجوی امروز" : "queries today"}`, String(u?.daily_queries ?? 0)],
            [`⭐ ${fa ? "علاقه‌مندی‌ها" : "favourites"}`, `<b>${favs}</b>`],
            [`🔔 ${fa ? "اشتراک‌ها" : "subscriptions"}`, `<b>${subs}</b>`],
          ]),
          aside(`📈 ${bar(pct, 12)} <b>${pct}%</b> ${fa ? "تا سطح بعدی" : "to next level"}`, `XP ${fmt(xp)}`),
          badges.length ? p(`🎖 ${fa ? "نشان‌ها" : "badges"}: ${badges.join(" ")}`) : "",
          p(interests.length
            ? `🧠 ${fa ? "علاقه‌مندی‌ها" : "interests"}: ${interests.map((t) => code(t)).join(" ")}`
            : `<i>${fa ? "علاقه‌مندی‌هایت را تنظیم کن تا فید شخصی‌سازی‌شده بگیری." : "Set interests for a personalised feed."}</i>`),
        ].filter(Boolean).join("\n"),
      }),
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

    /* The dashboard is three small tables — activity, AI usage, languages —
       instead of three lists with bullets. */
    const { richDoc } = await import("../hub/richdoc");
    const { table, aside } = await import("../tg/rich");
    const mk = (head: string[], body: string[][]): string =>
      body.length ? table([head, ...body]) : "";
    await h.replyRich(
      richDoc({
        title: `📊 ${fa ? "داشبورد ۳۰ روز اخیر" : "30-day dashboard"}`,
        meta: `⚡ ${fa ? "کل فعالیت‌ها" : "total actions"}: <b>${fmt(totals)}</b> · 🔥 ${fa ? "روزهای پیوسته" : "streak"}: <b>${streak}</b> 🔥`,
        body: [
          spark ? aside(`📈 <code>${spark}</code>`, fa ? "روند ۳۰ روزه" : "30-day trend") : "",
          mk(
            [fa ? "فعالیت" : "activity", fa ? "دفعات" : "count"],
            (events.results ?? []).map((r) => [activityLabel(r.kind, fa), `<b>${fmt(r.c)}</b>`]),
          ),
          mk(
            [`🤖 ${fa ? "قابلیت" : "feature"}`, fa ? "درخواست" : "calls", fa ? "توکن" : "tokens"],
            (aiUse.results ?? []).map((r) => [String(r.feature), String(r.calls), fmt(r.tokens)]),
          ),
          mk(
            [`🧩 ${fa ? "زبان" : "language"}`, fa ? "علاقه‌مندی" : "favourites"],
            (favLangs.results ?? []).map((r) => [tgEscape(r.language ?? "—"), String(r.c)]),
          ),
          aside(`🔔 ${fa ? "اشتراک‌های فعال" : "active subscriptions"}: <b>${subs?.c ?? 0}</b>`),
        ].filter(Boolean).join("\n"),
      }),
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
    /* A board is a table: rank, person, points, level. The rich document
       renders it bordered and striped; the automatic fallback of the rich
       send rewrites it as one «cell · cell · cell» line per person. */
    const { richDoc } = await import("../hub/richdoc");
    const { table } = await import("../tg/rich");
    const boardRows: string[][] = [
      ["#", fa ? "کاربر" : "user", fa ? "امتیاز" : "pts", fa ? "سطح" : "lvl"],
      ...(rows.length ? rows.map((r: any, i2: number) => {
        /* A row with no name is a real person the bot has not been introduced
           to yet (their name arrives with a message, not a button press).
           Say that, instead of a bare «?». */
        const clean = String(r.first_name ?? "").trim();
        const name = clean && !["?", "-", "Self"].includes(clean)
          ? clean
          : r.username ? `@${r.username}` : `#…${String(r.user_id).slice(-4)}`;
        return [
          medals[i2] ?? String(i2 + 1),
          `${tgEscape(name)}${r.user_id === h.u.id ? " ⬅️" : ""}`,
          `<b>${fmt(r.value)}</b>`,
          String(r.level ?? 1),
        ];
      }) : [["—", fa ? "هنوز کسی امتیاز نگرفته" : "nobody has scored yet", "—", "—"]]),
    ];
    await h.replyRich(
      richDoc({
        title: `🏆 ${fa ? "لیدربورد این هفته" : "Weekly leaderboard"}`,
        meta: `<code>${Store.week()}</code> · ${fa ? "رتبه تو" : "your rank"}: <b>${me ? "#" + me : "—"}</b> · ${fa ? "فقط کاربران واقعی" : "humans only"}`,
        body: table(boardRows, { caption: fa ? "امتیاز از جست‌وجو، کاوش، ترجمه و دانلود" : "points from searches, scouts, translations, downloads" }),
        footer: fa ? "هفته‌ای ۵ برتر می‌توانند نشان طلایی بگیرند." : "Weekly top 5 can earn the gold badge.",
      }),
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
    const state = await this.planState(h);
    /* The price list as a matrix: one row per plan, one column per thing the
       plan changes. Pro is described honestly — it lifts the quotas that cost
       real money on a free deployment. */
    const { richDoc } = await import("../hub/richdoc");
    const { table, aside } = await import("../tg/rich");
    await h.replyRich(
      richDoc({
        title: `⚡ ${fa ? "پلن‌ها" : "Plans"}`,
        meta: `${fa ? "وضعیت تو" : "your plan"}: <b>${state.plan === "pro" ? "💎 Pro" : "🆓 Free"}</b>` +
          (state.requested && state.plan !== "pro" ? ` · <i>${fa ? "درخواست Pro ثبت شده" : "Pro requested"}</i>` : ""),
        body: table([
          [fa ? "پلن" : "plan", fa ? "جست‌وجو" : "searches", fa ? "ترجمهٔ README" : "README", fa ? "دانلود" : "download"],
          ["🆓 Free", fa ? "۱۲۰ در روز" : "120/day", fa ? "با سقف روزانه" : "daily cap", fa ? "تا ۱۰۰ مگ" : "≤100 MB"],
          ["💎 Pro", fa ? "نامحدود" : "unlimited", fa ? "بی‌سقف" : "unlimited", fa ? "بدون سقف + اولویت صف" : "uncapped + queue priority"],
          ["🏢 Team", fa ? "۵۰ عضو" : "50 seats", fa ? "نامحدود سازمانی" : "org-wide", fa ? "Webhook اختصاصی · SLA" : "dedicated webhook · SLA"],
        ]) +
          (fa ? "\n" + aside("این نسخهٔ ربات کاملاً رایگان و اوپن‌سورس است؛ پلن‌ها فقط سهمیه‌هایی را برمی‌دارند که واقعاً هزینه دارند — نئورون Workers AI و اجرای Actions.", "شفاف") : ""),
      }),
      kb(
        state.plan === "pro"
          ? [{ text: "✅ " + (fa ? "Pro فعال است" : "Pro is active"), cb: "noop:noop:0" }]
          : state.requested
            ? [{ text: "⏳ " + (fa ? "درخواست در انتظار تأیید" : "request pending"), cb: "me:pro" }]
            : [{ text: "💎 " + (fa ? "درخواست Pro" : "Request Pro"), cb: "me:pro" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Pro state for this user: the plan flag and any open request. */
  async planState(h: H): Promise<{ plan: "free" | "pro"; requested: boolean }> {
    const get = async (key: string) =>
      (await h.env.DB.prepare(`SELECT value FROM flags WHERE key=?`).bind(key).first<{ value: string }>().catch(() => null))?.value ?? "";
    const plan = (await get(`plan:${h.u.id}`)) === "pro" ? "pro" : "free";
    const requested = !!(await get(`pro:req:${h.u.id}`));
    return { plan, requested };
  }

  /**
   * «💎 درخواست Pro».
   *
   * The button used to re-render the price list — a press with no effect, which
   * is indistinguishable from a broken button. It now does the thing it says:
   * records the request, tells the owner's admins with two buttons that settle
   * it, and gives the requester a card showing exactly what changes and what the
   * wait looks like. What Pro *means* is stated honestly: the deployment is free
   * and open-source, and Pro lifts the quotas that cost real money (model quota,
   * heavy Actions jobs, unlimited downloads).
   */
  async requestPro(h: H) {
    const fa = h.loc === "fa";
    const state = await this.planState(h);
    const who = `@${h.u.username ?? "—"} · <code>${h.u.id}</code>`;

    if (state.plan === "pro") {
      return h.reply(
        `💎 <b>${fa ? "Pro روی حساب تو فعال است" : "Pro is active"}</b>\n\n` +
          (fa
            ? `سقف روزانهٔ تو برداشته شده، صف کارهای سنگین برای تو باز است و آرشیو کامل بدون سقف حجم دانلود می‌شود.`
            : `Your daily cap is lifted, heavy jobs are open to you, and downloads are uncapped.`),
        kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]),
        !!h.cbId,
      );
    }

    if (state.requested) {
      return h.reply(
        `⏳ <b>${fa ? "درخواست Pro ثبت شده است" : "Pro request is in"}</b>\n\n` +
          (fa
            ? `درخواستت در صف بررسی است. تا آن موقع همهٔ قابلیت‌ها با سقف رایگان کار می‌کنند؛ فقط سهمیهٔ روزانه و کارهای سنگین محدودند.\n\n` +
              `اگر عجله داری، یک بار در چت یادآوری کن — همان درخواست دوباره بررسی می‌شود.`
            : `Your request is queued. Everything keeps working on the free tier meanwhile.`),
        kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]),
        !!h.cbId,
      );
    }

    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind(`pro:req:${h.u.id}`, String(Date.now()), Date.now()).run()
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    // Tell every configured admin, with the two buttons that settle it.
    const admins = (h.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const a of admins) {
      await h.tg.sendMessage(Number(a),
        `💎 <b>${fa ? "درخواست Pro تازه" : "New Pro request"}</b>\n\n` +
          `👤 ${who}${h.u.first_name ? ` — ${tgEscape(h.u.first_name)}` : ""}\n` +
          `📊 ${fa ? "سهمیه امروز" : "today"}: ${h.user?.daily_queries ?? 0}/${h.env.FREE_TIER_DAILY_QUERIES ?? 120}\n` +
          `🗓 <code>${new Date().toISOString().slice(0, 16).replace("T", " ")}</code>\n\n` +
          (fa ? "با فعال‌کردن، سقف روزانه‌اش برداشته می‌شود و کارهای سنگین برایش باز می‌شود." : ""),
        {
          parse_mode: "HTML",
          reply_markup: kb([
            { text: "✅ " + (fa ? "فعال کن" : "Grant"), cb: `adm:prog:${h.u.id}` },
            { text: "🗑 " + (fa ? "رد کن" : "Decline"), cb: `adm:pror:${h.u.id}` },
          ]) as any,
        },
      ).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }

    return h.reply(
      `💎 <b>${fa ? "درخواست Pro ثبت شد" : "Pro request recorded"}</b>\n\n` +
        (fa
          ? `<blockquote>نوبت تو در صف است. همان لحظه‌ای که فعال شود، همین‌جا پیام می‌گیری — لازم نیست کاری بکنی.</blockquote>\n\n` +
            `<b>با Pro چه چیزی عوض می‌شود</b>\n` +
            `• سقف روزانهٔ ${h.env.FREE_TIER_DAILY_QUERIES ?? 120} درخواست برداشته می‌شود\n` +
            `• صف کارهای سنگین (تحلیل عمیق، ساخت بسته، اسکن کامل) برایت باز است\n` +
            `• دانلود سورس بدون سقف، با اولویت در صف Actions\n\n` +
            `<i>این نسخه رایگان و اوپن‌سورس است؛ Pro فقط سهمیه‌هایی را برمی‌دارد که واقعاً هزینه دارند (نئورون Workers AI و اجرای Actions).</i>`
          : `You are queued. You will be told here the moment it is granted.`),
      kb(
        [{ text: "📊 " + (fa ? "وضعیت من" : "My status"), cb: "me:home" }],
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
