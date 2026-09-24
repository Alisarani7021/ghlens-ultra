import type { H } from "../core/handler";
import { setMode } from "../core/mode";
import { parseRepoRef } from "../core/repo-ref";
import { GithubRest } from "../github/rest";
import { RepoRag } from "../ai/vector";
import { aiDownNotice } from "../ai/brain";
import { hash } from "../ai/brain";
import { fmt, truncate } from "./cards";
import { code, i, pre, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * AI ASSISTANT — the conversational core.
 *
 *   • general open-source advisor (knows live GitHub data via tool-style prompts)
 *   • chat-with-repo (RAG over the README with citations)
 *   • AI dossier (structured, honest analysis with pros/cons/alternatives)
 *   • README → Persian translation, cached forever, format-preserving
 *   • code explainer, workflow generator, PR reviewer
 *   • voice note in → text → answer (Whisper). Audio only ever comes IN:
 *     every audio output was removed by owner instruction.
 *   • Persian-first: every answer respects the user's locale
 */
export class Assistant {
  async home(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `🤖 <b>${fa ? "دستیار هوش مصنوعی لنز" : "Lens AI assistant"}</b>\n\n` + (fa
        ? `می‌توانم:\n• پروژه مناسب برایت پیدا کنم («یک کتابخانه سبک برای صف در Go»)\n• هر مخزنی را تحلیل کنم و رقیب‌هایش را بگویم\n• با محتوای یک مخزن چت کنم و منبع بدم\n• README را فارسی کنم\n• ورک‌فلوی GitHub Actions بسازم\n• کد یا PR را بازبینی کنم\n\nفقط بنویس تا بلافاصله پاسخ دهم.`
        : `Ask anything about open source.`),
      kb(
        /* «چت با مخزن» deliberately lives only with a repository (repo card and
           deep scout) — in the AI menu it was a dead end that asked for a repo
           name. «🕘 ادامه گفت‌وگو» is gone too: the chat section keeps its own
           memory, so there is nothing to "resume". */
        [
          { text: "💬 " + (fa ? "گفت‌وگوی جدید" : "New chat"), cb: "a:new" },
        ],
        [
          { text: "📝 " + (fa ? "ترجمه README" : "Translate README"), cb: "ai:tr:ask" },
          { text: "🏗️ " + (fa ? "ساخت پروژه کامل" : "Text to App (ZIP)"), cb: "appgen:prompt" },
        ],
        [
          { text: "⚙️ " + (fa ? "ساخت ورک‌فلو" : "Build workflow"), cb: "a:workflow" },
          { text: "🗺️ " + (fa ? "معماری مخزن" : "Architecture"), cb: "arch:ask" },
        ],
        [
          { text: "🧑‍💻 " + (fa ? "توضیح کد" : "Explain code"), cb: "a:code" },
          { text: "🔍 " + (fa ? "بازبینی PR" : "Review PR"), cb: "a:review" },
        ],
        [
          { text: "🧹 " + (fa ? "پاک کردن حافظه" : "Clear memory"), cb: "a:clear" },
        ],

      ),
      !!h.cbId,
    );
  }

  /** Free-form question. Grounded with live GitHub data when the question smells like a repo hunt. */
  async ask(h: H, question: string, opts: { voiceReply?: boolean } = {}) {
    const fa = h.loc === "fa";
    const chatId = `u${h.u.id}`;
    await h.store.ensureChat(chatId, h.u.id);
    await h.store.addMessage(chatId, "user", question);
    await h.loading(fa ? "🧠 دارم فکر می‌کنم…" : "🧠 thinking…");

    /* 1. Does the question need live data? Ask a cheap classifier, then fetch.
       Both calls come out of the *same* update budget: a classifier given its own
       full deadline plus an answer given another can exceed the platform's window
       between them, and then neither is delivered. The classifier is a binary
       judgement — a few seconds is plenty, and the rest belongs to the answer the
       user is actually waiting for. */
    const plan = await h.ai.json<{ needs_github: boolean; query: string | null }>(
      `User question: "${question}"\nDoes answering this well require looking up repositories on GitHub right now? Return {"needs_github":true/false,"query":"github search query or null"}`,
      { tier: "fast", max_tokens: 120, cacheKey: `cls:${hash(question)}`, cacheTtl: 86400, deadlineMs: Math.min(5_000, h.budget()) },
    );

    let grounding = "";
    if (plan?.needs_github && plan.query) {
      const res = await h.gh().searchRepos(plan.query, "stars", "desc", 8).catch(() => null);
      if (res?.items?.length) {
        grounding =
          `\n\nLIVE GITHUB DATA (use only these, do not invent repos):\n` +
          res.items.map((r: any, i2: number) =>
            `${i2 + 1}. ${r.full_name} — ⭐${r.stargazers_count} — ${r.language ?? "?"} — ${r.description ?? ""} — ${r.html_url}`).join("\n");
      }
    }

    const history = (await h.store.history(chatId, 6)).results?.reverse() ?? [];
    const convo = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n").slice(-3000);

    const answer = await h.ai.chat(
      `You are GitHub Lens Ultra's assistant: a senior open-source expert who answers in ${fa ? "Persian (فارسی)" : "English"}.\n` +
        `Be concrete, technical and honest. Prefer real, clickable GitHub projects with star counts. ` +
        `Use short paragraphs and bullet lists. If you are unsure, say what you would check. Never invent repository names.\n` +
        (convo ? `\nConversation so far:\n${convo}\n` : "") +
        `\nUser: ${question}${grounding}`,
      // 900 rather than 1400: a long answer is worthless if the platform's time
      // for this update runs out before the model finishes writing it.
      // whatever is left of this update, not a fresh full deadline
      { tier: "smart", max_tokens: 900, temperature: 0.5, userId: h.u.id, feature: "assistant", deadlineMs: h.budget() },
    );

    await h.store.addMessage(chatId, "assistant", answer || "");
    await h.store.bumpLeaderboard(h.u.id, "queries");
    await h.store.addXp(h.u.id, 1, "ai_ask");



    /* Models answer in markdown and Telegram renders HTML, so `**bold**` and
       `<url>` arrived as literal punctuation — the single most visible way an AI
       answer looks broken. The hub already had the converter (it was written for
       changelogs); this is the same function, so both paths escape identically. */
    const keys = kb(
      [
        { text: "🔁 " + (fa ? "بپرس ادامه‌اش" : "Follow up"), cb: "a:cont" },
      ],
      [
        { text: "🔎 " + (fa ? "جست‌وجوی این جمله" : "Search this"), cb: `n:q:${encodeURIComponent(question).replace(/%/g, "_").slice(0, 36)}` },
        { text: "🧹 " + (fa ? "پاک کردن حافظه" : "Clear memory"), cb: "a:clear" },
      ],
    );

    /* The answer is a markdown *document* — headings, lists, code, links — and it
       is now sent as one. Flattening it into bold-and-newlines is what made a good
       answer read like a log dump; `sendRich` degrades to the legacy text by
       itself, so the same string serves both paths. */
    if (!answer) return h.reply(await aiDownNotice(h.env, h.loc), keys, !!h.cbId);
    const { markdownToRichHtml, richDoc, inlineMd } = await import("../hub/richdoc");
    await h.replyRich(
      richDoc({
        meta: `🧠 <b>${fa ? "پاسخ دستیار" : "Assistant"}</b>${question ? ` — <i>${inlineMd(question.slice(0, 90))}</i>` : ""}`,
        body: markdownToRichHtml(answer, { headingBase: 2, maxChars: 26000 }),
      }),
      keys,
      !!h.cbId,
    );
  }

  /** Chat with a repository: RAG over README + docs, with citations. */
  async repoChat(h: H, input: string, question?: string) {
    const fa = h.loc === "fa";
    const full = parseRepoRef(input) ?? input.trim();
    if (!question) {
      /* Reached without a repository (an old button, or /repochat with no
         argument): ask for the repo and keep the section armed, instead of
         showing a chat that answers from an empty target. */
      if (!parseRepoRef(input)) {
        await setMode(h.session, "repochat", { full: "" });
        return h.reply(
          fa ? `🧠 <b>چت با مخزن</b>\n\nنام مخزن را بفرست — <code>owner/repo</code> یا لینک گیت‌هاب.\n\n<i>مثال: <code>python-telegram-bot/python-telegram-bot</code></i>`
             : `🧠 <b>Chat with a repo</b>\n\nSend owner/repo or a GitHub link.`,
          kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
          !!h.cbId,
        );
      }
      await setMode(h.session, "repochat", { full });   // stays until they leave the chat
      return h.reply(
        `🧠 <b>${fa ? "چت با مخزن" : "Chat with repo"}</b>\n\n` + (fa
          ? `مخزن هدف: <code>${tgEscape(full)}</code>\n\nهر سؤالی بپرس — از داخل README و مستندات جواب می‌دهم و منبع می‌دهم.\nمثال:\n• «چطور نصبش کنم؟»\n• «از کدام دیتابیس پشتیبانی می‌کند؟»\n• «آیا احراز هویت دارد؟»`
          : `Target: <code>${tgEscape(full)}</code>. Ask anything about it (answered from README/docs with citations).`),
        kb(
          [
            { text: "📝 " + (fa ? "خلاصه فارسی" : "Persian summary"), cb: `ai:repo:${full}` },
            { text: "📥 " + (fa ? "دانلود" : "Download"), cb: `d:repo:${full}` },
          ],
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
        ),
        !!h.cbId,
      );
    }

    await h.loading(fa ? "📚 در حال خواندن مستندات…" : "📚 reading docs…");
    const gh = new GithubRest(h.env);
    const readmeRaw = await gh.readme(full, 3600).catch(() => null);
    if (!readmeRaw?.content) return h.reply(fa ? "❌ README این مخزن خوانده نشد." : "❌ README unreadable.", kb([{ text: "◀️", cb: `s:card:${full}` }]), true);
    const readme = decodeB64(readmeRaw.content);

    // pull extra docs when they exist (docs/, CONTRIBUTING, docs/*.md)
    const extra = await this.docsCorpus(h, full);
    const corpus = readme + (extra ? `\n\n# ADDITIONAL DOCS\n${extra}` : "");

    const rag = new RepoRag(h.env, h.ai);
    const { answer, sources, mode } = await rag.ask(full, question, corpus, h.loc);

    await h.store.addXp(h.u.id, 2, "repochat");
    /* Filter out corrupted/binary/mojibake sources */
    const validSources = sources
      .map(s => {
        const cleanExcerpt = s.excerpt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
        return { ...s, excerpt: cleanExcerpt };
      })
      .filter(s => s.excerpt.length > 10 && !/^[\s\W_]+$/.test(s.excerpt))
      .slice(0, 4);

    /* Rich: the passages become a small bordered table instead of three escaped
       code lines, and when the model was unavailable the extractive note is said
       in the document itself rather than in a separate header paragraph. */
    const { markdownToRichHtml, richDoc, inlineMd } = await import("../hub/richdoc");
    const srcRows = validSources.length
      ? `<table bordered compact><tr><th>#</th><th>${fa ? "بخش مستندات" : "passage"}</th></tr>` +
        validSources.map((s) => `<tr><td>[${s.n}]</td><td>${inlineMd(truncate(s.excerpt.replace(/\s+/g, " "), 110))}</td></tr>`).join("") +
        `</table>`
      : "";
    const doc = richDoc({
      title: `🧠 ${full}`,
      meta: `❓ <i>${inlineMd(truncate(question, 170))}</i>`,
      body:
        (mode === "extractive"
          ? `<aside>${fa ? "هوش مصنوعی در دسترس نبود؛ این‌ها مرتبط‌ترین بخش‌های مستندات خود مخزن‌اند (عین متن)." : "AI unavailable — these are the repo's own most relevant passages."}</aside>`
          : "") +
        markdownToRichHtml(answer, { headingBase: 2, maxChars: 22000 }) +
        (srcRows ? `\n<p><b>📚 ${fa ? "منابع" : "sources"}</b></p>\n${srcRows}` : ""),
    });
    await h.replyRich(
      doc,
      kb(
        [
          { text: "🔁 " + (fa ? "سؤال بعدی" : "Next question"), cb: `a:repochat:${full}` },
          { text: "📝 " + (fa ? "خلاصه کامل" : "Full dossier"), cb: `ai:repo:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "کارت مخزن" : "Repo card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "rag", full);
  }

  private async docsCorpus(h: H, full: string): Promise<string> {
    const gh = new GithubRest(h.env);
    const listing = await gh.contents(full, "docs", 3600).catch(() => null);
    let corpus = "";
    if (Array.isArray(listing)) {
      const md = listing.filter((f: any) => /\.(md|mdx|txt)$/i.test(f.name)).slice(0, 4);
      for (const f of md) {
        const raw = await gh.fileRaw(full, f.path).catch(() => null);
        if (raw?.content) corpus += `\n\n## ${f.path}\n${decodeB64(raw.content).slice(0, 9000)}`;
      }
    }
    const extras = ["CONTRIBUTING.md", "SECURITY.md", "ARCHITECTURE.md"];
    for (const p of extras) {
      if (corpus.length > 25000) break;
      const raw = await gh.fileRaw(full, p).catch(() => null);
      if (raw?.content) corpus += `\n\n## ${p}\n${decodeB64(raw.content).slice(0, 6000)}`;
    }
    return corpus;
  }

  /** AI dossier: structured, cached, honest. */
  async dossier(h: H, full: string) {
    const fa = h.loc === "fa";
    // with the caller's token when they linked one: the anonymous bucket is a
    // shared 60 requests/hour and a busy bot drains it within minutes, which is
    // how this button answered «پیدا نشد» for a repository GitHub was serving.
    const meta = await h.store.repoFresh(full, 3600, h.userToken);
    if (!meta) {
      const why = await h.gh().rateWhy(full).catch(() => null);
      return h.reply(
        `❌ <b>${tgEscape(full)}</b>\n\n` +
          `<blockquote>${fa ? "داده‌های این مخزن از گیت‌هاب خوانده نشد." : "GitHub did not return this repository."}</blockquote>` +
          (why ? `\n<code>${tgEscape(why.slice(0, 200))}</code>` : "") +
          `\n\n<i>${fa ? "بدون توکن گیت‌هاب، سهمیهٔ مشترک ۶۰ درخواست در ساعت است. با «🔗 اتصال گیت‌هاب» در پروفایل، سهمیهٔ خودت (۵۰۰۰ در ساعت) استفاده می‌شود و پرایوت‌ها هم باز می‌شوند." : "Link GitHub for a private 5000/h quota."}</i>`,
        kb(
          [{ text: "🔗 " + (fa ? "سهمیهٔ خودم را وصل کن" : "Use my own quota"), cb: "me:link" }],
          [{ text: "🔁 " + (fa ? "دوباره" : "Retry"), cb: `ai:repo:${full}` }],
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }],
        ),
        !!h.cbId,
      );
    }

    const cachedSummary = meta.ai_summary_fa;
    const gql = new GithubRest(h.env);
    const commits = await gql.commits(full, 10).catch(() => []);
    const analysis = cachedSummary
      ? null
      : await h.ai.analyzeRepo({
          full_name: meta.full_name,
          description: meta.description,
          stars: meta.stars,
          forks: meta.forks,
          issues: meta.open_issues,
          prs: 0,
          language: meta.language,
          languages: safeParseArr(meta.languages),
          topics: safeParseArr(meta.topics),
          license: meta.license,
          archived: !!meta.archived,
          pushed_at: meta.pushed_at,
          created_at: meta.created_at,
          contributors: 0,
          community_health: 0,
          redFlags: [],
          raw: { commitHistory: { target: { history: { nodes: commits.map((c: any) => ({ messageHeadline: c.commit?.message?.split("\n")[0] })) } } } },
        });

    const a = analysis ?? null;

    if (a) {
      await h.env.DB.prepare(`UPDATE repos SET ai_summary_fa=? WHERE full_name=?`).bind(a.one_liner ?? "", full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    /* The analysis is structured data, so the rich screen is built from the
       structure itself — a document with sections and lists, like the README
       reader and the architecture screen. The previous version passed a
       ready-made HTML string through the *markdown* converter, which escaped
       every tag: the screen rendered literal `<b>` characters and none of the
       document shapes. */
    const { richDoc, inlineMd: inline } = await import("../hub/richdoc");
    const { p, h3, ul, aside, table, footer } = await import("../tg/rich");
    const li = (x: string) => tgEscape(String(x ?? ""));
    const body = a
      ? [
          a.one_liner ? aside(tgEscape(a.one_liner), fa ? "در یک خط" : "in one line") : "",
          a.what ? h3(`📖 ${fa ? "چیست" : "What it is"}`) + p(tgEscape(a.what)) : "",
          a.who_for ? h3(`👤 ${fa ? "برای کیست" : "Who it is for"}`) + p(tgEscape(a.who_for)) : "",
          (a.pros ?? []).length ? h3(`✅ ${fa ? "نقاط قوت" : "Pros"}`) + ul((a.pros ?? []).map(li)) : "",
          (a.cons ?? []).length ? h3(`⚠️ ${fa ? "نقاط ضعف (صادقانه)" : "Cons (honest)"}`) + ul((a.cons ?? []).map(li)) : "",
          (a.alternatives ?? []).length ? h3(`🔀 ${fa ? "جایگزین‌ها" : "Alternatives"}`) + ul((a.alternatives ?? []).map(li)) : "",
          table([
            [fa ? "ارزیابی" : "assessment", fa ? "نتیجه" : "verdict"],
            [`📚 ${fa ? "شیب یادگیری" : "Learning curve"}`, tgEscape(a.learning_curve ?? "—")],
            [`🏭 ${fa ? "آمادهٔ تولید" : "Production ready"}`, `<b>${tgEscape(a.production_ready ?? "—")}</b>`],
            [`🛡 ${fa ? "نکتهٔ امنیتی" : "Security note"}`, tgEscape(a.security_note ?? "—")],
          ]),
          (a.tags_fa ?? []).length ? p(`🏷 ${(a.tags_fa ?? []).map((t: string) => code("#" + t)).join(" ")}`) : "",
        ].filter(Boolean).join("\n")
      : [
          p(meta.description ? tgEscape(meta.description) : (fa ? "بدون توضیح." : "No description.")),
          p(`⭐ <b>${fmt(meta.stars)}</b> · 🍴 <b>${fmt(meta.forks)}</b> · 🐞 ${fmt(meta.open_issues)} · 🧩 <code>${tgEscape(meta.language ?? "—")}</code>`),
          aside(fa ? "این مخزن از قبل تحلیل شده بود — تحلیل تازه با دکمهٔ «تحلیل هوش مصنوعی» ساخته می‌شود." : "cached summary", fa ? "کش" : "cache"),
        ].join("\n");
    await h.replyRich(
      richDoc({
        title: `🎯 ${full}`,
        meta: `⭐ <b>${fmt(meta.stars ?? 0)}</b> · 🍴 <b>${fmt(meta.forks ?? 0)}</b> · 🧩 <code>${inline(meta.language ?? "—")}</code> · <i>${fa ? "از دادهٔ زندهٔ گیت‌هاب" : "live GitHub data"}</i>`,
        body,
        footer: footer(fa ? "تولیدشده با Workers AI بر اساس دادهٔ زندهٔ گیت‌هاب" : "Generated by Workers AI from live GitHub data"),
      }),
      kb(
        [
          { text: "🛰 " + (fa ? "کاوش عمیق" : "Deep scout"), cb: `s:go:${full}` },
          { text: "🧠 " + (fa ? "چت با مخزن" : "Chat with repo"), cb: `a:repochat:${full}` },
        ],
        [
          { text: "📝 " + (fa ? "ترجمه README" : "Translate README"), cb: `ai:tr:${full}` },
          { text: "📥 " + (fa ? "دانلود" : "Download"), cb: `d:repo:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "dossier", full);
  }

  /** README → Persian (or any locale), with smart truncation + caching. */
  async translateReadme(h: H, input: string) {
    const fa = h.loc === "fa";
    /* Accept whatever the user pastes. A full github.com URL used to be handed
       to the API as if it were `owner/repo`, so the readme lookup 404'd and the
       user saw «❌ README پیدا نشد» for a repository that obviously exists. */
    const full = parseRepoRef(input) ?? "";
    if (!full) return this.translatePick(h, input);
    await h.loading(fa ? "🌍 در حال ترجمه README…" : "🌍 translating README…");
    const gh = new GithubRest(h.env);
    const raw = await gh.readme(full, 3600).catch(() => null);
    if (!raw?.content) return h.reply(
      (fa ? `❌ برای <code>${tgEscape(full)}</code> فایل README پیدا نشد.\n\n` +
            `ممکن است مخزن خالی باشد یا نامش را اشتباه نوشته باشی.`
          : `❌ No README in ${tgEscape(full)}.`),
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]]),
      true,
    );
    /* One page per request, deliberately.
     *
     * This screen used to decode the whole README, split it into three 14 000
     * character parts and translate all three before rendering — and died with
     * «error code: 1102» (the worker's CPU limit) on any README worth reading.
     * The work now scales with the page being shown, not with the file: page N's
     * byte range is decoded, translated and cached on its own and the rest waits
     * until the reader asks. It also makes «ادامه» mean something on long
     * READMEs, which stopped at the second page because only three parts existed. */
    const total = readmePages(raw.size ?? 0, raw.content.length);
    const cacheKey = readmePageKey(full, h.loc, 0);
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      // keep the structure: translate in two passes for very long READMEs
      // parts go out in parallel through *different* pooled keys, so several
      // donated keys genuinely share one long translation
      const parts = [readmeSlice(raw.content, 0, total)];
      const out = await h.ai.translateMany(parts, h.loc, "README");
      translated = out.join("\n\n");
      // never cache an empty translation — that silently poisons the feature
      if (translated) {
        await h.env.STATE.put(cacheKey, translated, { expirationTtl: 2592000 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    }

    if (!translated) {
      const notice = await aiDownNotice(h.env, h.loc);
      return h.reply(
        `${notice}\n\n📄 ${fa ? "متن اصلی README" : "original README"}: <a href="${raw.html_url}">GitHub</a>\n` +
          `<i>${fa ? "بعد از برگشتن سهمیه، همین دکمه ترجمهٔ کامل را می‌دهد." : "the same button will translate once the quota is back."}</i>`,
        kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]), true,
      );
    }

    await h.store.event(h.u.id, "translate", full);
    await h.store.addXp(h.u.id, 1, "translate");

    const footer =
      `\n\n────────────\n` +
      `📄 ${fa ? "منبع" : "source"}: <a href="${raw.html_url}">README اصلی</a> · ` +
      `🤖 ${fa ? "ترجمه با Workers AI" : "translated by Workers AI"} · ` +
      `💾 ${fa ? "ذخیره‌شده (بار بعد فوری)" : "cached"}`;

    const MD = await import("../hub/richdoc");
    /* already the size of a page: one render, and no 24 000-character paginate
       pass over a document the reader has not asked for */
    const pages = MD.paginateMd(translated, MD.README_PAGE_CHARS, 1);
    await h.replyRich(await readmePage(full, pages[0], 0, total, raw.html_url, fa), kb(
      total > 1 ? [{ text: (fa ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:1` }] : [],
      [
        { text: "🇬🇧 English", cb: `ai:tre:${full}:en` },
        { text: "🖨 PDF", cb: `ai:trpdf:${full}` },
      ],
      [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
    ), !!h.cbId);
    await h.session.set(`tr:${full}`, translated);
  }

  /**
   * Page N of a README translation, translated on demand and cached per page.
   *
   * Pages are cheap to talk about (a byte range) and expensive to produce, so
   * each is produced the first time it is read and kept for a month. A reader
   * who never leaves page one pays for page one — which is what makes a 100 KB
   * README readable on a 10 ms CPU budget.
   */
  async readmeMore(h: H, full: string, page: number) {
    const fa = h.loc === "fa";
    const gh = new GithubRest(h.env);
    const raw = await gh.readme(full, 3600).catch(() => null);
    if (!raw?.content) return h.toast(fa ? "دوباره امتحان کن" : "try again", true);
    const total = readmePages(raw.size ?? 0, raw.content.length);
    const idx = Math.max(0, Math.min(page, total - 1));
    await h.loading(fa ? `🌍 صفحهٔ ${idx + 1} را ترجمه می‌کنم…` : `🌍 translating page ${idx + 1}…`);

    const cacheKey = readmePageKey(full, h.loc, idx);
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      const out = await h.ai.translateMany([readmeSlice(raw.content, idx, total)], h.loc, "README");
      translated = out.join("\n\n");
      if (translated) {
        await h.env.STATE.put(cacheKey, translated, { expirationTtl: 2592000 }).catch(() => null);
      }
    }
    if (!translated) {
      const notice = await aiDownNotice(h.env, h.loc);
      return h.reply(`${notice}\n\n📄 <a href="${raw.html_url}">README</a>`, kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]), true);
    }

    const MD = await import("../hub/richdoc");
    const pages = MD.paginateMd(translated, MD.README_PAGE_CHARS, 1);
    const nav: any[] = [];
    if (idx > 0) nav.push({ text: "⬅️ " + (fa ? "قبلی" : "Prev"), cb: `ai:trmore:${full}:${idx - 1}` });
    if (idx + 1 < total) nav.push({ text: (fa ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:${idx + 1}` });
    return h.replyRich(
      await readmePage(full, pages[0], idx, total, raw.html_url, fa),
      kb(nav, [
        { text: "🇬🇧 English", cb: `ai:tre:${full}:en` },
        { text: "🖨 PDF", cb: `ai:trpdf:${full}` },
      ], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]),
      true,
    );
  }

  /**
   * «این را ترجمه کن» for something that is not a repo reference.
   *
   * Typing a project *name* (or a half-remembered URL) used to dead-end in
   * «README پیدا نشد». Instead: search GitHub with the same words and offer the
   * top hits as one-tap translations.
   */
  async translatePick(h: H, query: string) {
    const fa = h.loc === "fa";
    const q = String(query ?? "").trim().slice(0, 120);
    if (!q) return h.reply(fa ? "📝 نام مخزن را بفرست." : "Send a repo.", kb([[{ text: "◀️", cb: "a:home" }]]), true);
    await h.loading(fa ? "🔎 دنبال مخزنش می‌گردم…" : "🔎 looking for that repo…");
    const res = await h.gh().searchRepos(q.replace(/[^\w./-]+/g, " ").trim() || q, "stars", "desc", 5).catch(() => null);
    const items = (res?.items ?? []).slice(0, 5);
    if (!items.length) {
      return h.reply(
        (fa ? `❌ مخزنی برای «<i>${tgEscape(q)}</i>» پیدا نشد.\n\n`
              + `لینک گیت‌هاب یا <code>owner/repo</code> را بفرست.`
            : `❌ Nothing found for that. Send a link or owner/repo.`),
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]), true,
      );
    }
    await h.reply(
      (fa ? `📝 <b>کدام را ترجمه کنم؟</b>\n\n<i>ورودی تو مخزن نبود، پس با همین کلمات جست‌وجو کردم:</i>`
          : `📝 Which one should I translate?`),
      kb(
        ...items.map((r: any) => [{ text: `📄 ${r.full_name} ⭐${fmt(r.stargazers_count ?? 0)}`, cb: `ai:tr:${r.full_name}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Workflow generator */
  async workflow(h: H, description?: string) {
    const fa = h.loc === "fa";
    if (!description) {
      await setMode(h.session, "wf");
      return h.reply(
        `⚙️ <b>GitHub Actions</b>\n\n${fa ? "توضیح بده چه ورک‌فلویی می‌خواهی:\nمثال: «CI برای نود با تست و کش روی هر PR»" : "Describe the workflow you need."}`,
        kb([
          { text: "🧪 CI Node + tests", cb: "a:wf:ci node with tests and cache on pull_request" },
          { text: "🐍 CI Python", cb: "a:wf:python ci running pytest with coverage on push" },
        ], [
          { text: "🚀 Release on tag", cb: "a:wf:build and publish binaries on tag push with matrix" },
          { text: "🐳 Docker publish", cb: "a:wf:build multi-arch docker image and push to ghcr on main" },
        ], [
          { text: "🔐 CodeQL", cb: "a:wf:codeql security scan weekly" },
          { text: "📦 npm publish", cb: "a:wf:publish npm package on release with provenance" },
        ], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]),
        !!h.cbId,
      );
    }
    await h.loading(fa ? "⚙️ در حال ساخت ورک‌فلو…" : "⚙️ building workflow…");
    const yaml = await h.ai.workflow(description);
    if (!yaml) {
      return h.reply(
        (await aiDownNotice(h.env, h.loc)) + "\n\n" +
          (fa ? "تا آن موقع می‌توانی از قالب‌های آماده استفاده کنی:" : "Mean time, use a ready template:"),
        kb([[{ text: "▶️ " + (fa ? "ورک‌فلوی نمونه CI" : "Sample CI"), cb: "dvu:gitignore" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:workflow" }]]),
        true,
      );
    }
    await h.reply(
      pre("yaml", yaml.slice(0, 3400)) +
        `\n\n📁 ${fa ? "مسیر پیشنهادی" : "suggested path"}: <code>.github/workflows/${guessName(description)}.yml</code>`,
      kb(
        [
          { text: "🔁 " + (fa ? "بازسازی" : "Regenerate"), cb: `a:wf:${description.slice(0, 120)}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:workflow" }],
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "workflow_gen", description.slice(0, 60));
  }

  async code(h: H, snippet?: string) {
    const fa = h.loc === "fa";
    if (!snippet) {
      await setMode(h.session, "code");
      return h.reply(
        `🧑‍💻 <b>${fa ? "توضیح کد" : "Code explainer"}</b>\n\n${fa ? "کد را بفرست (در یک پیام یا به‌صورت بلوک کد) تا توضیح بدهم: هدف، جریان، نکات ظریف، پیچیدگی و دو پیشنهاد بهبود." : "Send code and I'll explain it."}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
      );
    }
    await h.loading(fa ? "🧠 در حال خواندن کد…" : "🧠 reading…");
    const out = await h.ai.explainCode(snippet, h.loc);
    await h.reply(
      (out || (await aiDownNotice(h.env, h.loc))).slice(0, 3800),
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }], [{ text: "🧪 " + (fa ? "کد دیگر بده" : "Explain another"), cb: "a:code" }]]),
      !!h.cbId,
    );
  }

  async review(h: H, target?: string) {
    const fa = h.loc === "fa";
    if (!target) {
      await setMode(h.session, "review");
      return h.reply(
        `🔍 <b>${fa ? "بازبینی PR" : "PR review"}</b>\n\n${fa ? "فرمت: <code>/review owner/repo#123</code>\nمن دیف را می‌گیرم و مثل یک مهندس ارشد بازبینی می‌کنم." : "Format: <code>/review owner/repo#123</code>"}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
      );
    }
    const m = target.match(/^([\w.\-]+\/[\w.\-]+)(?:#|!)(\d+)$/);
    if (!m) return h.reply(fa ? "❌ قالب درست نیست. مثال: `owner/repo#12`" : "❌ bad format", kb([{ text: "◀️", cb: "a:home" }]), true);
    await h.loading(fa ? "🔍 در حال خواندن دیف…" : "🔍 fetching diff…");
    const diffRes = await fetch(`https://api.github.com/repos/${m[1]}/pulls/${m[2]}`, {
      // the user's own token when linked: private repos and a 5k/h limit
      headers: { accept: "application/vnd.github.v3.diff", authorization: `Bearer ${h.userToken ?? h.env.GITHUB_TOKEN}`, "user-agent": "GitHubLensUltra" },
    }).catch(() => null);
    if (!diffRes?.ok) return h.reply(fa ? "❌ دیف دریافت نشد." : "❌ diff unavailable", kb([{ text: "◀️", cb: "a:home" }]), true);
    const diff = (await diffRes.text()).slice(0, 14000);
    const out = await h.ai.reviewPR(diff, h.loc);
    if (!out) {
      return h.reply(
        (await aiDownNotice(h.env, h.loc)) + "\n\n" +
          `📏 ${fa ? "اندازهٔ دیف" : "diff size"}: <b>${diff.split("\n").length}</b> ${fa ? "خط" : "lines"}`,
        kb([[{ text: "🌐 " + (fa ? "خودم می‌خوانم" : "Read it myself"), url: `https://github.com/${m[1]}/pull/${m[2]}` }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
        true,
      );
    }
    await h.reply(
      `🔍 <b>${tgEscape(m[1])}#${m[2]}</b>\n\n${out.slice(0, 3600)}`,
      kb(
        [{ text: "🌐 " + (fa ? "باز کردن PR" : "Open PR"), url: `https://github.com/${m[1]}/pull/${m[2]}` }],
        [{ text: "🔁 " + (fa ? "PR دیگر" : "Another PR"), cb: "a:review" }],
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "pr_review", `${m[1]}#${m[2]}`);
  }

  /** Voice message → Whisper → same pipelines as text. */
  async voice(h: H, fileId: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🎧 در حال شنیدن…" : "🎧 listening…");
    const file = await h.tg.call<{ file_path: string }>("getFile", { file_id: fileId });
    if (!file.ok) return h.reply(fa ? "❌ صدا دریافت نشد." : "❌ audio unavailable");
    const buf = await fetch(`https://api.telegram.org/file/bot${h.env.BOT_TOKEN}/${(file as any).result.file_path}`).then((r) => r.arrayBuffer()).catch(() => null);
    if (!buf) return h.reply(fa ? "❌ دانلود صدا ناموفق." : "❌ download failed");
    const text = await h.ai.transcribe(buf, h.loc);
    if (!text) return h.reply(fa ? "🤷 چیزی نفهمیدم، دوباره بفرست." : "🤷 couldn't transcribe");
    await h.reply(`🎧 <b>${fa ? "متن صدا" : "Voice transcript"}</b>:
<i>${tgEscape(text)}</i>`);
    return this.ask(h, text);
  }
}

// helpers
/**
 * One page of a translated README, as a rich document.
 *
 * Module scope on purpose: the first page, the «ادامه» button and the PDF export
 * all render through it, so page N of the pager and page N of the document are
 * the same text and the printout matches the chat.
 */
export async function readmePage(
  full: string, markdown: string, index: number, total: number, sourceUrl?: string, fa = true,
): Promise<string> {
  const { markdownToRichHtml, richDoc } = await import("../hub/richdoc");
  return richDoc({
    title: `📄 ${full}`,
    meta:
      `${total > 1 ? `<i>${index + 1}/${total}</i> · ` : ""}` +
      `🌍 ${sourceUrl ? `<a href="${sourceUrl}">README ${fa ? "اصلی" : "original"}</a>` : "README"} · ` +
      `🤖 ${fa ? "ترجمه با Workers AI" : "translated by Workers AI"}`,
    body: markdownToRichHtml(markdown, { headingBase: 2, maxChars: 11500 }),
  });
}

export function decodeB64(s: string): string {
  try {
    const bin = atob(s.replace(/\s/g, ""));
    /* Indexed loop, not Uint8Array.from(bin, cb): the callback version spends
       ~1.9 ms on 18 KB where this spends 0.09 ms, and this runner is on the
       README / source / PDF / upload paths of a worker with a 10 ms CPU budget. */
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try { return atob(s.replace(/\s/g, "")); } catch { return ""; }
  }
}

/**
 * Decode one byte range of a base64 document.
 *
 * A README arrives base64-encoded as a whole; decoding all of it to show page
 * one is what put this screen over the CPU limit. Base64 maps every 3 bytes to
 * 4 characters, so a byte range translates to an exact character range when it
 * is aligned to those groups — and a cut that lands mid-character is trimmed by
 * the replacement character the decoder leaves behind.
 */
export function decodeB64Range(b64: string, fromByte: number, toByte: number): string {
  const g0 = Math.floor(Math.max(0, fromByte) / 3) * 4;
  const g1 = Math.ceil(Math.max(0, toByte) / 3) * 4;
  let text = decodeB64(b64.slice(g0, g1));
  // a range boundary can split a multi-byte character: drop the stub
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return text;
}
/** How many pages a README of this size has. The byte size arrives with the
    API response, so the count is free — no need to decode anything to know it. */
export const README_PAGE_BYTES = 11000;
export function readmePages(sizeBytes: number, b64Len: number): number {
  const bytes = sizeBytes > 0 ? sizeBytes : Math.floor(b64Len * 0.75);
  return Math.max(1, Math.min(9, Math.ceil(bytes / README_PAGE_BYTES)));
}
export function readmePageKey(full: string, loc: string, page: number): string {
  // v2: pages cached while the stub bug was live are not translations at all
  return `trlp2:${full}:${loc}:${page}`;
}
/** The markdown for one page — one decode, one page's worth of work. */
export function readmeSlice(b64: string, page: number, total: number): string {
  const per = Math.ceil((Math.min(9, Math.max(1, total)) * README_PAGE_BYTES) / Math.max(1, total));
  return decodeB64Range(b64, page * per, (page + 1) * per);
}

function splitMd(md: string, size: number): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  let cur = "";
  let inCode = false;
  for (const l of lines) {
    if (l.trim().startsWith("```")) inCode = !inCode;
    cur += l + "\n";
    if (!inCode && cur.length >= size) { out.push(cur); cur = ""; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function chunkMd(md: string, size: number) { return splitMd(md, size).slice(0, 6); }
function safeParseArr(s: string | null | undefined): any[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function guessName(desc: string) {
  const d = desc.toLowerCase();
  if (/python|pytest/.test(d)) return "ci";
  if (/docker/.test(d)) return "docker";
  if (/release|publish|npm/.test(d)) return "release";
  if (/codeql|security/.test(d)) return "codeql";
  return "ci";
}
