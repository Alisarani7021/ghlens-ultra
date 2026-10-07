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

/** The frozen shape of one showcase post — built once at preview, reused
 *  verbatim at publish so the channel copy is the one the maker approved. */
export interface PostParts {
  ref: string; url: string; full: string;
  userText?: string; photos: string[]; banner: string; avatar: string;
  summary: string; hook: string;
  stack: string; stars: string; forks: string; license: string;
  score: { total: number; grade: string; parts: { activity: number; popularity: number; community: number; maturity: number } };
  owner: { login: string; url: string; followers: string; repos: string } | null;
}

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
      if (photos.length >= 10) return this.previewManual(h, ref, text, photos);
      await touchMode(h.session, { ...m, data: { ...m.data, photos } });
      return h.reply(
        fa ? `📸 عکس ${photos.length} ثبت شد — بیشتر داری بفرست، یا «تمام» را بزن.` : `📸 Photo ${photos.length} saved — send more, or press Done.`,
        kb([{ text: "✅ " + (fa ? "تمام — منتشرش کن" : "Done — publish"), cb: "sc:done" }]),
      );
    }
    if (/^(تمام|پایان|انتها|done|end|ok)$/i.test(t.trim())) return this.previewManual(h, ref, text, photos);
    return h.reply(
      fa ? "📷 عکس بفرست، یا دکمهٔ «تمام» را بزن." : "📷 Send a photo, or press Done.",
      kb([{ text: "✅ " + (fa ? "تمام — منتشرش کن" : "Done — publish"), cb: "sc:done" }]),
    );
  }

  // ── the build & publish ─────────────────────────────────────────────────

  /** Everything a post needs, frozen at preview time so the channel copy
   *  matches what the maker approved — character for character. */
  async preparePost(h: H, ref: string, userText?: string, photos: string[] = []): Promise<PostParts | null> {
    const fa = h.loc === "fa";
    if (!ref) { await this.intro(h); return null; }
    if ((await this.rateLimitLeftMs(h)) > 0) { await this.intro(h); return null; }
    const target = await this.channelTarget(h);
    if (!target) {
      await h.reply(fa ? "⚠️ کانالِ معرفی تنظیم نشده — بعداً تلاش کن." : "⚠️ Showcase channel is not configured.");
      return null;
    }
    await h.loading(fa ? "🚀 در حال ساخت پست معرفی…" : "Building the showcase post…");

    /* facts first, words second: the AI never invents numbers */
    const gh = new GithubRest(h.env);
    const repo: any = await gh.get(`/repos/${ref}`, 600).catch(() => null);
    if (!repo?.full_name) {
      await h.reply(
        fa ? `❌ این ریپو پیدا نشد: <code>${tgEscape(ref)}</code>` : `❌ Repo not found: <code>${tgEscape(ref)}</code>`,
        kb([[{ text: "🔁 " + (fa ? "دوباره" : "Retry"), cb: "sc:home" }]]),
      );
      return null;
    }
    const owner: any = await gh.get(`/users/${repo.owner?.login}`, 3600).catch(() => null);
    const score = this.repoScore({
      stars: Number(repo.stargazers_count ?? 0),
      forks: Number(repo.forks_count ?? 0),
      pushedAt: Date.parse(String(repo.pushed_at ?? "")) || Date.now(),
      createdAt: Date.parse(String(repo.created_at ?? "")) || Date.now(),
      license: repo.license?.spdx_id ?? null,
      archived: !!repo.archived,
    });

    /* the AI writes only the words: a few lines and one hook. JSON mode keeps
     * the shape stable no matter how the model feels about headings. */
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
        `جواب را فقط به صورت یک JSON معتبر و minified بده، بدون هیچ متن یا markdown اضافه‌ای، با دقیقاً این دو کلید:\n` +
        `{"summary":"حداکثر ۳ خط فارسی روان و مفهومی: این پروژه چیست و به چه دردی می‌خورد"},"hook":"یک جملهٔ کوتاه کوبندهٔ فارسی با قیاس، مثل: مثل Hugging Face — ولی ده برابر سبک‌تر"}`,
        { deadlineMs: h.budget(), tier: "smart", json: true, max_tokens: 700, temperature: 0.3, feature: "showcase" },
      ).catch(() => "");
      try {
        const m = /\{[\s\S]*\}/.exec(String(out ?? ""));
        const j: any = m ? JSON.parse(m[0]) : null;
        if (j) { summary = String(j.summary ?? "").trim(); hook = String(j.hook ?? "").trim(); }
      } catch { /* the fallback below is already a decent post */ }
      const clean = (x: string) => tgEscape(x.trim().replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")).replace(/&lt;(\/\/?b)&gt;/g, "<$1>");
      if (summary) summary = clean(summary);
      if (hook) hook = clean(hook);
      if (!summary) summary = tgEscape(String(repo.description ?? repo.full_name));
      if (!hook) hook = tgEscape(String(repo.full_name));
    }

    /* the post image is GitHub's own white banner — the OpenGraph card the
     * owner pointed at: repo name, description, stars, language, the maker's
     * avatar, all drawn by GitHub itself. The maker's own photos outrank it;
     * the avatar stays as the last-resort image. */
    const avatarRaw = String(repo.owner?.avatar_url ?? owner?.avatar_url ?? "");
    const avatar = avatarRaw ? (avatarRaw.includes("?") ? `${avatarRaw}&s=512` : `${avatarRaw}?s=512`) : "";

    return {
      ref,
      url: `https://github.com/${ref}`,
      full: tgEscape(String(repo.full_name)),
      userText: userText || undefined,
      photos,
      banner: `https://opengraph.githubassets.com/1/${ref}`,
      avatar,
      summary, hook,
      stack: tgEscape(String(repo.language ?? "—")),
      stars: Number(repo.stargazers_count ?? 0).toLocaleString("fa-IR"),
      forks: Number(repo.forks_count ?? 0).toLocaleString("fa-IR"),
      license: tgEscape(String(repo.license?.spdx_id ?? "—")),
      score,
      owner: owner ? {
        login: tgEscape(String(owner.login)),
        url: `https://github.com/${tgEscape(String(owner.login))}`,
        followers: Number(owner.followers ?? 0).toLocaleString("fa-IR"),
        repos: String(Number(owner.public_repos ?? 0)),
      } : null,
    };
  }

  /** Pure: the data half of the post — the score and the maker, as tables.
   *  With an intro it also carries the header and the lines (the shape used
   *  when no photo could be sent, or the maker's own text is the post). */
  renderTablesDoc(parts: PostParts, serial: number, fa: boolean, withIntro: boolean): string {
    const header = fa ? `🚀 معرفی پروژهٔ #${serial}` : `🚀 Showcase #${serial}`;
    if (parts.userText) {
      /* the maker's own words, nothing else — no tables, no score */
      return h1(header) + aside(`<b>${parts.full}</b>`) + p(tgEscape(parts.userText)) + hr() + footer(`🔗 ${parts.url}`);
    }
    const intro = withIntro
      ? h1(header) + aside(`<b>${parts.full}</b>${parts.hook ? ` — ${parts.hook}` : ""}`) + p(parts.summary)
      : "";
    return intro +
      table([
        [fa ? "فعالیت" : "Activity", `${parts.score.parts.activity}/30`],
        [fa ? "محبوبیت" : "Popularity", `${parts.score.parts.popularity}/30`],
        [fa ? "جامعه" : "Community", `${parts.score.parts.community}/20`],
        [fa ? "بلوغ" : "Maturity", `${parts.score.parts.maturity}/20`],
        [fa ? "کل" : "Total", `<b>${parts.score.total}/100 — ${parts.score.grade}</b>`],
      ], { caption: fa ? "🏅 نمرهٔ پروژه" : "🏅 Project score", header: false }) +
      (parts.owner ? table([
        ["👤", `<a href="${parts.owner.url}">${parts.owner.login}</a>`],
        [fa ? "فالوورها" : "Followers", parts.owner.followers],
        [fa ? "ریپوهای عمومی" : "Public repos", parts.owner.repos],
      ], { caption: fa ? "👤 سازندهٔ پروژه" : "👤 The maker", header: false }) : "") +
      hr() +
      footer(`🔗 ${parts.url}`);
  }

  /** Pure: the caption the photo carries — header, hook, a few lines, the
   *  link. The score stays in the table below, not here. */
  renderCaption(parts: PostParts, serial: number, fa: boolean): string {
    const head = fa ? `🚀 معرفی پروژهٔ #${serial} — <b>${parts.full}</b>` : `🚀 Showcase #${serial} — <b>${parts.full}</b>`;
    const hook = parts.hook && !parts.userText ? `\n<i>${parts.hook}</i>` : "";
    const body = parts.userText ? tgEscape(parts.userText).slice(0, 900) : parts.summary;
    return `${head}${hook}\n\n${body}\n\n🔗 ${parts.url}`;
  }

  /** GitHub's image bytes, fetched by us — an upload never depends on
   *  Telegram's downloader, which refused the card URL. The CDN throttles
   *  this endpoint now and then (429), so a throttled try gets a short
   *  backoff and another go before giving up. */
  async photoBytes(url: string): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 400 * attempt));
      const r = await fetch(url, { headers: { accept: "image/png,image/*", "user-agent": "GitHubLensUltra/1.0" } }).catch(() => null);
      if (r && r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
        if (buf.length > 1000) return buf;   // a real image, not an error page
      }
      /* only a throttle or a server hiccup is worth another try */
      if (!r || (r.status !== 429 && r.status !== 403 && r.status < 500)) return null;
    }
    return null;
  }

  /** Send the post photo the sure way: our own upload first, the URL form
   *  second, the avatar as the next candidate. Returns the message id. */
  async sendPostPhoto(h: H, chat: string | number, img: string, avatar: string, caption: string, opts: Record<string, unknown> = {}): Promise<number | null> {
    for (const candidate of [img, avatar].filter(Boolean)) {
      const bytes = await this.photoBytes(candidate);
      if (bytes) {
        const r: any = await h.tg.sendPhoto(chat as any, bytes as any, caption, opts as any).catch(() => null);
        const mid = r?.result?.message_id ?? null;
        if (mid) return mid;
      }
      const r2: any = await h.tg.sendPhoto(chat as any, candidate, caption, opts as any).catch(() => null);
      if (r2?.result?.message_id) return r2.result.message_id;
    }
    return null;
  }

  previewKb(fa: boolean, manual: boolean) {
    return kb(
      [{ text: "✅ " + (fa ? "منتشر کن — همین شکل عالیه" : "Publish — it looks great"), cb: "sc:go" }],
      [{ text: manual ? "✍️ " + (fa ? "ویرایش متن" : "Rewrite my text") : "🔁 " + (fa ? "از نو بساز" : "Build it again"), cb: "sc:redo" }],
      [{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }],
    );
  }

  /** The maker sees the exact post in his own chat, and decides there. */
  async showPreview(h: H, parts: PostParts) {
    const fa = h.loc === "fa";
    await setMode(h.session, "sc_preview", { parts });
    const serial = await this.peekSerial(h);
    const rows = this.previewKb(fa, !!parts.userText);
    if (parts.photos.length > 1) {
      await h.tg.call("sendMediaGroup", {
        chat_id: h.chatId,
        media: parts.photos.map((id, i) => ({ type: "photo", media: id, ...(i === 0 ? { caption: this.renderCaption(parts, serial, fa), parse_mode: "HTML" } : {}) })),
      }).catch(() => null);
      return h.reply(
        fa ? "👁 <b>پیش‌نمایش</b> — در چنل، بالای همین عکس‌ها یک کارت کوچک با دکمهٔ ⭐ ستارهٔ واقعی و کلیدها می‌نشیند. شکلش را پسندیدی؟" : "👁 Preview — a card with the ⭐ key rides above these photos in the channel.",
        rows, !!h.cbId,
      );
    }
    const cap = this.renderCaption(parts, serial, fa);
    if (parts.userText) {
      /* the maker's post is one message: his photo — or the banner — with
       * his words on it, keys under it */
      let mid: number | null = null;
      if (parts.photos[0]) {
        const r: any = await h.tg.sendPhoto(h.chatId, parts.photos[0], cap, { parse_mode: "HTML", reply_markup: rows } as any).catch(() => null);
        mid = r?.result?.message_id ?? null;
      } else if (parts.userText.length <= 900) {
        mid = await this.sendPostPhoto(h, h.chatId, parts.banner, parts.avatar, cap, { parse_mode: "HTML", reply_markup: rows });
      }
      if (mid) {
        return h.reply(fa ? "👁 <b>پیش‌نمایش</b> — زیر همین عکس، در چنل، دکمهٔ ⭐ ستارهٔ واقعی و کلیدها هم می‌نشیند." : "👁 Preview — the ⭐ key and the glass keys ride under this photo in the channel.", undefined, !!h.cbId);
      }
      /* tables ride through replyRich: reply() runs the plaintext converter,
       * which wraps a table in <p> — Telegram rejects that document */
      return h.replyRich(this.renderTablesDoc(parts, serial, fa, true), rows, !!h.cbId);
    }
    /* the AI post: the white GitHub banner with the pitch and the decision
     * keys on it, the tables right under it — the keys ride on the photo,
     * the one path that has never lost them */
    const mid1 = await this.sendPostPhoto(h, h.chatId, parts.banner, parts.avatar, cap, { parse_mode: "HTML", reply_markup: rows });
    return h.replyRich(this.renderTablesDoc(parts, serial, fa, !mid1), mid1 ? undefined : rows, !!h.cbId);
  }

  async previewAuto(h: H, ref: string) {
    const parts = await this.preparePost(h, ref);
    if (parts) await this.showPreview(h, parts);
  }

  async previewManual(h: H, ref: string, text: string, photos: string[]) {
    const parts = await this.preparePost(h, ref, text, photos);
    if (parts) await this.showPreview(h, parts);
  }

  /** A typed message while the preview waits — point back at the buttons. */
  async previewNudge(h: H) {
    const fa = h.loc === "fa";
    const m: any = await readMode(h.session).catch(() => null);
    return h.reply(
      fa ? "👁 پیش‌نمایش آماده است — ✅ منتشرش کن یا از دکمه‌های زیر انتخاب کن." : "👁 The preview is ready — publish it, or pick below.",
      this.previewKb(fa, !!m?.data?.parts?.userText),
      !!h.cbId,
    );
  }

  /** «از نو بساز» — the AI writes again; the maker rewrites his words. */
  async redoPreview(h: H) {
    const fa = h.loc === "fa";
    const m: any = await readMode(h.session).catch(() => null);
    const parts: PostParts | undefined = m?.data?.parts;
    if (!parts) return this.intro(h);
    if (parts.userText) {
      await setMode(h.session, "sc_text", { ref: parts.ref });
      return h.reply(
        fa ? "✍️ متن معرفی‌ات را از نو بنویس — بعدش دوباره پیش‌نمایش می‌گیری." : "✍️ Write your pitch again — a fresh preview follows.",
        kb([{ text: "❌ " + (fa ? "بی‌خیال" : "Never mind"), cb: "sc:cancel" }]),
        !!h.cbId,
      );
    }
    const fresh = await this.preparePost(h, parts.ref);
    if (fresh) await this.showPreview(h, fresh);
  }

  /** ✅ — the maker liked what he saw; it goes out this very second. */
  async publishPrepared(h: H) {
    const fa = h.loc === "fa";
    const m: any = await readMode(h.session).catch(() => null);
    const parts: PostParts | undefined = m?.data?.parts;
    if (!parts) return this.intro(h);
    await clearMode(h.session).catch(() => null);
    if ((await this.rateLimitLeftMs(h)) > 0) return this.intro(h);
    const target = await this.channelTarget(h);
    if (!target) return h.reply(fa ? "⚠️ کانالِ معرفی تنظیم نشده." : "⚠️ Showcase channel is not configured.");
    await h.loading(fa ? "📣 در حال انتشار…" : "Publishing…");

    const serial = await this.nextSerial(h);
    const botUser = botUsername(h.env);
    const starRow = this.starCb(parts.ref).length <= 64
      ? [[{ text: this.starLabel(0, fa), callback_data: this.starCb(parts.ref), style: "primary" }]]
      : [];
    const markup = { inline_keyboard: [...starRow, ...channelRepoKb(parts.ref, botUser).inline_keyboard] };
    const header = fa ? `🚀 معرفی پروژهٔ #${serial}` : `🚀 Showcase #${serial}`;
    let mid: number | null = null;

    if (parts.photos.length > 1) {
      /* a media group carries no buttons (Telegram's rule), so the keys ride
         on a compact card right before the photos */
      const card = await h.tg.sendRichMessage(target.send,
        h1(header) + aside(`<b>${parts.full}</b>`) + footer(`🔗 ${parts.url}`),
        { reply_markup: markup } as any,
      ).catch(() => null);
      mid = (card as any)?.result?.message_id ?? null;
      await h.tg.call("sendMediaGroup", {
        chat_id: target.send,
        media: parts.photos.map((id, i) => ({ type: "photo", media: id, ...(i === 0 ? { caption: this.renderCaption(parts, serial, fa), parse_mode: "HTML" } : {}) })),
      }).catch(() => null);
    } else if (parts.userText) {
      /* the maker's post is one message: his photo — or the banner — with
       * his words on it, keys under it; words too long for a caption ride
       * as a text post instead */
      const cap = this.renderCaption(parts, serial, fa);
      if (parts.photos[0]) {
        const r: any = await h.tg.sendPhoto(target.send as any, parts.photos[0], cap, { parse_mode: "HTML", reply_markup: markup } as any).catch(() => null);
        mid = r?.result?.message_id ?? null;
      } else if (parts.userText.length <= 900) {
        mid = await this.sendPostPhoto(h, target.send, parts.banner, parts.avatar, cap, { parse_mode: "HTML", reply_markup: markup });
      }
      if (!mid) {
        const rich = this.renderTablesDoc(parts, serial, fa, true);
        try {
          const r: any = await h.tg.sendRichMessage(target.send, rich, { reply_markup: markup } as any);
          mid = r?.result?.message_id ?? null;
        } catch {
          const r2: any = await h.tg.sendLong(target.send, richToLegacy(rich), { parse_mode: "HTML", reply_markup: markup as any }).catch(() => null);
          mid = r2?.result?.message_id ?? null;
        }
      }
    } else {
      /* the AI post: GitHub's white banner card with the pitch as its
       * caption, then the data half — score and maker tables — carrying the
       * star key and the glass keys right under it */
      const cap = this.renderCaption(parts, serial, fa);
      /* the ⭐ key and the glass keys ride under the banner photo itself —
       * a photo message has never lost its keyboard; the tables doc stays
       * clean and only inherits the keys when no photo could be sent */
      const mid1 = await this.sendPostPhoto(h, target.send, parts.banner, parts.avatar, cap, { parse_mode: "HTML", reply_markup: markup });
      const rich = this.renderTablesDoc(parts, serial, fa, !mid1);
      try {
        const r: any = await h.tg.sendRichMessage(target.send, rich, (mid1 ? {} : { reply_markup: markup }) as any);
        mid = (mid1 ?? r?.result?.message_id) ?? null;
      } catch {
        const r2: any = await h.tg.sendLong(target.send, richToLegacy(rich), { parse_mode: "HTML", ...(mid1 ? {} : { reply_markup: markup }) } as any).catch(() => null);
        mid = (mid1 ?? r2?.result?.message_id) ?? null;
      }
    }

    await h.store.event(h.u.id, "showcase", parts.ref, { serial, msgId: mid, channel: target.send, mode: parts.userText ? "custom" : "auto" }).catch(() => null);
    await (h.store as any).addXp?.(h.u.id, 30, "showcase").catch?.(() => null);

    const link = target.display.startsWith("@") && mid ? `\nhttps://t.me/${target.display.replace("@", "")}/${mid}` : "";
    return h.reply(
      fa
        ? `✅ <b>پروژهٔ تو معرفی شد!</b>\n\n🏅 پست شمارهٔ #${serial} — نمرهٔ ${parts.score.total}/100 ${parts.score.grade}\n${link}\n\n` +
          `همین حالا فورواردش کن تا بیشتر دیده شوی 😉 و هر ستاره‌ای که از چنل بخورد، خبرت می‌کنم ⭐`
        : `✅ <b>Published!</b> — post #${serial}, score ${parts.score.total}/100 ${parts.score.grade}${link}`,
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
      /* 401 the link rotted; 403 the token has no starring scope — the OAuth
       * flow asks for public_repo, so relinking fixes both the same way. */
      if (!quiet) await h.toast(fa ? "توکن گیت‌هابت ستاره‌دادن را باز نمی‌کند — یک بار دیگر /login بزن" : "Your GitHub token cannot star — /login once more");
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

  /** The serial a preview *would* carry — read without spending it. */
  async peekSerial(h: H): Promise<number> {
    const row: any = await h.env.DB.prepare(`SELECT value FROM flags WHERE key='showcase:serial'`).first().catch(() => null);
    return Number(row?.value ?? 0) + 1;
  }

  async nextSerial(h: H): Promise<number> {
    const row: any = await h.env.DB.prepare(`SELECT value FROM flags WHERE key='showcase:serial'`).first().catch(() => null);
    const n = Number(row?.value ?? 0) + 1;
    await h.env.DB.prepare(`INSERT OR REPLACE INTO flags (key, value, updated_at) VALUES (?,?,?)`)
      .bind("showcase:serial", String(n), Date.now()).run().catch(() => null);
    return n;
  }
}
