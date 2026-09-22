import type { H } from "../core/handler";
import { armMode } from "../core/modes";
import { code, pre, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * DEV UTILS — the "small tools" drawer every developer actually uses,
 * all offline-capable (no external API) and instant:
 *   cron explainer/builder · regex lab · CIDR calculator · JWT decoder
 *   base64/hex/url encode · UUID/ULID · hash (SHA-256 via WebCrypto)
 *   timestamp/ISO converter · JSON prettifier · diff · color picker
 *   user-agent parser notes · .gitignore generator · semantic version bumper
 */
export class DevUtils {
  async home(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `⚙️ <b>${fa ? "ابزار توسعه‌دهنده" : "Developer utilities"}</b>\n\n` +
        (fa ? "همه محلی و فوری — بدون API بیرونی." : "All local and instant."),
      kb(
        [
          { text: "🕐 " + (fa ? "کرون" : "Cron"), cb: "dvu:cron" },
          { text: "🧪 " + (fa ? "رجکس" : "Regex"), cb: "dvu:regex" },
        ],
        [
          { text: "🧮 CIDR", cb: "dvu:cidr" },
          { text: "🔐 JWT", cb: "dvu:jwt" },
        ],
        [
          { text: "🔤 Base64", cb: "dvu:b64" },
          { text: "#️⃣ " + (fa ? "هش" : "Hash"), cb: "dvu:hash" },
        ],
        [
          { text: "🆔 UUID/ULID", cb: "dvu:id" },
          { text: "🕰 " + (fa ? "تایم‌استمپ" : "Timestamp"), cb: "dvu:time" },
        ],
        [
          { text: "🧾 JSON", cb: "dvu:json" },
          { text: "📝 .gitignore", cb: "dvu:gitignore" },
        ],
        [
          { text: "🔢 " + (fa ? "نسخه‌گذاری" : "SemVer"), cb: "dvu:semver" },
          { text: "🎨 " + (fa ? "رنگ" : "Color"), cb: "dvu:color" },
        ],
        [{ text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Cron: explain any expression + build common ones. */
  async cron(h: H, expr?: string) {
    const fa = h.loc === "fa";
    if (!expr) {
      await h.reply(
        `🕐 <b>${fa ? "کرون‌ساز و توضیح‌دهنده" : "Cron builder & explainer"}</b>\n\n` +
          (fa ? "یک عبارت کرون بفرست تا به فارسی ساده توضیح دهم و چند اجرای بعدی را نشان دهم.\nمثال: <code>*/15 9-17 * * 1-5</code>" : "Send a cron expression to explain it."),
        kb(
          [
            { text: "هر ۵ دقیقه", cb: "dvu:cron:*/5 * * * *" },
            { text: "هر ساعت", cb: "dvu:cron:0 * * * *" },
          ],
          [
            { text: "روزانه ۶ صبح", cb: "dvu:cron:0 6 * * *" },
            { text: "دوشنبه‌ها ۹ صبح", cb: "dvu:cron:0 9 * * 1" },
          ],
          [
            { text: "اول هر ماه", cb: "dvu:cron:0 0 1 * *" },
            { text: "ساعات کاری", cb: "dvu:cron:*/15 9-17 * * 1-5" },
          ],
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
        ),
        !!h.cbId,
      );
      return;
    }
    const parsed = explainCron(expr, fa);
    const next = nextRuns(expr, 5);
    await h.reply(
      `🕐 <code>${tgEscape(expr)}</code>\n\n` +
        (parsed ? `📖 ${parsed}\n\n` : `⚠️ ${fa ? "نتوانستم این عبارت را تشخیص بدهم." : "unrecognised expression."}\n\n`) +
        (next.length ? `<b>${fa ? "اجراهای بعدی" : "Next runs"}</b>\n` + next.map((d) => `• <code>${d.toISOString().slice(0, 16).replace("T", " ")}</code> UTC`).join("\n") : "") +
        `\n\n💡 ${fa ? "در GitHub Actions از UTC استفاده می‌شود؛ اگر ساعت ۳:۳۰ تهران می‌خواهی، بنویس <code>0 0 * * *</code> (۳:۳۰ UTC = ۷:۰۰ تهران بدون DST)." : ""}`,
      kb([[{ text: "🔁 " + (fa ? "عبارت دیگر" : "Another"), cb: "dvu:cron" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }

  /** Regex lab: evaluate a pattern against a sample text, highlight matches. */
  async regex(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `🧪 <b>${fa ? "آزمایشگاه رجکس" : "Regex lab"}</b>\n\n` +
        (fa
          ? "قالب: <code>/pattern/flags|متن نمونه</code>\nمثال:\n<code>/(\\d{4})-(\\d{2})-(\\d{2})/|2026-09-22 و 1991-05-01</code>"
          : "Format: <code>/pattern/flags|sample text</code>"),
      kb(
        [
          { text: "📧 Email", cb: "dvu:regex:^[\\w.+-]+@[\\w-]+\\.[\\w.]+$|a@b.com bad@" },
          { text: "🔗 URL", cb: "dvu:regex:https?://[\\w.-]+(?:/[^\\s]*)?|see https://a.dev/x" },
        ],
        [
          { text: "🔢 IP", cb: "dvu:regex:(\\d{1,3}\\.){3}\\d{1,3}|10.0.0.1 x 999.1.1.1" },
          { text: "🎯 SemVer", cb: "dvu:regex:^v?(\\d+)\\.(\\d+)\\.(\\d+)$|v1.2.3" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
      ),
      !!h.cbId,
    );
  }

  async runRegex(h: H, payload: string) {
    const fa = h.loc === "fa";
    const idx = payload.lastIndexOf("|");
    if (idx < 0) return this.regex(h);
    const [pat, flags] = payload.slice(0, idx).split(/(?<!\\\\)\/(?=[gimsuy]*$)/);
    const sample = payload.slice(idx + 1);
    let out = "";
    try {
      const re = new RegExp(pat.replace(/^\//, ""), flags || "g");
      const matches = [...sample.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
      out = matches.length
        ? `<b>${matches.length}</b> ${fa ? "تطابق" : "matches"}\n` +
          matches.slice(0, 10).map((m, i2) => `${i2 + 1}. <code>${tgEscape(m[0])}</code>${m.length > 1 ? ` → groups: ${m.slice(1).map((g) => code(g ?? "")).join(", ")}` : ""}`).join("\n")
        : `🤷 ${fa ? "هیچ تطابقی نبود." : "no match."}`;
    } catch (e: any) {
      out = `❌ ${fa ? "خطای رجکس" : "regex error"}: <code>${tgEscape(String(e.message).slice(0, 120))}</code>`;
    }
    await h.reply(
      `🧪 <code>${tgEscape(pat)}</code>  ${flags ? `flags: <code>${tgEscape(flags)}</code>` : ""}\n\n${out}`,
      kb([[{ text: "🔁 " + (fa ? "آزمایش دیگر" : "Another"), cb: "dvu:regex" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }

  /** CIDR calculator: network, broadcast, range, host count, subnetting table. */
  async cidr(h: H, cidr?: string) {
    const fa = h.loc === "fa";
    if (!cidr) {
      await h.reply(
        `🧮 <b>${fa ? "ماشین‌حساب CIDR" : "CIDR calculator"}</b>\n\n${fa ? "مثال: <code>192.168.1.10/24</code> یا <code>10.0.0.0/8</code> یا یک رنج <code>10.0.0.5-10.0.0.40</code>" : "e.g. 192.168.1.10/24"}`,
        kb(
          [
            { text: "192.168.1.10/24", cb: "dvu:cidr:192.168.1.10/24" },
            { text: "10.0.0.0/8", cb: "dvu:cidr:10.0.0.0/8" },
          ],
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
        ),
        !!h.cbId,
      );
      return;
    }
    const res = cidrCalc(cidr);
    if (!res) return h.reply(fa ? "❌ ورودی نامعتبر." : "❌ invalid input", kb([{ text: "◀️", cb: "dvu:cidr" }]), !!h.cbId);
    await h.reply(
      `🧮 <b>${tgEscape(cidr)}</b>\n\n<pre>${tgEscape(res.table)}</pre>` +
        (res.subnets ? `\n<b>${fa ? "تقسیم به /" : "Split into /"}${res.subnets.bits}</b>\n<pre>${tgEscape(res.subnets.sample)}</pre>` : ""),
      kb(
        [
          { text: "/25 " + (fa ? "تقسیم" : "split"), cb: `dvu:cidr:${cidr.split("/")[0]}/25` },
          { text: "/26", cb: `dvu:cidr:${cidr.split("/")[0]}/26` },
        ],
        [{ text: "🔁 " + (fa ? "ورودی دیگر" : "Another"), cb: "dvu:cidr" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
      ),
      !!h.cbId,
    );
  }

  /** JWT decoder — offline, no signature verification (by design, that needs the secret). */
  async jwt(h: H, token?: string) {
    const fa = h.loc === "fa";
    if (!token) {
      return h.reply(
        `🔐 <b>JWT decoder</b>\n\n${fa ? "توکن JWT را بفرست تا header و payload را دیکد کنم (امضا بررسی نمی‌شود — برای آن کلید لازم است)." : "Send a JWT to decode."}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      );
    }
    const parts = token.split(".");
    if (parts.length < 2) return h.reply(fa ? "❌ JWT نامعتبر." : "❌ invalid JWT", kb([{ text: "◀️", cb: "dvu:home" }]), true);
    const dec = (s: string) => { try { return JSON.stringify(JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))), null, 2); } catch { return "—"; } };
    const header = dec(parts[0]);
    const payloadObj: any = (() => { try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; } })();
    const expNote = payloadObj.exp
      ? `\n\n⏳ ${fa ? "انقضا" : "exp"}: <code>${new Date(payloadObj.exp * 1000).toISOString()}</code> ${
          payloadObj.exp * 1000 < Date.now() ? `❌ ${fa ? "منقضی شده" : "expired"}` : `✅ ${fa ? "معتبر" : "valid"} (${Math.round((payloadObj.exp * 1000 - Date.now()) / 60000)} min)`}`
      : "";
    await h.reply(
      `🔐 <b>JWT</b>\n\n<b>Header</b>\n<pre>${tgEscape(header)}</pre>\n<b>Payload</b>\n<pre>${tgEscape(payloadObj ? JSON.stringify(payloadObj, null, 2) : "—")}</pre>${expNote}\n\n` +
        `<i>${fa ? "هرگز توکن واقعی را در چت‌های عمومی نفرست." : "never paste production tokens in public chats."}</i>`,
      kb([[{ text: "🔁 " + (fa ? "توکن دیگر" : "Another"), cb: "dvu:jwt" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }

  async b64(h: H, input?: string) {
    const fa = h.loc === "fa";
    if (!input) {
      return h.reply(
        `🔤 <b>Base64 / Hex / URL</b>\n\n${fa ? "متن، base64 یا هش بفرست — خودم تشخیص می‌دهم و هر دو جهت را نشان می‌دهم." : "Send text or encoded data."}`,
        kb([
          { text: "دیکد", cb: "dvu:b64d" }, { text: "انکد", cb: "dvu:b64" },
        ], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]),
      );
    }
    let decoded = "";
    try { decoded = decodeURIComponent(escape(atob(input.trim()))); } catch { decoded = ""; }
    const encoded = btoa(unescape(encodeURIComponent(input)));
    const hex = [...new TextEncoder().encode(input)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const urlEnc = encodeURIComponent(input);
    await h.reply(
      `🔤 <b>${fa ? "تبدیل" : "Converter"}</b>\n\n` +
        `<b>Input</b>\n<code>${tgEscape(input.slice(0, 300))}</code>\n\n` +
        `📤 <b>Base64</b>\n<code>${tgEscape(encoded.slice(0, 400))}</code>\n` +
        `📥 <b>Base64 decode</b>\n<code>${tgEscape((decoded || "—").slice(0, 400))}</code>\n` +
        `🔢 <b>Hex</b>\n<code>${tgEscape(hex.slice(0, 400))}</code>\n` +
        `🔗 <b>URL encode</b>\n<code>${tgEscape(urlEnc.slice(0, 400))}</code>`,
      kb([[{ text: "🔄 " + (fa ? "ورودی دیگر" : "Another"), cb: "dvu:b64" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }

  /** SHA-1/256/384/512 via WebCrypto + CRC-ish lengths. */
  async hash(h: H, input: string) {
    const fa = h.loc === "fa";
    const algs = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
    const out: string[] = [];
    for (const alg of algs) {
      try {
        const buf = await crypto.subtle.digest(alg, new TextEncoder().encode(input));
        out.push(`<b>${alg}</b>\n<code>${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}</code>`);
      } catch { /* skip */ }
    }
    await h.reply(
      `#️⃣ <b>${fa ? "هش" : "Hash"}</b> <code>${tgEscape(input.slice(0, 60))}</code>\n\n${out.join("\n\n")}\n\n` +
        `<i>${fa ? "برای md5/bcrypt از ابزار محلی استفاده کن — WebCrypto پشتیبانی نمی‌کند." : "MD5 isn't in WebCrypto."}</i>`,
      kb([[{ text: "🔁 " + (fa ? "ورودی دیگر" : "Another"), cb: "dvu:hash" }, { text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }]]),
      !!h.cbId,
    );
  }

  async id(h: H) {
    const fa = h.loc === "fa";
    const uuid = crypto.randomUUID();
    const ulid = genUlid();
    const nanoid = genNano(21);
    const apiKey = "lens_" + genNano(32);
    await h.reply(
      `🆔 <b>${fa ? "تولید شناسه" : "ID generator"}</b>\n\n` +
        `<b>UUID v4</b>\n<code>${uuid}</code>\n\n` +
        `<b>ULID</b> <i>(${fa ? "مرتب‌شدنی بر اساس زمان" : "time-sortable"})</i>\n<code>${ulid}</code>\n\n` +
        `<b>NanoID</b>\n<code>${nanoid}</code>\n\n` +
        `<b>API key</b>\n<code>${apiKey}</code>`,
      kb([[{ text: "🔁 " + (fa ? "تولید بیشتر" : "More"), cb: "dvu:id" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }

  async time(h: H, input?: string) {
    const fa = h.loc === "fa";
    const now = Date.now();
    const t = input?.trim() ? (/^\d+$/.test(input.trim()) ? Number(input.trim()) * (input.trim().length <= 10 ? 1000 : 1) : Date.parse(input.trim())) : now;
    if (!Number.isFinite(t)) return h.reply(fa ? "❌ ورودی نامعتبر." : "❌ invalid", kb([{ text: "◀️", cb: "dvu:time" }]), !!h.cbId);
    const d = new Date(t);
    const rel = Math.round((t - now) / 1000);
    await h.reply(
      `🕰 <b>${fa ? "تایم‌استمپ" : "Timestamp"}</b>\n\n` +
        `🗓 ISO: <code>${d.toISOString()}</code>\n` +
        `🔢 Unix (s): <code>${Math.floor(t / 1000)}</code>\n` +
        `🔢 Unix (ms): <code>${t}</code>\n` +
        `🌍 UTC: <code>${d.toUTCString()}</code>\n` +
        `🇮🇷 Tehran: <code>${new Intl.DateTimeFormat("fa-IR", { dateStyle: "full", timeStyle: "medium", timeZone: "Asia/Tehran" }).format(d)}</code>\n` +
        `🇨🇭 Zurich: <code>${new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "medium", timeZone: "Europe/Zurich" }).format(d)}</code>\n` +
        `⏳ ${fa ? "نسبت به الان" : "relative"}: <code>${rel}s</code>`,
      kb(
        [
          { text: "⏪ -1h", cb: `dvu:time:${Math.floor(now / 1000) - 3600}` },
          { text: "⏩ +1d", cb: `dvu:time:${Math.floor(now / 1000) + 86400}` },
          { text: "🔄 " + (fa ? "الان" : "now"), cb: `dvu:time:${Math.floor(now / 1000)}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
      ),
      !!h.cbId,
    );
  }

  async json(h: H, input?: string) {
    const fa = h.loc === "fa";
    if (!input) {
      return h.reply(`🧾 <b>JSON</b>\n\n${fa ? "JSON یا YAML را بفرست تا فرمت، اعتبارسنجی، آمار کلیدها و نسخه minified را بگیری." : "Send JSON to format/validate."}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]));
    }
    try {
      const obj = JSON.parse(input);
      const stats = jsonStats(obj);
      await h.reply(
        `🧾 <b>JSON ${fa ? "معتبر است" : "is valid"}</b> ✅\n\n` +
          `🔑 ${fa ? "کلیدها" : "keys"}: <b>${stats.keys}</b> · 📏 ${fa ? "عمق" : "depth"}: <b>${stats.depth}</b> · 🧮 ${fa ? "اندازه" : "size"}: ${stats.size} chars\n` +
          `📦 ${fa ? "آرایه" : "arrays"}: ${stats.arrays} · 🔤 strings: ${stats.strings} · 🔢 numbers: ${stats.numbers} · ⚪️ null: ${stats.nulls}\n\n` +
          `<b>${fa ? "فرمت‌شده" : "Formatted"}</b>\n<pre>${tgEscape(JSON.stringify(obj, null, 2).slice(0, 2400))}</pre>` +
          `\n<b>Minified</b> (<code>${JSON.stringify(obj).length}</code> chars)\n<pre>${tgEscape(JSON.stringify(obj).slice(0, 800))}</pre>`,
        kb([[{ text: "🔁 " + (fa ? "ورودی دیگر" : "Another"), cb: "dvu:json" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
        !!h.cbId,
      );
    } catch (e: any) {
      const msg = String(e.message);
      const pos = Number(msg.match(/position (\d+)/)?.[1] ?? 0);
      const ctx = input.slice(Math.max(0, pos - 30), pos + 30);
      await h.reply(
        `❌ <b>${fa ? "JSON نامعتبر" : "Invalid JSON"}</b>\n<code>${tgEscape(msg.slice(0, 160))}</code>\n\n` +
          (pos ? `<b>${fa ? "نزدیک خطا" : "near error"}</b>:\n<pre>${tgEscape(ctx)}</pre>` : ""),
        kb([[{ text: "🔁 " + (fa ? "دوباره" : "Retry"), cb: "dvu:json" }]]),
        !!h.cbId,
      );
    }
  }

  async gitignore(h: H) {
    const fa = h.loc === "fa";
    const stacks = ["node", "python", "go", "rust", "java", "php", "ruby", "swift", "flutter", "dotnet"];
    await h.reply(
      `📝 <b>.gitignore ${fa ? "ساز" : "generator"}</b>\n\n${fa ? "استک پروژه را انتخاب کن:" : "Pick your stack:"}`,
      kb(
        ...chunk(stacks, 3).map((row) => row.map((s) => ({ text: s, cb: `dvu:gi:${s}` }))),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
      ),
      !!h.cbId,
    );
  }

  async gitignoreFor(h: H, stack: string) {
    const fa = h.loc === "fa";
    const content = GITIGNORE[stack] ?? "# unknown stack\n";
    await h.tg.sendDocument(h.chatId, `.gitignore.${stack}`, new TextEncoder().encode(content + "\n" + (GITIGNORE.os ?? "")),
      `📝 <b>.gitignore</b> — ${tgEscape(stack)} · ${fa ? "شامل الگوهای سیستمی" : "includes OS patterns"}`, { parse_mode: "HTML" });
    await h.reply(`<pre>${tgEscape(content.slice(0, 1200))}</pre>`, kb([[{ text: "🔁 " + (fa ? "استک دیگر" : "Another"), cb: "dvu:gitignore" }]]));
  }

  async semver(h: H, version?: string) {
    const fa = h.loc === "fa";
    const v = version ?? "1.0.0";
    const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?(?:\+([\w.]+))?$/);
    if (!m) {
      return h.reply(`❌ ${fa ? "نسخه نامعتبر. مثال: <code>1.4.2</code>" : "invalid. e.g. 1.4.2"}`,
        kb([[{ text: "◀️", cb: "dvu:home" }]]), !!h.cbId);
    }
    const [_, major, minor, patch, pre, build] = m;
    const bump = (kind: string) =>
      kind === "major" ? `${+major + 1}.0.0` :
      kind === "minor" ? `${major}.${+minor + 1}.0` :
      kind === "patch" ? `${major}.${minor}.${+patch + 1}` :
      kind === "pre" ? `${major}.${minor}.${+patch + 1}-rc.1` : v;
    await h.reply(
      `🔢 <b>SemVer ${tgEscape(v)}</b>\n\n` +
        `major=<code>${major}</code> minor=<code>${minor}</code> patch=<code>${patch}</code>${pre ? ` pre=<code>${tgEscape(pre)}</code>` : ""}${build ? ` build=<code>${tgEscape(build)}</code>` : ""}\n\n` +
        `🔴 breaking → <code>${bump("major")}</code>\n🟡 feature → <code>${bump("minor")}</code>\n🟢 fix → <code>${bump("patch")}</code>\n🧪 rc → <code>${bump("pre")}</code>\n\n` +
        (fa ? `<i>قاعده: از سمت راست صفر کن — نسخه major جدید یعنی minor و patch صفر می‌شوند.</i>` : ""),
      kb(
        [
          { text: "🔴 major", cb: `dvu:sv:${bump("major")}` },
          { text: "🟡 minor", cb: `dvu:sv:${bump("minor")}` },
          { text: "🟢 patch", cb: `dvu:sv:${bump("patch")}` },
        ],
        [{ text: "🔁 " + (fa ? "نسخه دیگر" : "Another"), cb: "dvu:semver" }],
      ),
      !!h.cbId,
    );
  }

  async color(h: H, hex?: string) {
    const fa = h.loc === "fa";
    if (!hex) {
      const palette = ["#0f172a", "#22d3ee", "#a3e635", "#f472b6", "#fbbf24", "#ef4444"];
      return h.reply(
        `🎨 <b>${fa ? "ابزار رنگ" : "Color tool"}</b>\n\n${fa ? "یک کد رنگ بفرست (مثل <code>#22d3ee</code>) تا RGB، HSL و کنتراست را بگیری." : "Send a hex color."}`,
        kb(
          chunk(palette, 3).map((row) => row.map((c) => ({ text: c, cb: `dvu:color:${c}` }))),
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }],
        ),
        !!h.cbId,
      );
    }
    const h6 = hex.replace("#", "");
    const r = parseInt(h6.slice(0, 2), 16), g = parseInt(h6.slice(2, 4), 16), b = parseInt(h6.slice(4, 6), 16);
    const { h: hh, s, l } = rgbToHsl(r, g, b);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    await h.reply(
      `🎨 <b>${tgEscape(hex)}</b>\n\n` +
        `RGB: <code>rgb(${r}, ${g}, ${b})</code>\nHSL: <code>hsl(${Math.round(hh)}, ${Math.round(s)}%, ${Math.round(l)}%)</code>\n` +
        `Luminance: <b>${lum.toFixed(3)}</b> → ${lum > 0.5 ? "⬛️ " + (fa ? "متن مشکی" : "black text") : "⬜️ " + (fa ? "متن سفید" : "white text")}\n` +
        `WCAG: ${lum > 0.5 ? (fa ? "مناسب پس‌زمینه روشن" : "good on light") : (fa ? "مناسب پس‌زمینه تیره" : "good on dark")}\n` +
        `Tailwind-ish: <code>${nearestTailwind(r, g, b)}</code>`,
      kb([[{ text: "🔁 " + (fa ? "رنگ دیگر" : "Another"), cb: "dvu:color" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "dvu:home" }]]),
      !!h.cbId,
    );
  }
}

// ── implementations ────────────────────────────────────────────────────────
const GITIGNORE: Record<string, string> = {
  node: `node_modules/\ndist/\nbuild/\n.cache/\ncoverage/\n*.log\n.env\n.env.*\n!.env.example\n.npm\n.pnpm-store/\n`,
  python: `__pycache__/\n*.py[cod]\n.venv/\nvenv/\nenv/\n*.egg-info/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\ndist/\nbuild/\n.env\n`,
  go: `bin/\n*.exe\n*.test\n*.out\nvendor/\n.env\n.DS_Store\n`,
  rust: `target/\n**/*.rs.bk\nCargo.lock\n.env\n`,
  java: `target/\n*.class\n*.jar\n!.mvn/wrapper/maven-wrapper.jar\n.gradle/\nbuild/\n`,
  php: `vendor/\ncomposer.lock\n.env\n*.log\nstorage/framework/cache/\n`,
  ruby: `.bundle/\nvendor/bundle\n*.gem\nGemfile.lock\n.env\n`,
  swift: `.build/\nDerivedData/\n*.xcuserstate\n.swiftpm/\n`,
  flutter: `.dart_tool/\n.packages\nbuild/\n.flutter-plugins\nios/Pods/\nandroid/.gradle/\n`,
  dotnet: `bin/\nobj/\n*.user\n.vs/\n`,
  os: `\n# OS\n.DS_Store\nThumbs.db\ndesktop.ini\n*.swp\n*~\n`,
};

export function explainCron(expr: string, fa: boolean): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const names: Record<string, string> = { "1": "دوشنبه", "2": "سه‌شنبه", "3": "چهارشنبه", "4": "پنجشنبه", "5": "جمعه", "6": "شنبه", "0": "یکشنبه", "7": "یکشنبه" };
  const namesEn: Record<string, string> = { "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "0": "Sunday", "7": "Sunday" };
  const faNum = (s: string) => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
  const fmt = (s: string) => {
    if (s === "*") return fa ? "هر" : "every";
    if (s.startsWith("*/")) return fa ? `هر ${faNum(s.slice(2))}` : `every ${s.slice(2)}`;
    if (/^\d+-\d+$/.test(s)) { const [a, b2] = s.split("-"); return fa ? `از ${faNum(a)} تا ${faNum(b2)}` : `${a}-${b2}`; }
    if (s.includes(",")) return s;
    return s;
  };
  if (fa) {
    return `⏱ دقیقه: ${fmt(min)} · 🕐 ساعت: ${fmt(hour)} · 📅 روز ماه: ${fmt(dom)} · 🗓 ماه: ${fmt(mon)} · 📆 روز هفته: ${
      dow === "*" ? "هر روز" : dow.split(",").map((d) => names[d] ?? d).join(" و ")}`;
  }
  return `minute: ${fmt(min)} · hour: ${fmt(hour)} · day-of-month: ${fmt(dom)} · month: ${fmt(mon)} · weekday: ${
    dow === "*" ? "every day" : dow.split(",").map((d) => namesEn[d] ?? d).join(" and ")}`;
}

/** Lightweight cron scheduler: finds the next N matching UTC timestamps (brute force minute scan). */
export function nextRuns(expr: string, count: number): Date[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const match = (field: string, value: number, min: number, max: number) => {
    for (const seg of field.split(",")) {
      const stepMatch = seg.match(/^\*(\/(\d+))?$/) ?? seg.match(/^(\d+)-(\d+)(\/(\d+))?$/) ?? seg.match(/^(\d+)$/);
      if (!stepMatch) continue;
      if (seg.startsWith("*")) {
        const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
        if ((value - min) % step === 0) return true;
      } else if (seg.includes("-")) {
        const [, a, b, , st] = stepMatch as any;
        const step = st ? Number(st) : 1;
        if (value >= Number(a) && value <= Number(b) && (value - Number(a)) % step === 0) return true;
      } else if (Number(seg) === value) return true;
    }
    return false;
  };
  const out: Date[] = [];
  const d = new Date();
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 400 && out.length < count; i++) {
    if (
      match(parts[0], d.getUTCMinutes(), 0, 59) &&
      match(parts[1], d.getUTCHours(), 0, 23) &&
      match(parts[2], d.getUTCDate(), 1, 31) &&
      match(parts[3], d.getUTCMonth() + 1, 1, 12) &&
      match(parts[4], d.getUTCDay(), 0, 6)
    ) out.push(new Date(d));
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return out;
}

export function cidrCalc(input: string) {
  const hmm = input.includes("/") ? input : /^\d+\.\d+\.\d+\.\d+$/.test(input) ? input + "/32" : null;
  if (!hmm) return null;
  const [ip, bitsStr] = hmm.split("/");
  const bits = Number(bitsStr);
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => p > 255 || p < 0) || !(bits >= 0 && bits <= 32)) return null;
  const ipNum = (parts[0] << 24 >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const hosts = bits >= 31 ? Math.pow(2, 32 - bits) : Math.pow(2, 32 - bits) - 2;
  const maskIp = toIp(mask);
  const wildcard = toIp(~mask >>> 0);
  const table =
    `Address:       ${ip}\n` +
    `Network:       ${toIp(network)}/${bits}\n` +
    `Netmask:       ${maskIp}\n` +
    `Wildcard:      ${wildcard}\n` +
    `Broadcast:     ${toIp(broadcast)}\n` +
    `Host range:    ${toIp(network + (bits < 31 ? 1 : 0))} – ${toIp(broadcast - (bits < 31 ? 1 : 0))}\n` +
    `Usable hosts:  ${hosts.toLocaleString("en-US")}\n` +
    `Total addrs:   ${Math.pow(2, 32 - bits).toLocaleString("en-US")}\n` +
    `Type:          ${isPrivateNet(network) ? "PRIVATE (RFC1918)" : "PUBLIC"}\n` +
    `CIDR notation: ${toIp(network)}/${bits}`;
  // subnetting preview if /24 or broader
  let subnets: { bits: number; sample: string } | undefined;
  if (bits <= 24) {
    const newBits = bits + 1;
    const size = Math.pow(2, 32 - newBits);
    const sample = Array.from({ length: Math.min(4, Math.pow(2, newBits - bits)) }, (_, i) => `${toIp(network + i * size)}/${newBits}`).join("\n");
    subnets = { bits: newBits, sample: sample + `\n… (${Math.pow(2, newBits - bits)} subnets)` };
  }
  return { table, subnets };
}

/** RFC1918 / loopback / CGNAT detection on a 32-bit network address. */
export function isPrivateNet(n: number): boolean {
  const a = (n >>> 24) & 255;
  const b = (n >>> 16) & 255;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function jsonStats(obj: any) {
  let keys = 0, depth = 0, arrays = 0, strings = 0, numbers = 0, nulls = 0;
  const walk = (v: any, d: number) => {
    depth = Math.max(depth, d);
    if (v === null) { nulls++; return; }
    if (Array.isArray(v)) { arrays++; v.forEach((x) => walk(x, d + 1)); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) { keys++; walk(v[k], d + 1); }
      return;
    }
    if (typeof v === "string") strings++;
    else if (typeof v === "number") numbers++;
  };
  walk(obj, 1);
  return { keys, depth, arrays, strings, numbers, nulls, size: JSON.stringify(obj).length };
}

export function genUlid() {
  const enc = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let t = "";
  for (let i = 0; i < 10; i++) { t = enc[time % 32] + t; time = Math.floor(time / 32); }
  let r = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) r += enc[bytes[i] % 32];
  return t + r;
}
export function genNano(n: number) {
  const ab = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ab[b % 64]).join("");
}
export function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
  }
  return { h: hh, s: s * 100, l: l * 100 };
}
function nearestTailwind(r: number, g: number, b: number) {
  const palette: [string, number, number, number][] = [
    ["slate-900", 15, 23, 42], ["cyan-400", 34, 211, 238], ["lime-400", 163, 230, 53],
    ["pink-400", 244, 114, 182], ["amber-400", 251, 191, 36], ["red-500", 239, 68, 68],
    ["blue-600", 37, 99, 235], ["emerald-500", 16, 185, 129], ["violet-500", 139, 92, 246], ["gray-500", 107, 114, 128],
  ];
  let best = palette[0], bd = Infinity;
  for (const p of palette) {
    const d = (p[1] - r) ** 2 + (p[2] - g) ** 2 + (p[3] - b) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best[0];
}
function chunk<T>(arr: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
