import pathlib, sys

def edit(path, old, new, count=1):
    p = pathlib.Path(path); s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}:\n   {old[:110]!r}"); sys.exit(1)
    p.write_text(s.replace(old, new, count)); print(f"ok {path}")

# the request's reader lives next to the screen that renders it
p = pathlib.Path("src/features/profile.ts")
s = p.read_text()
anchor = "export class Profile {"
if anchor not in s:
    print("!! Profile class anchor"); sys.exit(1)
helper = '''/**
 * Pro requests are stored as a flag, not as a new table: the bot has one row per
 * user, D1 schema changes do not reach an already-deployed database, and the
 * request is a single small object. `status` moves pending → granted/denied when
 * an admin presses the card, so the user's plans screen can tell the truth.
 */
export async function readPlanRequest(env: any, userId: number):
  Promise<{ status: "pending" | "granted" | "denied"; at: number; plan?: string } | null> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM flags WHERE key=?`)
      .bind(`planreq:${userId}`).first<{ value: string }>();
    if (!row?.value) return null;
    const j = JSON.parse(row.value);
    return { status: j.status === "granted" ? "granted" : j.status === "denied" ? "denied" : "pending", at: Number(j.at ?? 0), plan: j.plan };
  } catch {
    return null;
  }
}

'''
s = s.replace(anchor, helper + anchor, 1)
p.write_text(s)
print("ok profile helper")

# ── admin side: the card an admin presses actually changes the plan ─────────
edit("src/features/admin.ts", '''  async flags(h: H) {''',
'''  /**
   * Grant or refuse a Pro request.
   *
   * The admin card is the other half of `me:pro`: the user's request is only a
   * recorded promise until someone with admin rights acts on it, and the user
   * should hear about the outcome in the same chat they asked from.
   */
  async setPlan(h: H, uidRaw: string, plan: "pro" | "free") {
    const fa = h.loc === "fa";
    const uid = Number(uidRaw);
    if (!uid) return h.toast("❌", true);
    await h.env.DB.prepare(`UPDATE users SET plan=? WHERE id=?`).bind(plan, uid)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    const at = Date.now();
    const approved = plan !== "free";
    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind(`planreq:${uid}`, JSON.stringify({ status: approved ? "granted" : "denied", at, plan }), at)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await h.tg.sendMessage(
      uid,
      approved
        ? `🎉 <b>${fa ? "پلن Pro فعال شد" : "Pro granted"}</b>\\n\\n` +
          `<blockquote>${fa ? "از همین لحظه سقف AI روزانه‌ات سه برابر شد، کاوش عمیق بی‌سقف است و دانلود محدودیت ندارد. همین‌جا در «⚡ پلن‌ها» قابل مشاهده است." : "Your plan is now Pro."}</blockquote>`
        : `🆓 <b>${fa ? "پلن Free" : "Free plan"}</b>\\n\\n` +
          `<blockquote>${fa ? "درخواست Pro فعلاً تأیید نشد. ربات برای همه رایگان است و همین سطح هم کار می‌کند؛ هر وقت لازم شد دوباره درخواست بده." : "Request not granted for now."}</blockquote>`,
      { parse_mode: "HTML" },
    ).catch(() => null);
    return h.reply(
      `${approved ? "✅" : "🆓"} <b>${fa ? "پلن ثبت شد" : "plan saved"}</b>\\n\\n` +
        `<code>${uid}</code> → <b>${plan}</b>\\n` +
        `<i>${fa ? "به خود کاربر هم پیام رفت." : "the user was notified"}</i>`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "adm:home" }]]),
      !!h.cbId,
    );
  }

  async flags(h: H) {''')

# ── router: the four keys the new screens emit ─────────────────────────────
edit("src/index.ts", '        if (action === "plan" || action === "pro") return profile.plans(h);',
'''        if (action === "plan") return profile.plans(h);
        // the Pro flow: ask → confirm → submit, and a way to take it back
        if (action === "pro") return profile.proRequest(h);
        if (action === "pro2") return profile.submitPro(h);
        if (action === "procancel") return profile.cancelPro(h);''')

edit("src/index.ts", '        if (action === "broadcast") return admin.broadcast(h);',
'''        if (action === "broadcast") return admin.broadcast(h);
        if (action === "plan") return admin.setPlan(h, args[0] ?? "", args[1] === "pro" ? "pro" : "free");''')

print("batch A part 2 written")
