import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { h1, aside, p, table, footer, hr, sendRich, richToLegacy } from "../tg/rich";
import { parseRepoRef } from "../core/repo-ref";
import { setMode, clearMode, readMode, touchMode } from "../core/mode";
import { GithubRest } from "../github/rest";
import { channelRepoKb } from "./channelarm";
import { botUsername } from "../env";

/**
 * PROJECT SHOWCASE — «پروژه‌ات را معرفی کن»
 *
 * Any user sends their project in the bot's PV; the bot builds a showcase
 * post — their own words and photos, or a short AI analysis with tables and
 * a score — and publishes it straight into the owner's channel. Under the
 * post sits the signature key: ⭐ — a REAL GitHub star, given from inside
 * Telegram like a reaction. GitHub will not let anyone star anonymously, so
 * a reader links their account once (20 seconds, the existing flow) and
 * every star after that is one tap in the channel, with a live counter.
 */

export class Showcase {
  // ── pure, tested ────────────────────────────────────────────────────────

  /** 0-100 from live repo facts — never from the AI, so it is reproducible
   *  and explainable: activity, popularity, community, maturity. */
  repoScore(s: {
    stars: number; forks: number; pushedAt: number; createdAt: number;
    license: string | null; archived?: boolean; now?: number;
  }): { total: number; grade: string; parts: { activity: number; popularity: number; community: number; maturity: number } } {
    const now = s.now ?? Date.now();
    const daysIdle = Math.max(0, (now - s.pushedAt) / 86_400_000);
    const ageDays = Math.max(1, (now - s.createdAt) / 86_400_000);
    const activity = daysIdle <= 7 ? 30 : daysIdle <= 30 ? 24 : daysIdle <= 90 ? 15 : daysIdle <= 180 ? 8 : 2;
    const popularity = Math.round(30 * Math.min(1, Math.log10(Math.max(1, s.stars)) / 4));
    const community = Math.round(Math.min(20, Math.log10(Math.max(1, s.forks)) * 8));
    const maturity = Math.min(20,
      (ageDays >= 365 ? 8 : ageDays >= 90 ? 5 : 2) +
      (s.license ? 6 : 0) +
      (s.archived ? 0 : 6));
    const total = Math.max(0, Math.min(100, activity + popularity + community + maturity));
    const grade = total >= 85 ? "🥇 A" : total >= 70 ? "🥈 B" : total >= 50 ? "🥉 C" : "🎫 D";
    return { total, grade, parts: { activity, popularity, community, maturity } };
  }

  /** owner/repo ⇄ sc:star:owner_repo (the first underscore is the separator —
   *  GitHub usernames never carry one, repo names may). */
  starCb(ref: string): string {
    return `sc:star:${ref.replace("/", "_")}`;
  }

  refFromStarCb(rest: string): string | null {
    /* GitHub usernames carry no underscore, so the FIRST one is the
     * separator — repo names may contain as many as they like. */
    const m = /^([^_\W][^_]*)_(\w[\w.-]*)$/.exec(rest.trim());
    return m ? `${m[1]}/${m[2]}` : null;
  }

  starLabel(count: number, fa: boolean): string {
    return `⭐ ${fa ? "ستاره بده" : "Star it"}${count > 0 ? ` · ${count}` : ""}`;
  }

  // ── the flow ────────────────────────────────────────────────────────────

  /** Entry — ask for the project. */
  async intro(h: H) {
    const fa = h.loc === "fa";
    const left = await this.rateLimitLeftMs(h);
    if (left > 0) {
      const hLeft = Math.ceil(left / 3_600_000);
      return h.reply(
        fa
          ? `⏳ <b>هر ۱۲ ساعت یک پروژه</b> — ${hLeft} ساعت دیگر دوباره بیا.`
          : `⏳ One project per 12 hours — come back in ${hLeft}h.`,
        kb([[{ text: "🏠 " + (fa ? "منوی اصلی" : "Menu"), cb: "m:home" }]]),
        !!h.cbId,
      );
    }
    await setMode(h.session, "sc_repo", {});
    return h.reply(
      fa
        ? `🚀 <b>پروژه‌ات را معرفی کن!</b>\n\n` +
          `لینک گیت‌هاب پروژه را بفرست (مثل <code>owner/repo</code>) تا با استایل کامل در چنل منتشرش کنم:\n` +
          `• تحلیل کوتاه یا متن و عکس خودت\n` +
          `• جدول مشخصات + نمرهٔ پروژه + کارت سازنده\n` +
          `• آواتار گیت‌هابت بالای پست\n` +
          `• و دکمهٔ <b>⭐ ستارهٔ واقعی</b> — خواننده‌ها از همان چنل به پروژه‌ات ستاره می‌دهند!`
        : `🚀 <b>Feature your project!</b>\n\nSend its GitHub link (e.g. <code>owner/repo</code>) — I'll publish it in the channel with tables, a score and a ⭐ real-star button.`,
      kb([[{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }]]),
      !!h.cbId,
    );
  }

  /** Step two — whose words: theirs or the AI's. */
  async choose(h: H, ref: string) {
    const fa = h.loc === "fa";
    await setMode(h.session, "sc_choose", { ref });
    return h.reply(
      fa
        ? `✅ <b>${tgEscape(ref)}</b> ثبت شد.\n\nچطور معرفی شود؟\n\n` +
          `✍️ <b>خودم توضیح می‌دهم</b> — متن و عکس‌های خودت، دست‌نخورده\n` +
          `🤖 <b>خودت بساز</b> — تحلیل کوتاهٔ هوشمند + جدول‌ها + نمرهٔ ۰ تا ۱۰۰\n\n` +
          `<i>در هر دو حالت بلافاصله در چنل منتشر می‌شود.</i>`
        : `✅ <b>${tgEscape(ref)}</b> noted. Your words, or mine?`,
      kb(
        [{ text: "✍️ " + (fa ? "خودم توضیح می‌دهم" : "I'll describe it"), cb: "sc:self" }],
        [{ text: "🤖 " + (fa ? "خودت با AI بساز" : "Build it with AI"), cb: "sc:auto" }],
        [{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }],
      ),
      !!h.cbId,
    );
  }

  /** Mode sc_repo — the link arrives. */
  async receiveRepo(h: H, t: string) {
    const fa = h.loc === "fa";
    const ref = parseRepoRef(t);
    if (!ref) {
      return h.reply(
        fa ? "❌ این به نظر ریپوی گیت‌هاب نمی‌آید — مثلاً <code>owner/repo</code> یا لینک کامل را بفرست." : "❌ That doesn't look like a GitHub repo.",
        kb([[{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }]]),
      );
    }
    return this.choose(h, ref);
  }

  /** Mode sc_text — their own words. */
  async receiveText(h: H, t: string) {
    const fa = h.loc === "fa";
    const m = await readMode(h.session).catch(() => null as any);
    const ref = String((m as any)?.data?.ref ?? "");
    if (!t.trim()) return this.intro(h);
    await setMode(h.session, "sc_photo", { ref, text: t.trim(), photos: [] });
    return h.reply(
      fa
        ? `✍️ ثبت شد.\n\nاگر <b>عکس</b> هم داری همین‌جا بفرست (تا ۱۰ تا) — بعدش «تمام» را بزن تا منتشر شود.`
        : `✍️ Noted. Send photos here (up to 10) if you have any — then press Done to publish.`,
      kb(
        [{ text: "✅ " + (fa ? "تمام — منتشرش کن" : "Done — publish"), cb: "sc:done" }],
        [{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }],
      ),
    );
  }

  /** Mode sc_photo — photos (with or without captions) or the done word. */
  async receiveMedia(h: H, t: string) {
    const fa = h.loc === "fa";
    const m: any = await readMode(h.session).catch(() => null);
    const ref = String(m?.data?.ref ?? "");
    const text = String(m?.data?.text ?? "");
    const photos: string[] = Array.isArray(m?.data?.photos) ? [...m.data.photos] : [];
    const fileId = (h.msg as any)?.photo?.[(h.msg as any).photo.length - 1]?.file_id as string | undefined;
    if (fileId) {
      photos.push(fileId);
      if (photos.length >= 10) return this.buildAndPublish(h, ref, text, photos);
      await touchMode(h.session, { ...m, data: { ...m.data, photos } });
      return h.reply(
        fa ? `📸 عکس ${photos.length} ثبت شد — بیشتر داری بفرست، یا «تمام» را بزن.` : `📸 Photo ${photos.length} saved — send more, or press Done.`,
        kb([{ text: "✅ " + (fa ? "تمام — منتشرش کن" : "Done — publish"), cb: "sc:done" }]),
      );
    }
    if (/^(تمام|پایان|انتها|done|end|ok)$/i.test(t.trim())) return this.buildAndPublish(h, ref, text, photos);
    return h.reply(
      fa ? "📷 عکس بفرست، یا دکمهٔ «تمام» را بزن." : "📷 Send a photo, or press Done.",
      kb([{ text: "✅ " + (fa ? "تمام — منتشرش کن" : "Done — publish"), cb: "sc:done" }]),
    );
  }

  // ── the build & publish ─────────────────────────────────────────────────

  async buildAndPublish(h: H, ref: string, userText?: string, photos: string[] = []) {
    const fa = h.loc === "fa";
    await clearMode(h.session).catch(() => null);
    if (!ref) return this.intro(h);
    if ((await this.rateLimitLeftMs(h)) > 0) return this.intro(h);
    const target = await this.channelTarget(h);
    if (!target) {
      return h.reply(fa ? "⚠️ کانالِ معرفی تنظیم نشده — بعداً تلاش کن." : "⚠️ Showcase channel is not configured.");
    }
    await h.loading(fa ? "🚀 در حال ساخت پست معرفی…" : "Building the showcase post…");

    /* facts first, words second: the AI never invents numbers */
    const gh = new GithubRest(h.env);
    const repo: any = await gh.get(`/repos/${ref}`, 600).catch(() => null);
    if (!repo?.full_name) {
      return h.reply(
        fa ? `❌ این ریپو پیدا نشد: <code>${tgEscape(ref)}</code>` : `❌ Repo not found: <code>${tgEscape(ref)}</code>`,
        kb([[{ text: "🔁 " + (fa ? "دوباره" : "Retry"), cb: "sc:home" }]]),
      );
    }
    const owner: any = await gh.get(`/users/${repo.owner?.login}`, 3600).catch(() => null);
    const serial = await this.nextSerial(h);
    const score = this.repoScore({
      stars: Number(repo.stargazers_count ?? 0),
      forks: Number(repo.forks_count ?? 0),
      pushedAt: Date.parse(String(repo.pushed_at ?? "")) || Date.now(),
      createdAt: Date.parse(String(repo.created_at ?? "")) || Date.now(),
      license: repo.license?.spdx_id ?? null,
      archived: !!repo.archived,
    });

    /* the AI writes only the words: a few lines and one hook */
    let summary = "", hook = "";
    if (!userText) {
      const daysIdle = Math.max(0, Math.round((Date.now() - Date.parse(String(repo.pushed_at ?? ""))) / 86_400_000));
      const ageMonths = Math.max(1, Math.round((Date.now() - Date.parse(String(repo.created_at ?? ""))) / (30 * 86_400_000)));
      const facts =
        `- نام: ${repo.full_name}\n- توضیح: ${String(repo.description ?? "—")}\n` +
        `- زبان: ${repo.language ?? "—"} · ستاره: ${repo.stargazers_count ?? 0} · فورک: ${repo.forks_count ?? 0}\n` +
        `- مجوز: ${repo.license?.spdx_id ?? "ندارد"} · اییشوهای باز: ${repo.open_issues_count ?? 0}\n` +
        `- آخرین تغییر: ${daysIdle} روز پیش · عمر: ${ageMonths} ماه\n` +
        `- سازنده: ${repo.owner?.login ?? "?"}${owner ? ` (فالوور: ${owner.followers ?? 0}، ریپوها: ${owner.public_repos ?? 0})` : ""}\n` +
        `- موضوعات: ${Array.isArray(repo.topics) && repo.topics.length ? repo.topics.join("، ") : "—"}`;
      const out = await h.ai.chat(
        `تو سردبیر یک کانال تکنولوژی فارسی هستی. دربارهٔ این ریپوی گیت‌هاب، فقط بر اساس مشخصات واقعی زیر، بنویس:\n\n${facts}\n\n` +
        `دقیقاً این قالب را برگردان، هیچ چیز دیگری ننویس، از markdown استفاده نکن جز **بولد**:\n` +
        `SUMMARY:\n(حداکثر ۵ خط فارسی روان: این پروژه چیست، چه مشکلی را حل می‌کند، برای چه کسی)\n` +
        `HOOK:\n(یک جملهٔ کوتاه کوبنده با قیاس، مثل: «مثل Hugging Face — ولی ده برابر سبک‌تر»)\n`,
        { deadlineMs: h.budget(), tier: "smart", max_tokens: 700, temperature: 0.3, feature: "showcase" },
      ).catch(() => "");
      const m = /SUMMARY:\s*([\s\S]*?)\nHOOK:\s*([\s\S]*)/.exec(String(out ?? ""));
      const clean = (x: string) => tgEscape(x.trim().replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")).replace(/&lt;(\/?b)&gt;/g, "<$1>");
      if (m) { summary = clean(m[1]); hook = clean(m[2]); }
      if (!summary) summary = tgEscape(String(repo.description ?? repo.full_name));
      if (!hook) hook = tgEscape(String(repo.full_name));
    }

    /* the post: rich when it is words, photo(s) when the maker sent them */
    const url = `https://github.com/${ref}`;
    const botUser = botUsername(h.env);
    const starRow = this.starCb(ref).length <= 64
      ? [[{ text: this.starLabel(0, fa), callback_data: this.starCb(ref), style: "primary" }]]
      : [];
    const glass = channelRepoKb(ref, botUser).inline_keyboard;
    const markup = { inline_keyboard: [...starRow, ...glass] };
    let mid: number | null = null;

    const header = fa ? `🚀 معرفی پروژهٔ #${serial}` : `🚀 Showcase #${serial}`;
    if (photos.length > 1) {
      /* a media group carries no buttons (Telegram's rule), so the keys ride
         on a compact card right before the photos */
      const card = await h.tg.sendRichMessage(target.send,
        h1(header) + aside(`<b>${tgEscape(String(repo.full_name))}</b>`) + footer(`🔗 ${url}`),
        { reply_markup: markup } as any,
      ).catch(() => null);
      mid = (card as any)?.result?.message_id ?? null;
      const cap = (fa ? `${header} — <b>${tgEscape(String(repo.full_name))}</b>\n\n` : `${header} — <b>${tgEscape(String(repo.full_name))}</b>\n\n`) +
        tgEscape(String(userText ?? "")).slice(0, 900) + `\n\n🔗 ${url}`;
      await h.tg.call("sendMediaGroup", {
        chat_id: target.send,
        media: photos.map((id, i) => ({ type: "photo", media: id, ...(i === 0 ? { caption: cap, parse_mode: "HTML" } : {}) })),
      }).catch(() => null);
    } else if (photos.length === 1) {
      const cap = `${header} — <b>${tgEscape(String(repo.full_name))}</b>\n\n` +
        tgEscape(String(userText ?? "")).slice(0, 900) + `\n\n🔗 ${url}`;
      const r: any = await h.tg.sendPhoto(target.send as any, photos[0], cap, { parse_mode: "HTML", reply_markup: markup } as any).catch(() => null);
      mid = r?.result?.message_id ?? null;
    } else {
      const rich =
        h1(header) +
        aside(`<b>${tgEscape(String(repo.full_name))}</b>${hook ? ` — ${hook}` : ""}`) +
        p(userText ? tgEscape(userText) : summary) +
        table([
          [fa ? "ویژگی" : "Field", fa ? "مقدار" : "Value"],
          [fa ? "زبان / استک" : "Stack", `${tgEscape(String(repo.language ?? "—"))}`],
          [fa ? "ستاره‌های گیت‌هاب" : "GitHub stars", `${Number(repo.stargazers_count ?? 0).toLocaleString("fa-IR")}`],
          [fa ? "فورک" : "Forks", `${Number(repo.forks_count ?? 0).toLocaleString("fa-IR")}`],
          [fa ? "مجوز" : "License", tgEscape(String(repo.license?.spdx_id ?? "—"))],
        ], { caption: fa ? "🧪 کارت پروژه" : "🧪 Project card" }) +
        table([
          [fa ? "بخش" : "Part", fa ? "امتیاز" : "Score"],
          [fa ? "فعالیت" : "Activity", `${score.parts.activity}/30`],
          [fa ? "محبوبیت" : "Popularity", `${score.parts.popularity}/30`],
          [fa ? "جامعه" : "Community", `${score.parts.community}/20`],
          [fa ? "بلوغ" : "Maturity", `${score.parts.maturity}/20`],
          [fa ? "کل" : "Total", `<b>${score.total}/100 — ${score.grade}</b>`],
        ], { caption: fa ? "🏅 نمرهٔ پروژه" : "🏅 Project score" }) +
        (owner ? table([
          [fa ? "سازنده" : "Maker", ""],
          ["👤", `<a href="https://github.com/${tgEscape(String(owner.login))}">${tgEscape(String(owner.login))}</a>`],
          [fa ? "فالوورها" : "Followers", `${Number(owner.followers ?? 0).toLocaleString("fa-IR")}`],
          [fa ? "ریپوهای عمومی" : "Public repos", `${Number(owner.public_repos ?? 0)}`],
        ], { caption: fa ? "👤 سازندهٔ پروژه" : "👤 The maker" }) : "") +
        hr() +
        footer(`🔗 ${url}`);
      try {
        const r: any = await h.tg.sendRichMessage(target.send, rich, { reply_markup: markup } as any);
        mid = r?.result?.message_id ?? null;
      } catch {
        const r2: any = await h.tg.sendLong(target.send, richToLegacy(rich), { parse_mode: "HTML", reply_markup: markup as any }).catch(() => null);
        mid = r2?.result?.message_id ?? null;
      }
    }

    await h.store.event(h.u.id, "showcase", ref, { serial, msgId: mid, channel: target.send, mode: userText ? "custom" : "auto" }).catch(() => null);
    await (h.store as any).addXp?.(h.u.id, 30, "showcase").catch?.(() => null);

    const link = target.display.startsWith("@") && mid ? `\nhttps://t.me/${target.display.replace("@", "")}/${mid}` : "";
    return h.reply(
      fa
        ? `✅ <b>پروژهٔ تو معرفی شد!</b>\n\n🏅 پست شمارهٔ #${serial} — نمرهٔ ${score.total}/100 ${score.grade}\n${link}\n\n` +
          `همین حالا فورواردش کن تا بیشتر دیده شوی 😉 و هر ستاره‌ای که از چنل بخورد، خبرت می‌کنم ⭐`
        : `✅ <b>Published!</b> — post #${serial}, score ${score.total}/100 ${score.grade}${link}`,
      kb(
        [{ text: "🚀 " + (fa ? "پروژهٔ بعدی" : "Next project"), cb: "sc:home" }],
        [{ text: "🏠 " + (fa ? "منوی اصلی" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  // ── the star — a real one, from inside Telegram ──────────────────────────

  /** Called from the channel button. `token` is the presser's own GitHub
   *  token (resolved in index.ts, which owns the decryption). */
  async starPressed(h: H, ref: string, token: string, quiet = false): Promise<{ ok: boolean; dup?: boolean; count?: number; err?: string }> {
    const fa = h.loc === "fa";
    const dup = await h.env.DB.prepare(
      `SELECT 1 AS x FROM events WHERE kind='showcase_star' AND name=? AND user_id=? LIMIT 1`,
    ).bind(ref, h.u.id).first().catch(() => null);
    if (dup) {
      if (!quiet) await h.toast(fa ? "قبلاً ستاره داده‌ای ⭐" : "Already starred ⭐");
      return { ok: true, dup: true, count: await this.starCount(h, ref) };
    }
    const r = await fetch(`https://api.github.com/user/starred/${ref}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-length": "0" },
    }).catch(() => null);
    if (r?.status === 401 || r?.status === 403) {
      if (!quiet) await h.toast(fa ? "اتصال گیت‌هابت منقضی شده — با /login تازه کن" : "GitHub link expired — /login");
      return { ok: false, err: "token" };
    }
    if (!r || r.status >= 400) {
      if (!quiet) await h.toast(fa ? "❌ ستاره ثبت نشد — یک بار دیگر بزن" : "❌ Could not star — try again");
      return { ok: false, err: String(r?.status ?? "network") };
    }
    await h.store.event(h.u.id, "showcase_star", ref, { via: "channel" }).catch(() => null);
    const count = await this.starCount(h, ref);

    /* the counter on the button ticks up, reaction-style */
    const rows = (h.msg as any)?.reply_markup?.inline_keyboard;
    if (Array.isArray(rows) && rows.length) {
      const next = rows.map((row: any[], ri: number) =>
        ri === 0 && row[0]?.callback_data === this.starCb(ref)
          ? [{ ...row[0], text: this.starLabel(count, fa) }] : row);
      await h.tg.call("editMessageReplyMarkup", {
        chat_id: h.chatId, message_id: (h.msg as any)?.message_id, reply_markup: { inline_keyboard: next },
      }).catch(() => null);
    }
    if (!quiet) await h.toast(fa ? `⭐ ستاره‌ات نشست! (${count} ستارهٔ تلگرامی)` : `⭐ Starred! (${count} from Telegram)`);
    await this.notifyMaker(h, ref, count);
    return { ok: true, count };
  }

  async starCount(h: H, ref: string): Promise<number> {
    const r = await h.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS c FROM events WHERE kind='showcase_star' AND name=?`,
    ).bind(ref).first().catch(() => null);
    return Number((r as any)?.c ?? 0);
  }

  /** The maker hears about every star — until it gets loud, then milestones. */
  async notifyMaker(h: H, ref: string, count: number) {
    if (!(count <= 10 || count % 10 === 0)) return;
    const row: any = await h.env.DB.prepare(
      `SELECT user_id FROM events WHERE kind='showcase' AND name=? ORDER BY ts ASC LIMIT 1`,
    ).bind(ref).first().catch(() => null);
    const uid = Number(row?.user_id ?? 0);
    if (!uid || uid === h.u.id) return;
    const fa = h.loc === "fa";
    await h.tg.sendMessage(
      uid,
      fa
        ? `⭐ <b>پروژه‌ات ستاره گرفت!</b>\nالان <b>${count}</b> ستارهٔ تلگرامی روی <code>${tgEscape(ref)}</code> نشسته.`
        : `⭐ <b>Your project got a star!</b>\n<b>${count}</b> Telegram stars on <code>${tgEscape(ref)}</code> now.`,
      { parse_mode: "HTML" },
    ).catch(() => null);
  }

  /** After a fresh GitHub link, a star that was waiting lands by itself. */
  async tryPendingStar(h: H, token: string) {
    const ref = String((await h.session.get("sc:pending").catch(() => null)) ?? "");
    if (!ref.includes("/")) return;
    await h.session.clear(["sc:pending"]).catch(() => null);
    const r = await this.starPressed(h, ref, token, true).catch(() => ({ ok: false }));
    const fa = h.loc === "fa";
    if (r.ok) {
      await h.reply(
        fa
          ? `⭐ <b>و ستارهٔ معطل‌مانده‌ات هم همین حالا نشست!</b>\nاز این به بعد هر ستاره فقط یک لمس است — دکمهٔ ⭐ زیر پست‌های چنل.`
          : `⭐ <b>Your waiting star just landed too!</b> Every star from now on is one tap — the ⭐ key under channel posts.`,
      ).catch(() => null);
    }
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /** Where the showcases go: the owner's channel, by secret or by their
   *  connected telegram channel. */
  async channelTarget(h: H): Promise<{ send: string; display: string } | null> {
    const fromEnv = String((h.env as any).SHOWCASE_CHANNEL ?? "").trim();
    if (fromEnv) return { send: fromEnv, display: fromEnv };
    const row: any = await h.env.DB.prepare(
      `SELECT label, config FROM hub_connectors WHERE kind='telegram' AND enabled=1 ` +
      `AND owner_id=(SELECT id FROM users WHERE plan='admin' ORDER BY id LIMIT 1) ORDER BY created_at DESC LIMIT 1`,
    ).first().catch(() => null);
    let cfg: any = {}; try { cfg = JSON.parse(row?.config ?? "{}"); } catch { /* {} */ }
    const ch = String(cfg.channel ?? "");
    return ch ? { send: ch, display: ch } : null;
  }

  /** One project per user per 12 hours — the channel must not drown. */
  async rateLimitLeftMs(h: H): Promise<number> {
    const r = await h.env.DB.prepare(
      `SELECT MAX(ts) AS last FROM events WHERE kind='showcase' AND user_id=? AND ts>?`,
    ).bind(h.u.id, Date.now() - 12 * 3_600_000).first().catch(() => null);
    const last = Number((r as any)?.last ?? 0);
    return last ? Math.max(0, last + 12 * 3_600_000 - Date.now()) : 0;
  }

  async nextSerial(h: H): Promise<number> {
    const row: any = await h.env.DB.prepare(`SELECT value FROM flags WHERE key='showcase:serial'`).first().catch(() => null);
    const n = Number(row?.value ?? 0) + 1;
    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind("showcase:serial", String(n), Date.now()).run().catch(() => null);
    return n;
  }
}
