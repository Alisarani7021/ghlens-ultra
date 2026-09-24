import pathlib, sys

def edit(path, old, new, count=1):
    p = pathlib.Path(path); s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}:\n   {old[:110]!r}"); sys.exit(1)
    p.write_text(s.replace(old, new, count)); print(f"ok {path}")

# ════════════════════════════════════════════════════════════════════════════
# ① leaderboard: a bot is not a competitor
# ════════════════════════════════════════════════════════════════════════════
edit("src/core/db.ts", '''  async leaderboard(metric = "queries", limit = 10) {
    const { results } = await this.env.DB.prepare(
      `SELECT l.user_id, l.value, u.first_name, u.username, u.level FROM leaderboard l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.week=? AND l.metric=? ORDER BY l.value DESC LIMIT ?`,
    ).bind(Store.week(), metric, limit).all<any>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }''',
'''  /**
   * The weekly board: **humans only**.
   *
   * The bot's own account and the test identities used by the audit endpoints
   * were competing on a public leaderboard (`Self` sat in second place with 18
   * points, and the bot itself appeared first) — which reads as fake data even
   * though every row is real. The filter is on identity, never on score:
   *
   *   • ids below 10^6 are the synthetic rows the seed/self-test writes
   *   • `Self` is the identity `/selfcheck` runs as
   *   • a username ending in `bot` is a bot account (the bot's own included)
   *   • banned users do not rank
   */
  async leaderboard(metric = "queries", limit = 10) {
    const { results } = await this.env.DB.prepare(
      `SELECT l.user_id, l.value, u.first_name, u.username, u.level FROM leaderboard l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.week=? AND l.metric=?
         AND l.user_id >= 1000000
         AND COALESCE(u.first_name,'') <> 'Self'
         AND LOWER(COALESCE(u.username,'')) NOT LIKE '%bot'
         AND COALESCE(u.banned,0) = 0
       ORDER BY l.value DESC LIMIT ?`,
    ).bind(Store.week(), metric, limit).all<any>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }

  /** Every row that can appear on a board — for the dashboard's totals. */
  async leaderboardSize(metric = "queries") {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leaderboard l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.week=? AND l.metric=? AND l.user_id >= 1000000
         AND COALESCE(u.first_name,'') <> 'Self' AND LOWER(COALESCE(u.username,'')) NOT LIKE '%bot'
         AND COALESCE(u.banned,0) = 0`,
    ).bind(Store.week(), metric).first<{ n: number }>().catch(() => null);
    return Number(row?.n ?? 0);
  }''')

# ════════════════════════════════════════════════════════════════════════════
# ② the Pro button: a request that lands somewhere and answers the user
# ════════════════════════════════════════════════════════════════════════════
edit("src/features/profile.ts", '''  async plans(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `⚡ <b>${fa ? "پلن‌ها" : "Plans"}</b>\\n\\n` +
        `🆓 <b>Free</b> — ${fa ? "روزی ۱۲۰ جست‌وجو، کاوش کامل، ترجمه README، دانلود تا ۱۰۰ مگ" : "120 queries/day"}\\n` +
        `💎 <b>Pro</b> — ${fa ? "نامحدود، کاوش عمیق نامحدود، ترجمهٔ README بی‌سقف، دانلود بدون سقف، هشدار لحظه‌ای، آلرت امنیتی اختصاصی" : "unlimited"}\\n` +
        `🏢 <b>Team</b> — ${fa ? "۵۰ عضو، داشبورد سازمانی، Webhook اختصاصی، SLA" : "50 seats, org dashboard"}\\n\\n` +
        `<i>${fa ? "نسخه فعلی این ربات کاملاً رایگان و اوپن‌سورس است؛ پلن‌ها فقط برای مصارف سنگین (Actions و AI) تعریف شده‌اند." : ""}</i>`,
      kb(
        [{ text: "💎 " + (fa ? "درخواست Pro" : "Request Pro"), cb: "me:pro" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  }''',
'''  async plans(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const plan = (u?.plan ?? "free") as string;
    const req = await readPlanRequest(h.env, h.u.id);
    const planLine =
      plan === "pro" ? (fa ? "💎 <b>Pro فعال است</b>" : "💎 <b>Pro active</b>")
      : plan === "sponsor" ? (fa ? "🤝 <b>حامی</b>" : "🤝 <b>Sponsor</b>")
      : (fa ? "🆓 <b>Free</b>" : "🆓 <b>Free</b>");

    /* The button used to re-render this same screen: the request was written,
       the user never saw a change, and the admins were never told. It now opens a
       confirmation, records the request, tells the admins, and — when the plan is
       granted — the same card reports it. */
    const status = req
      ? req.status === "pending"
        ? `\\n\\n⏳ ${fa ? `درخواست Pro تو <b>در بررسی است</b> (${new Date(req.at).toISOString().slice(0, 10)}). به‌محض فعال شدن خبر می‌دهم.` : "your Pro request is pending"}`
        : `\\n\\n✅ ${fa ? "آخرین درخواستت بررسی و ثبت شد." : "last request resolved"}`
      : "";

    const buttons = req?.status === "pending"
      ? [[{ text: "❌ " + (fa ? "لغو درخواست" : "Cancel request"), cb: "me:procancel" }],
         [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]]
      : [[{ text: "💎 " + (fa ? "درخواست Pro" : "Request Pro"), cb: "me:pro" }],
         [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }]];

    await h.reply(
      `⚡ <b>${fa ? "پلن‌ها" : "Plans"}</b>\\n\\n` +
        `${fa ? "پلن فعلی تو" : "your plan"}: ${planLine}${status}\\n\\n` +
        `🆓 <b>Free</b> — ${fa ? "روزی ۲۰۰ پرس‌وجوی AI، کاوش کامل، ترجمهٔ README، دانلود تا ۱۰۰ مگ" : "200 AI queries/day"}\\n` +
        `💎 <b>Pro</b> — ${fa ? "سقف AI سه برابر، کاوش عمیق بی‌سقف، ترجمهٔ README بی‌سقف، دانلود بدون سقف، هشدار لحظه‌ای" : "unlimited"}\\n` +
        `🏢 <b>Team</b> — ${fa ? "۵۰ عضو، داشبورد سازمانی، وبهوک اختصاصی، SLA" : "50 seats, org dashboard"}\\n\\n` +
        `<i>${fa ? "کل ربات رایگان و اوپن‌سورس است؛ پلن‌ها فقط سقف مصرف را جابه‌جا می‌کنند و به کلیدی در انبار نیاز ندارند." : ""}</i>`,
      kb(buttons as any),
      !!h.cbId,
    );
  }

  /** Confirm before a request is filed — a button that asks, then does. */
  async proRequest(h: H) {
    const fa = h.loc === "fa";
    const existing = await readPlanRequest(h.env, h.u.id);
    if (existing?.status === "pending") {
      await h.toast(fa ? "⏳ درخواستت در بررسی است" : "⏳ pending", true);
      return this.plans(h);
    }
    return h.reply(
      `💎 <b>${fa ? "درخواست پلن Pro" : "Request Pro"}</b>\\n\\n` +
        `<blockquote>${fa ? "درخواست تو برای ادمین‌ها ثبت می‌شود و همین‌جا وضعیتش را می‌بینی. Pro فقط سقف مصرف را بالا می‌برد: سقف AI روزانه سه برابر، کاوش عمیق بی‌سقف و دانلود بدون سقف. هیچ هزینه‌ای ندارد." : "Your request is recorded for the admins."}</blockquote>`,
      kb(
        [{ text: "✅ " + (fa ? "ثبت درخواست" : "Submit"), cb: "me:pro2" }],
        [{ text: "◀️ " + (fa ? "پلن‌ها" : "Plans"), cb: "me:plan" }],
      ),
      !!h.cbId,
    );
  }

  /** File it: one row for the bot, one message for the admins. */
  async submitPro(h: H) {
    const fa = h.loc === "fa";
    const u = await this.store_user(h);
    const at = Date.now();
    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind(`planreq:${h.u.id}`, JSON.stringify({ status: "pending", at, xp: u?.xp ?? 0, plan: u?.plan ?? "free" }), at)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    // the admins get a card they can act on, not a silent database row
    const admins = String(h.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const a of admins.slice(0, 5)) {
      await h.tg.sendMessage(
        a,
        `💎 <b>${fa ? "درخواست Pro تازه" : "New Pro request"}</b>\\n\\n` +
          `👤 ${tgEscape(u?.first_name ?? "?")}${u?.username ? ` (@${tgEscape(u.username)})` : ""} · <code>${h.u.id}</code>\\n` +
          `🏅 XP: <b>${fmt(u?.xp ?? 0)}</b> · 📊 ${fa ? "امتیاز هفته" : "weekly"}: <b>${await this.weekPoints(h, h.u.id)}</b>\\n` +
          `🗓 ${new Date(at).toISOString().slice(0, 16).replace("T", " ")}`,
        { parse_mode: "HTML", reply_markup: kb(
          [{ text: "✅ " + (fa ? "فعال کن (Pro)" : "Grant Pro"), cb: `adm:plan:${h.u.id}:pro` }],
          [{ text: "🆓 " + (fa ? "رد کن (Free بماند)" : "Keep Free"), cb: `adm:plan:${h.u.id}:free` }],
        ) as any },
      ).catch(() => null);
    }

    await h.reply(
      `✅ <b>${fa ? "درخواست ثبت شد" : "Request recorded"}</b>\\n\\n` +
        `<blockquote>${admins.length
          ? (fa ? `به ${admins.length} ادمین اطلاع داده شد. وضعیت را می‌توانی همین‌جا ببینی.` : `notified ${admins.length} admins`)
          : (fa ? "ادمینی تنظیم نشده؛ درخواست در پروندهٔ تو ثبت شد و در داشبورد دیده می‌شود." : "no admin configured")}</blockquote>`,
      kb([[{ text: "◀️ " + (fa ? "پلن‌ها" : "Plans"), cb: "me:plan" }]]),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "plan_request", "pro");
  }

  async cancelPro(h: H) {
    const fa = h.loc === "fa";
    await h.env.DB.prepare(`DELETE FROM flags WHERE key=?`).bind(`planreq:${h.u.id}`)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.toast(fa ? "❌ درخواست لغو شد" : "❌ cancelled", true);
    return this.plans(h);
  }

  private async store_user(h: H) {
    return h.store.user(h.u.id);
  }

  private async weekPoints(h: H, userId: number) {
    const row = await h.env.DB.prepare(`SELECT value FROM leaderboard WHERE week=? AND user_id=? AND metric='queries'`)
      .bind(Store.week(), userId).first<{ value: number }>().catch(() => null);
    return Number(row?.value ?? 0);
  }''')

print("batch A part 1 written")
