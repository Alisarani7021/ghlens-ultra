import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { PROVIDERS, KeyPool, providerPreset } from "../ai/keypool";

/**
 * «اهدای کلید» — the donated-key panel.
 *
 * The owner asked for something no other bot has: a place where anyone can
 * hand over an OpenAI-compatible key, all keys work together as one pool, and
 * a key that runs out is dropped the moment it fails. This is that panel.
 */
export const keys = {
  async home(h: H) {
    const fa = h.loc === "fa";
    const pool = new KeyPool(h.env);
    const { total, ok } = await pool.stats().catch(() => ({ total: 0, ok: 0 }));
    const halted = await h.env.CACHE.get("ai:halt").catch(() => null);

    const body =
      (fa
        ? `🤝 <b>استخر کلیدهای هوش مصنوعی</b>\n\n` +
          `هر کسی می‌تواند کلید خودش را اهدا کند؛ ربات همه را مثل یک استخر به کار می‌برد و ` +
          `هر درخواست از سالم‌ترین کلید جواب می‌گیرد. کلیدی که تمام شود یا بسوزد، ` +
          `همان لحظه از استخر حذف می‌شود.\n\n` +
          `🔑 کلیدهای استخر: <b>${ok}</b> سالم از <b>${total}</b>\n` +
          `⚙️ وضعیت موتور: ${halted ? "⛔ سهمیهٔ کلادفلر تمام شده — استخر جای آن را می‌گیرد" : "🟢 روشن"}\n\n` +
          `با کلیدهای بیشتر، ترجمه، خلاصه، چت با مخزن، ورک‌فلو، پادکست و همهٔ قابلیت‌های AI کار می‌کنند.`
        : `🤝 <b>AI key pool</b>\n\n🔑 ${ok} healthy of ${total}\n⚙️ engine: ${halted ? "quota exhausted (pool takes over)" : "on"}`);

    await h.reply(body, kb(
      [{ text: "➕ " + (fa ? "اهدای کلید" : "Donate a key"), cb: "keys:add" }],
      [{ text: "🧪 " + (fa ? "تست کل استخر" : "Test the pool"), cb: "keys:test" }, { text: "📊 " + (fa ? "کلیدهای من" : "My keys"), cb: "keys:mine" }],
      [{ text: "♻️ " + (fa ? "پاک‌سازی کلیدهای خراب" : "Clean broken keys"), cb: "keys:clean" }],
      [{ text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
    ), !!h.cbId);
  },

  /** Step 1: pick the provider (mirrors the AURA screen the owner sent). */
  async add(h: H) {
    const fa = h.loc === "fa";
    const rows = PROVIDERS.map((p) => [{ text: `${p.free ? "🆓" : "🔑"} ${p.label}`, cb: `keys:p:${p.id}` }]);
    await h.reply(
      fa
        ? `➕ <b>اهدای کلید هوش مصنوعی</b>\n\n` +
          `ارائه‌دهنده را انتخاب کن — آدرس پایه خودکار پر می‌شود و بعد فقط کلید را می‌فرستی.\n` +
          `کلید اول <b>تست</b> می‌شود؛ اگر سالم نبود اصلاً ذخیره نمی‌شود.\n\n` +
          `<i>فقط کلید سهمیه‌دار یا رایگانِ خودت را بده. کلید رمزنگاری‌شده (AES-GCM) ذخیره می‌شود و فقط برای درخواست‌های همین ربات استفاده می‌شود.</i>`
        : "➕ <b>Donate an AI key</b>\nPick a provider, then send the key. It is tested before being stored, and stored encrypted.",
      kb(...rows, [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]),
      !!h.cbId,
    );
  },

  /** Step 2: provider chosen → ask for the key (custom/local also ask for a URL). */
  async ask(h: H, providerId: string) {
    const fa = h.loc === "fa";
    const p = providerPreset(providerId);
    if (!p) return this.add(h);
    await h.session.set("keys:pending", JSON.stringify({ provider: p.id, baseUrl: p.baseUrl, model: p.model, stage: p.baseUrl ? "key" : "url" }));
    if (!p.baseUrl) {
      await h.reply(
        fa ? `🛠 <b>سفارشی</b>\n\nآدرس پایه را بفرست (مثال: <code>https://api.example.com/v1</code>)، بعد کلید و نام مدل.`
           : "🛠 Send the base URL, e.g. https://api.example.com/v1",
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:add" }]]), !!h.cbId);
      return;
    }
    await h.reply(
      fa
        ? `🔑 <b>${p.label}</b>\n\nکلیدت را همین‌جا بفرست (یک پیام).\n` +
          `• آدرس پایه: <code>${tgEscape(p.baseUrl)}</code>\n` +
          `• مدل پیشنهادی: <code>${tgEscape(p.model || "—")}</code>\n` +
          (p.hint ? `• ${p.hint}\n` : "") +
          `\nاگر مدل دیگری می‌خواهی، بعد از کلید نام مدل را بفرست. برای کلید محلی (Ollama) هم می‌توانی «-» بفرستی.`
        : `🔑 Send the key for ${p.label}. Base URL: ${p.baseUrl} · model: ${p.model || "—"}`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:add" }]]), !!h.cbId,
    );
  },

  /** Step 3: the key itself arrived — test, then store. */
  /** One place that turns a failed test into a sentence a human understands. */
  explain(fa: boolean, test: { errorKind?: string; error?: string }): string {
    return test.errorKind === "auth" ? (fa ? "کلید رد شد (۴۰۱/۴۰۳). کلید تازه بساز یا مطمئن شو کامل کپی شده." : "the key was rejected (401/403).")
      : test.errorKind === "quota" ? (fa ? "این کلید سهمیه‌اش تمام شده یا محدود شده (۴۰۲/۴۲۹). یک کلید دیگر اهدا کن." : "this key is out of quota (402/429).")
      : test.errorKind === "url" ? (fa ? "آدرس پایه درست نیست. فقط تا <code>/v1</code> لازم است؛ مسیر <code>/chat/completions</code> را ننویس." : "the base URL looks wrong — stop at /v1.")
      : test.errorKind === "model" ? (fa ? "کلید سالم است ولی هیچ مدل چتی از این آدرس جواب نداد. یک مدل درست را از فهرست ارائه‌دهنده بفرست." : "the key works but no chat model answered.")
      : (fa ? "ارتباط برقرار نشد (شبکه یا آدرس)." : "could not reach the endpoint.");
  },

  async accept(h: H, pending: any, keyText: string) {
    const fa = h.loc === "fa";
    const pool = new KeyPool(h.env);
    const raw = keyText.trim();
    const key = raw === "-" ? "" : raw;
    const baseUrl = KeyPool.normalizeBase(String(pending.baseUrl ?? ""));
    if (!baseUrl) {
      await h.session.clear(["keys:pending"]);
      return h.reply(fa ? "❌ آدرس پایه خالی بود؛ دوباره از ابتدا." : "❌ missing base URL", kb([[{ text: "◀️", cb: "keys:add" }]]), !!h.cbId);
    }

    await h.loading(fa ? "🧪 در حال تست کلید…" : "🧪 testing the key…");
    const test = await KeyPool.test(baseUrl, key, pending.model || "");
    if (!test.ok) {
      await h.session.clear(["keys:pending"]);
      const why = keys.explain(fa, test);
      return h.reply(
        (fa ? `❌ <b>کلید ذخیره نشد</b>\n\n` : `❌ <b>Key not stored</b>\n\n`) +
          `${why}\n\n` +
          (fa ? `<b>پاسخ سرور:</b>\n<code>${tgEscape(String(test.error ?? "unknown").slice(0, 220))}</code>\n\n` : `<code>${tgEscape(String(test.error ?? "unknown").slice(0, 220))}</code>\n\n`) +
          (fa ? "چیزی ذخیره نشد ✓" : "Nothing was stored."),
        kb([[{ text: "🔁 " + (fa ? "تلاش دوباره" : "Retry"), cb: `keys:p:${pending.provider}` }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]]),
        true,
      );
    }

    const model = test.model || pending.model || test.models?.[0] || "";
    const id = await pool.add({ ownerId: h.u.id, label: providerPreset(pending.provider)?.label ?? pending.provider, provider: pending.provider, baseUrl, model, key });
    await h.session.clear(["keys:pending"]);
    const { total, ok } = await pool.stats().catch(() => ({ total: 0, ok: 0 }));
    // a working key means the whole bot's AI is back: lift the quota breaker
    await h.env.CACHE.delete("ai:halt").catch(() => null);
    await h.env.CACHE.delete("ai:last-failure").catch(() => null);

    await h.reply(
      (fa
        ? `✅ <b>کلید سالم است و به استخر اضافه شد</b>\n\n` +
          `🧪 تست: ${test.reply ? `<code>${tgEscape(test.reply)}</code>` : "اتصال برقرار شد"}\n` +
          `🏷 ارائه‌دهنده: <b>${tgEscape(providerPreset(pending.provider)?.label ?? pending.provider)}</b>\n` +
          `🧠 مدل: <code>${tgEscape(model || "auto")}</code>${test.model && test.model !== pending.model ? (fa ? " <i>(خودکار انتخاب شد)</i>" : " <i>(auto-picked)</i>") : ""}\n` +
          `🔑 استخر: <b>${ok}</b> کلید سالم از <b>${total}</b>\n\n` +
          `<i>از این لحظه همهٔ قابلیت‌های هوش مصنوعی ربات از این استخر (و کلیدهای دیگران) کار می‌کنند.</i>`
        : `✅ Key verified and pooled. ${ok}/${total} healthy.`)
    , kb(
      [{ text: "🎁 " + (fa ? "اهدای کلید دیگر" : "Donate another"), cb: "keys:add" }, { text: "📊 " + (fa ? "کلیدهای من" : "My keys"), cb: "keys:mine" }],
      [{ text: "🤖 " + (fa ? "امتحان کن: یک سؤال" : "Try it: ask something"), cb: "a:new" }],
      [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }],
    ), true);
    await h.store.event(h.u.id, "key_donated", `${pending.provider}:${id}`);
  },

  async mine(h: H) {
    const fa = h.loc === "fa";
    const rows = (await new KeyPool(h.env).rows()).filter((r) => r.owner_id === h.u.id);
    if (!rows.length) {
      return h.reply(
        fa ? `📊 هنوز کلیدی اهدا نکرده‌ای.\n\nبا یک کلید رایگان Groq یا OpenRouter می‌توانی کل موتور AI ربات را روشن کنی.`
           : "📊 You have not donated a key yet.",
        kb([[{ text: "➕ " + (fa ? "اهدای کلید" : "Donate a key"), cb: "keys:add" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]]),
        !!h.cbId,
      );
    }
    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.status === "ok" ? "🟢" : r.status === "warn" ? "🟡" : "⚪️"} <b>${tgEscape(r.label)}</b> · <code>${tgEscape(r.model || "auto")}</code>\n` +
      `   ✅ ${r.ok_count} · ❌ ${r.fail_count}${r.last_err ? `\n   <i>${tgEscape(String(r.last_err).slice(0, 90))}</i>` : ""}`);
    await h.reply(
      `📊 <b>${fa ? "کلیدهای اهدایی من" : "My donated keys"}</b>\n\n${lines.join("\n")}`,
      kb(rows.slice(0, 6).map((r) => [{ text: `🗑 ${r.label} · ${r.model || "auto"}`.slice(0, 30), cb: `keys:del:${r.id}` }]),
        [{ text: "➕ " + (fa ? "کلید جدید" : "New key"), cb: "keys:add" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]),
      !!h.cbId,
    );
  },

  async del(h: H, id: number) {
    const fa = h.loc === "fa";
    const pool = new KeyPool(h.env);
    const row = (await pool.rows()).find((r) => r.id === id);
    if (!row) return h.toast(fa ? "این کلید قبلاً حذف شده — فهرست را دوباره باز کن" : "already gone — reopen the list", true);
    const isAdmin = (h.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).includes(String(h.u.id));
    if (row.owner_id !== h.u.id && !isAdmin) return h.toast(fa ? "این کلید متعلق به تو نیست و حذف نشد" : "this key is not yours", true);
    await pool.remove(id, "owner request");
    await h.toast(fa ? "🗑 حذف شد" : "deleted");
    return this.mine(h);
  },

  /** Test every pooled key; drop the dead ones (the owner's rule). */
  async test(h: H) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🧪 در حال تست استخر…" : "🧪 testing the pool…");
    const pool = new KeyPool(h.env);
    const keys = await pool.candidates(12);
    if (!keys.length) {
      return h.reply(fa ? "🫙 استخری وجود ندارد. یک کلید اهدا کن." : "pool is empty", kb([[{ text: "➕ " + (fa ? "اهدای کلید" : "Donate"), cb: "keys:add" }], [{ text: "◀️", cb: "keys:home" }]]), true);
    }
    const results: string[] = [];
    for (const k of keys) {
      const r = await KeyPool.test(k.baseUrl, k.key, k.model);
      if (r.ok) {
        await pool.markOk(k.id, k.model);
        results.push(`🟢 <b>${tgEscape(k.provider)}</b> · <code>${tgEscape(k.model || "auto")}</code>${r.reply ? ` — <i>${tgEscape(r.reply)}</i>` : ""}`);
      } else {
        const verdict = await pool.markFail(k.id, r.error ?? "unknown");
        results.push(`🔴 <b>${tgEscape(k.provider)}</b> · <code>${tgEscape(k.model || "auto")}</code> — ${tgEscape(String(r.error).slice(0, 120))}\n   ${verdict === "deleted" ? (fa ? "<i>کلید سوخته بود و از استخر حذف شد</i>" : "<i>removed from the pool</i>") : (fa ? "<i>موقتاً کنار گذاشته شد</i>" : "<i>marked unhealthy</i>")}`);
      }
    }
    const { total, ok } = await pool.stats().catch(() => ({ total: 0, ok: 0 }));
    await h.reply(
      `🧪 <b>${fa ? "نتیجهٔ تست استخر" : "Pool test"}</b> — ${ok}/${total}\n\n${results.join("\n")}`,
      kb([[{ text: "♻️ " + (fa ? "پاک‌سازی" : "Clean"), cb: "keys:clean" }, { text: "➕ " + (fa ? "کلید جدید" : "New key"), cb: "keys:add" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]]),
      !!h.cbId,
    );
  },

  /**
   * Re-test every key and drop the ones that are really gone.
   *
   * Deliberately conservative: a slow provider that times out once, or a
   * rate-limited key, is *not* dead. Only hard rejections (401/402/403, quota,
   * revoked) remove a key; everything else stays and merely goes on cooldown.
   * A previous version deleted on any failure, which silently threw away
   * working keys whose provider was just slow.
   */
  async clean(h: H) {
    const fa = h.loc === "fa";
    const pool = new KeyPool(h.env);
    const keys = await pool.candidates(20);
    let dead = 0, kept = 0;
    for (const k of keys) {
      const r = await KeyPool.test(k.baseUrl, k.key, k.model);
      if (r.ok) { await pool.markOk(k.id, r.model ?? k.model); kept++; continue; }
      const hard = r.errorKind === "auth" || r.errorKind === "quota";
      if (hard) { await pool.remove(k.id, r.error ?? "clean"); dead++; }
      else { await pool.markFail(k.id, r.error ?? "clean"); kept++; }
    }
    const { total, ok } = await pool.stats().catch(() => ({ total: 0, ok: 0 }));
    await h.reply(
      fa ? `♻️ پاک‌سازی انجام شد: ${dead} کلید سوخته حذف شد · ${ok} کلید سالم از ${total}` +
             (kept ? `\n<i>${kept} کلید فقط کند یا محدود بود؛ نگه داشته شد و خودکار دوباره امتحان می‌شود.</i>` : "")
         : `♻️ cleaned: removed ${dead} · ${ok}/${total} healthy`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "keys:home" }]]),
      !!h.cbId,
    );
  },
};
