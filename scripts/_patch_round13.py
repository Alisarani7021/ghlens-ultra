import pathlib, re, sys

def edit(path, old, new, count=1):
    p = pathlib.Path(path)
    s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}: {old[:70]!r}")
        sys.exit(1)
    p.write_text(s.replace(old, new, count))
    print(f"ok {path}")

IDX = "src/index.ts"

# ── 1. the autonomy screen's own buttons were unreachable ───────────────────
# The screen emits `hos:auto:on|off`; the router only knew `hos:setauto:<mode>`,
# so the press redrew the same screen and the toggle never flipped. Both spellings
# stay routed: old messages in the chat still carry `setauto`.
edit(IDX, '        if (action === "auto") return hubOS.autonomy(h);',
'''        if (action === "auto") {
          // the screen's own two buttons: `hos:auto:on|off`
          if (arg === "on" || arg === "off") return hubOS.setAutonomy(h, arg === "on" ? "auto" : "manual");
          return hubOS.autonomy(h);
        }''')

# ── 2. a dead audio button in the daily digest ──────────────────────────────
# `p:today` is left over from the removed podcast section: no router case answers
# `p:*` and audio was purged from the bot by the owner's own instruction. A dead
# button on the most-sent screen of the day is worse than no button.
edit("src/core/cron.ts", '      { text: "🎙 پادکست صوتی", cb: "p:today" },',
     '      { text: "📈 روند ۷ روز", cb: "t:growth:7" },')

# ── 3. «🛰 کاوش مخزن» pointed at a namespace that does not exist ────────────
# Deep scout lives under `s:` (s:home) — `dis:` was never routed.
edit(IDX, 'kb([{ text: "🛰 کاوش مخزن", cb: "dis:home" }, ])',
     'kb([{ text: "🛰 کاوش مخزن", cb: "s:home" }, ])')

# ── 4. copy that still advertises the removed audio features ────────────────
edit("src/features/keys.ts",
     '`با کلیدهای بیشتر، ترجمه، خلاصه، چت با مخزن، ورک‌فلو، پادکست و همهٔ قابلیت‌های AI کار می‌کنند.`',
     '`با کلیدهای بیشتر، ترجمه، خلاصه، چت با مخزن، ورک‌فلو و همهٔ قابلیت‌های AI کار می‌کنند.`')
edit("src/features/profile.ts",
     'نامحدود، کاوش عمیق نامحدود، پادکست اختصاصی، دانلود بدون سقف، هشدار لحظه‌ای، آلرت امنیتی اختصاصی',
     'نامحدود، کاوش عمیق نامحدود، ترجمهٔ README بی‌سقف، دانلود بدون سقف، هشدار لحظه‌ای، آلرت امنیتی اختصاصی')
edit("src/features/settings.ts",
     '`• <b>R2</b> برای آرشیو سورس و پادکست\\n` +',
     '`• <b>R2</b> برای آرشیو سورس و اسنپ‌شات‌ها\\n` +')
edit("src/features/settings.ts",
     '`• <b>Workers AI</b> برای ترجمه، تحلیل، خلاصه، صدا\\n` +',
     '`• <b>Workers AI</b> برای ترجمه، تحلیل، خلاصه، چت و ساخت تصویر\\n` +')

# ── 5. the approval node ignored the autonomy setting ───────────────────────
edit("src/hub/engine.ts", '''    case "approval": {
      // A preview never knocks on anyone's door; it reports what it would ask.
      if (ctx.dry) return { patch: {}, summary: "آزمایشی — بدون پرسش تأیید", branch: node.next ?? [] };
      // Draft first, ask second: the owner must be able to read the thing they
      // are approving, so the content row always exists before the gate.
      const preview = String(bag[String(cfg.from ?? "post")] ?? "").slice(0, 3500);''',
'''    case "approval": {
      // A preview never knocks on anyone's door; it reports what it would ask.
      if (ctx.dry) return { patch: {}, summary: "آزمایشی — بدون پرسش تأیید", branch: node.next ?? [] };
      const autonomy = ctx.autonomy ?? "manual";
      /* The gate belongs to the owner's setting, not to the graph. A workflow that
         contains an approval node used to wait for a human even in `auto`, so the
         switch the owner flipped changed nothing: the run sat in the queue until
         it expired. In `auto` the node is a step that says it was skipped; in
         `auto-with-review` it still shows the draft, but as information — the run
         does not stop for it. */
      if (autonomy !== "manual") {
        const draft = String(bag[String(cfg.from ?? "post")] ?? "").slice(0, 1200);
        await ctx.tg.sendMessage(
          cfg.to ? String(cfg.to) : ctx.owner_id,
          `🔓 <b>حالت خودکار — بدون توقف منتشر می‌شود</b>\\n\\n` +
            `<blockquote>${tgEscape(String(bag.policy?.summary ?? "این خروجی رفت"))}</blockquote>\\n\\n` +
            draft,
          { parse_mode: "HTML" },
        ).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        return {
          patch: { approval_skipped: autonomy },
          summary: autonomy === "auto" ? "بدون تأیید (حالت خودکار)" : "گزارش خودکار (بدون توقف)",
          branch: node.next ?? [],
        };
      }
      // Draft first, ask second: the owner must be able to read the thing they
      // are approving, so the content row always exists before the gate.
      const preview = String(bag[String(cfg.from ?? "post")] ?? "").slice(0, 3500);''')

# ── 6. one clock per update, enforced at the source ─────────────────────────
# Two model calls in one handler each ran on the default 20 s deadline, so their
# sum walked past the platform's allowance and the isolate was torn down
# mid-answer — the spinner that never stops. Each call site *can* pass a budget,
# but a new one can forget; clamping inside buildH means it cannot.
edit(IDX, '''  const h: H = {
    env, store, tg, ai, card, u, user, loc, chatId, msgId,''',
'''  /* The platform allows roughly half a minute per update, and every model call
     in the handler draws from that one allowance. A call that forgets its
     deadline runs on the default 20 s; two of them can never both land, and the
     user sees a spinner that never resolves. Clamping here — at the single place
     every feature gets its `ai` from — means a call site added later inherits the
     bound instead of having to remember it. */
  const left = () => Math.max(2_000, (guard?.startedAt ?? Date.now()) + UPDATE_BUDGET_MS - Date.now());
  const aiClamped = new Proxy(ai, {
    get(target: any, prop: string | symbol, recv: any) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;               // `ai.failure` reads pass through
      const bound = v.bind(target);
      if (prop !== "chat" && prop !== "json") return bound;
      return (prompt: string, o: any = {}) =>
        bound(prompt, { ...(o ?? {}), deadlineMs: Math.min(Number(o?.deadlineMs ?? 1e9) || 1e9, left()) });
    },
  }) as AiBrain;

  const h: H = {
    env, store, tg, ai: aiClamped, card, u, user, loc, chatId, msgId,''')

edit(IDX, '''    budget() {
      const started = guard?.startedAt ?? Date.now();
      return Math.max(2_000, started + UPDATE_BUDGET_MS - Date.now());
    },''', '''    budget: left,''')

print("all six edits applied")
