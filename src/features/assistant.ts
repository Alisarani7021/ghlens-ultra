import type { H } from "../core/handler";
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
 *   • voice in → text → answer (Whisper) and text → voice (TTS) — hands-free
 *   • Persian-first: every answer respects the user's locale
 */
export class Assistant {
  async home(h: H) {
    const fa = h.loc === "fa";
    const chat = await h.store.history(`u${h.u.id}`, 4);
    await h.reply(
      `🤖 <b>${fa ? "دستیار هوش مصنوعی لنز" : "Lens AI assistant"}</b>\n\n` + (fa
        ? `می‌توانم:\n• پروژه مناسب برایت پیدا کنم («یک کتابخانه سبک برای صف در Go»)\n• هر مخزنی را تحلیل کنم و رقیب‌هایش را بگویم\n• با محتوای یک مخزن چت کنم و منبع بدم\n• README را فارسی کنم\n• ورک‌فلوی GitHub Actions بسازم\n• کد یا PR را بازبینی کنم\n\nفقط بنویس — یا با 🎤 ویس بفرست.`
        : `Ask anything about open source, or send a voice note.`),
      kb(
        [
          { text: "💬 " + (fa ? "گفت‌وگوی جدید" : "New chat"), cb: "a:new" },
          { text: "🧠 " + (fa ? "چت با مخزن" : "Chat with repo"), cb: "a:repochat" },
        ],
        [
          { text: "📝 " + (fa ? "ترجمه README" : "Translate README"), cb: "ai:tr:ask" },
          { text: "⚙️ " + (fa ? "ساخت ورک‌فلو" : "Build workflow"), cb: "a:workflow" },
        ],
        [
          { text: "🧑‍💻 " + (fa ? "توضیح کد" : "Explain code"), cb: "a:code" },
          { text: "🔍 " + (fa ? "بازبینی PR" : "Review PR"), cb: "a:review" },
        ],
        [
          { text: "🎙 " + (fa ? "پاسخ صوتی" : "Voice answer"), cb: "a:voice" },
          { text: "🧹 " + (fa ? "پاک کردن حافظه" : "Clear memory"), cb: "a:clear" },
        ],
        chat.results?.length
          ? [[{ text: "🕘 " + (fa ? "ادامه گفت‌وگو" : "Continue chat"), cb: "a:cont" }]]
          : [],
        [{ text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
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

    // 1. Does the question need live data? Ask a cheap classifier, then fetch.
    const plan = await h.ai.json<{ needs_github: boolean; query: string | null }>(
      `User question: "${question}"\nDoes answering this well require looking up repositories on GitHub right now? Return {"needs_github":true/false,"query":"github search query or null"}`,
      { tier: "fast", max_tokens: 120, cacheKey: `cls:${hash(question)}`, cacheTtl: 86400 },
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
      { tier: "smart", max_tokens: 1400, temperature: 0.5, userId: h.u.id, feature: "assistant" },
    );

    await h.store.addMessage(chatId, "assistant", answer || "");
    await h.store.bumpLeaderboard(h.u.id, "queries");
    await h.store.addXp(h.u.id, 1, "ai_ask");

    if (opts.voiceReply) {
      const audio = await h.ai.speak(answer.slice(0, 600), h.loc);
      if (audio) await h.tg.sendAudio(h.chatId, audio, "🎙 " + (fa ? "پاسخ صوتی لنز" : "Lens voice answer"), {});
    }

    await h.reply(
      (answer || (await aiDownNotice(h.env, h.loc))).slice(0, 3900),
      kb(
        [
          { text: "🔁 " + (fa ? "بپرس ادامه‌اش" : "Follow up"), cb: "a:cont" },
          { text: "🎙 " + (fa ? "صوتی بخوان" : "Read aloud"), cb: `a:tts:${hash(answer).slice(0, 24)}` },
        ],
        [
          { text: "🔎 " + (fa ? "جست‌وجوی این جمله" : "Search this"), cb: `n:q:${encodeURIComponent(question).replace(/%/g, "_").slice(0, 36)}` },
          { text: "🧹 " + (fa ? "گفت‌وگوی جدید" : "New chat"), cb: "a:clear" },
        ],
      ),
      !!h.cbId,
    );
  }

  /** Chat with a repository: RAG over README + docs, with citations. */
  async repoChat(h: H, full: string, question?: string) {
    const fa = h.loc === "fa";
    if (!question) {
      await h.session.set("repochat", full);
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
    const { answer, sources } = await rag.ask(full, question, corpus, h.loc);

    await h.store.addXp(h.u.id, 2, "repochat");
    await h.reply(
      `🧠 <b>${tgEscape(full)}</b>\n<i>${fa ? "سؤال" : "Q"}: ${tgEscape(truncate(question, 140))}</i>\n\n` +
        truncate(answer, 3300) +
        `\n\n──────────\n<b>${fa ? "منابع" : "Sources"}</b>\n` +
        sources.slice(0, 4).map((s) => `[${s.n}] ${i(tgEscape(truncate(s.excerpt, 120)))} (${s.score})`).join("\n"),
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
    const meta = await h.store.repoFresh(full, 3600);
    if (!meta) return h.reply(fa ? "❌ مخزن پیدا نشد." : "❌ not found", kb([{ text: "◀️", cb: "a:home" }]), true);

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
    const text = a
      ? `🎯 <b>${tgEscape(a.one_liner ?? full)}</b>\n\n` +
        `📖 <b>${fa ? "چیست" : "What"}</b>\n${tgEscape(a.what ?? "")}\n\n` +
        `👤 <b>${fa ? "برای کیست" : "Who for"}</b>\n${tgEscape(a.who_for ?? "")}\n\n` +
        `✅ <b>${fa ? "نقاط قوت" : "Pros"}</b>\n${(a.pros ?? []).map((x) => `• ${tgEscape(x)}`).join("\n")}\n\n` +
        `⚠️ <b>${fa ? "نقاط ضعف (صادقانه)" : "Cons"}</b>\n${(a.cons ?? []).map((x) => `• ${tgEscape(x)}`).join("\n")}\n\n` +
        `🔀 <b>${fa ? "جایگزین‌ها" : "Alternatives"}</b>\n${(a.alternatives ?? []).map((x) => `• ${tgEscape(x)}`).join("\n")}\n\n` +
        `📚 ${fa ? "شیب یادگیری" : "Learning curve"}: ${tgEscape(a.learning_curve ?? "—")}\n` +
        `🏭 ${fa ? "آماده تولید" : "Production ready"}: <b>${tgEscape(a.production_ready ?? "—")}</b>\n` +
        `🛡 ${fa ? "نکته امنیتی" : "Security note"}: ${tgEscape(a.security_note ?? "—")}\n\n` +
        `🏷 ${(a.tags_fa ?? []).map((t) => code("#" + t)).join(" ")}\n\n` +
        `<i>${fa ? "تولیدشده با Workers AI بر اساس داده زنده گیت‌هاب." : "Generated by Workers AI from live GitHub data."}</i>`
      : `📊 <b>${tgEscape(full)}</b>\n${tgEscape(meta.description ?? "")}\n\n⭐ ${fmt(meta.stars)} · 🍴 ${fmt(meta.forks)} · 🐞 ${fmt(meta.open_issues)} · 🧩 ${tgEscape(meta.language ?? "—")}\n\n<i>${fa ? "این یکی از قبل تحلیل شده بود (کش)." : "cached analysis"}</i>`;

    if (a) {
      await h.env.DB.prepare(`UPDATE repos SET ai_summary_fa=? WHERE full_name=?`).bind(a.one_liner ?? "", full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    await h.reply(
      text,
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
  async translateReadme(h: H, full: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🌍 در حال ترجمه README…" : "🌍 translating README…");
    const gh = new GithubRest(h.env);
    const raw = await gh.readme(full, 3600).catch(() => null);
    if (!raw?.content) return h.reply(fa ? "❌ README پیدا نشد." : "❌ README missing.", kb([{ text: "◀️", cb: `s:card:${full}` }]), true);
    const md = decodeB64(raw.content);

    const cacheKey = `trl:${full}:${h.loc}`;
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      // keep the structure: translate in two passes for very long READMEs
      const parts = splitMd(md, 14000);
      const out: string[] = [];
      for (const p of parts.slice(0, 3)) out.push(await h.ai.translate(p, h.loc === "fa" ? "fa" : "en", "README"));
      translated = out.filter(Boolean).join("\n\n");
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

    const chunks = chunkMd(translated.slice(0, 12000), 3800);
    await h.reply(chunks[0] + (chunks.length === 1 ? footer : `\n\n<i>…1/${chunks.length}</i>`), kb(
      chunks.length > 1 ? [{ text: "➡️ " + (fa ? "ادامه" : "Continue"), cb: `ai:trmore:${full}:1` }] : [],
      [
        { text: "🇬🇧 English", cb: `ai:tre:${full}:en` },
        { text: "🖨 PDF", cb: `ai:trpdf:${full}` },
      ],
      [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
    ), !!h.cbId);
    await h.session.set(`tr:${full}`, translated);
  }

  /** Workflow generator */
  async workflow(h: H, description?: string) {
    const fa = h.loc === "fa";
    if (!description) {
      await h.session.set("wf", true);
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
    await h.reply(
      pre("yaml", yaml.slice(0, 3400)) +
        `\n\n📁 ${fa ? "مسیر پیشنهادی" : "suggested path"}: <code>.github/workflows/${guessName(description)}.yml</code>`,
      kb(
        [
          { text: "🔁 " + (fa ? "بازسازی" : "Regenerate"), cb: `a:wf:${description.slice(0, 120)}` },
          { text: "🧪 " + (fa ? "تست رجکس" : "Regex lab"), cb: "u:regex" },
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
      await h.session.set("code", true);
      return h.reply(
        `🧑‍💻 <b>${fa ? "توضیح کد" : "Code explainer"}</b>\n\n${fa ? "کد را بفرست (در یک پیام یا به‌صورت بلوک کد) تا توضیح بدهم: هدف، جریان، نکات ظریف، پیچیدگی و دو پیشنهاد بهبود." : "Send code and I'll explain it."}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
      );
    }
    await h.loading(fa ? "🧠 در حال خواندن کد…" : "🧠 reading…");
    const out = await h.ai.explainCode(snippet, h.loc);
    await h.reply(out.slice(0, 3800), kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }], [{ text: "🧪 " + (fa ? "دوباره" : "Again"), cb: "a:code" }]]), !!h.cbId);
  }

  async review(h: H, target?: string) {
    const fa = h.loc === "fa";
    if (!target) {
      await h.session.set("review", true);
      return h.reply(
        `🔍 <b>${fa ? "بازبینی PR" : "PR review"}</b>\n\n${fa ? "فرمت: <code>/review owner/repo#123</code>\nمن دیف را می‌گیرم و مثل یک مهندس ارشد بازبینی می‌کنم." : "Format: <code>/review owner/repo#123</code>"}`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "a:home" }]]),
      );
    }
    const m = target.match(/^([\w.\-]+\/[\w.\-]+)(?:#|!)(\d+)$/);
    if (!m) return h.reply(fa ? "❌ قالب درست نیست. مثال: `owner/repo#12`" : "❌ bad format", kb([{ text: "◀️", cb: "a:home" }]), true);
    await h.loading(fa ? "🔍 در حال خواندن دیف…" : "🔍 fetching diff…");
    const diffRes = await fetch(`https://api.github.com/repos/${m[1]}/pulls/${m[2]}`, {
      headers: { accept: "application/vnd.github.v3.diff", authorization: `Bearer ${h.env.GITHUB_TOKEN}`, "user-agent": "GitHubLensUltra" },
    }).catch(() => null);
    if (!diffRes?.ok) return h.reply(fa ? "❌ دیف دریافت نشد." : "❌ diff unavailable", kb([{ text: "◀️", cb: "a:home" }]), true);
    const diff = (await diffRes.text()).slice(0, 14000);
    const out = await h.ai.reviewPR(diff, h.loc);
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
    await h.reply(`🎧 <b>${fa ? "شنیدم" : "Heard"}</b>: <i>${tgEscape(text)}</i>`, kb([[{ text: "🎙 " + (fa ? "پاسخ صوتی" : "Voice answer"), cb: `a:askv:${text.slice(0, 120)}` }]]));
    return this.ask(h, text, { voiceReply: true });
  }
}

// helpers
export function decodeB64(s: string) {
  try { return atob(s.replace(/\s/g, "")); } catch { return ""; }
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
