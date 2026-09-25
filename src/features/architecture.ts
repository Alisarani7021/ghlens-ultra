import type { H } from "../core/handler";
import { parseRepoRef } from "../core/repo-ref";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

export class ArchitectureExplainer {
  async explain(h: H, input: string) {
    const fa = h.loc === "fa";
    let full = parseRepoRef(input);
    if (!full) {
      const clean = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/+$/, "");
      if (clean.includes("/")) {
        full = clean;
      } else if (clean.length >= 2) {
        // User typed bare repo or keyword like "v2rayNG"
        await h.loading(fa ? `🔎 جست‌وجوی دقیق مخزن برای «${clean}»…` : `Searching repository for "${clean}"…`);
        const searchGh = h.gh();
        const res = await searchGh.searchRepos(clean, "stars", "desc", 1).catch(() => null);
        if (res?.items?.[0]?.full_name) {
          full = res.items[0].full_name;
        }
      }
    }

    if (!full || !full.includes("/")) {
      return h.reply(
        fa
          ? "🗺 <b>تحلیل معماری و جریان کد (Code Flow)</b>\n\nنام یا آدرس هر مخزن گیت‌هاب را بفرست (مثلاً <code>v2rayNG</code> یا <code>2dust/v2rayNG</code> یا لینک کامل گیتهاب) تا کل ساختار و معماری پروژه را در ۳۰ ثانیه تحلیل کنم."
          : "🗺 Send a repo name or link (e.g. <code>v2rayNG</code> or <code>owner/repo</code>) to analyze its architecture and code flow.",
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "m:home" }]]),
        !!h.cbId,
      );
    }

    await h.loading(fa ? "🗺 در حال استخراج ساختار فایل‌ها و تحلیل معماری…" : "Analyzing repository architecture…");
    const gh = h.gh();
    const [repo, rootFiles, readmeRaw] = await Promise.all([
      gh.repo(full, 600).catch(() => null),
      gh.contents(full, "", 600).catch(() => [] as any[]),
      gh.readme(full, 600).catch(() => null),
    ]);

    if (!repo) {
      return h.reply(fa ? "❌ مخزن یافت نشد." : "Repository not found.", kb([{ text: "◀️", cb: "m:home" }]), true);
    }

    const items = Array.isArray(rootFiles) ? rootFiles : [];
    const files = items.slice(0, 40).map((t: any) => `${t.type === "dir" ? "📁" : "📄"} ${t.path}`);
    const fileListSnippet = files.join("\n");
    const readmeSnippet = readmeRaw?.content ? new TextDecoder("utf-8").decode(Uint8Array.from(atob(readmeRaw.content.replace(/\s/g, "")), (c: string) => c.charCodeAt(0))).slice(0, 2000) : "";

    const prompt =
      `You are a principal software architect.\n` +
      `Provide a high-end, clean architectural blueprint for the repository "${full}".\n` +
      `Description: ${repo.description ?? "none"}\n` +
      `Primary Language: ${repo.language ?? "unknown"}\n` +
      `File paths:\n${fileListSnippet}\n\n` +
      `Readme excerpt:\n${readmeSnippet}\n\n` +
      `Language of response: ${fa ? "Fluent Persian (فارسی روان و تمیز مهندسی)" : "English"}.\n` +
      `IMPORTANT FORMATTING RULES:\n` +
      `- You MAY use ONE small Markdown table (max 5 rows) for the tech stack — it renders as a real table.\n` +
      `- Use Telegram blockquote (starting with '> ') for the high-level summary/verdict.\n` +
      `- Organize cleanly into 4 distinct sections with bold titles:\n` +
      `  🎯 **هسته و نقطه ورود** (Entrypoint & Core Execution)\n` +
      `  🔄 **جریان داده و چرخه حیات** (Data & Request Lifecycle)\n` +
      `  🧩 **ماژول‌ها و ساختار پوشه‌ها** (Core Modules & Directory Map)\n` +
      `  ⚡ **الگوی معماری و استک** (Architectural Pattern & Tech Stack)\n` +
      `- Total length strictly under 2800 characters.`;

    const analysis = await h.ai.chat(prompt, {
      deadlineMs: h.budget(), tier: "smart",
      max_tokens: 1500,
      temperature: 0.2,
      feature: "architecture",
    });

    /* Rich: the analysis is written as four titled sections, so it is rendered as
       four sections — with the stack table the model is now allowed to produce. */
    const { markdownToRichHtml, richDoc, inlineMd } = await import("../hub/richdoc");
    const body = richDoc({
      title: `🗺 ${fa ? "معماری و مهندسی پروژه" : "Project Architecture"}`,
      meta:
        `📦 <b>${inlineMd(full)}</b> · ⭐ <b>${(repo.stargazers_count ?? 0).toLocaleString()}</b> · ` +
        `🍴 ${(repo.forks_count ?? 0).toLocaleString()} · 🧩 <code>${inlineMd(repo.language ?? "—")}</code>`,
      body: markdownToRichHtml(analysis || (fa ? "تحلیل هوش مصنوعی در دسترس نبود." : "Analysis unavailable."), { headingBase: 2 }),
    });

    return h.replyRich(
      body,
      kb(
        [
          { text: "🛰 " + (fa ? "کاوش عمیق مخزن" : "Deep scout"), cb: `s:go:${full}` },
          { text: "🧠 " + (fa ? "چت با مخزن" : "Chat with repo"), cb: `a:repochat:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "کارت مخزن" : "Repo card"), cb: `s:card:${full}` }],
      ),
      true,
    );
  }
}

export function markdownToTelegramHtml(md: string): string {
  if (!md) return "";
  let text = md.trim();

  // Escape HTML entities first to avoid broken tags
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks ```lang\ncode\n```
  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code `code`
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold & Italic ***text***
  text = text.replace(/\*\*\*([^\*\n]+)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold **text**
  text = text.replace(/\*\*([^\*\n]+)\*\*/g, "<b>$1</b>");

  // Italic *text* or _text_
  text = text.replace(/\*([^\*\n]+)\*/g, "<i>$1</i>");
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1<i>$2</i>");

  // Markdown links [text](url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // Strip markdown table separator lines |---|---|
  text = text.replace(/^[ \t]*\|?[-:\s|]{3,}\|?[ \t]*$/gm, "");

  // Convert table rows to neat bullet lines
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row) => {
    const cols = row.split("|").map((c: string) => c.trim().replace(/^<b>(.*)<\/b>$/, "$1")).filter(Boolean);
    if (cols.length === 0) return "";
    if (cols.length === 1) return `• ${cols[0]}`;
    return `• <b>${cols[0]}:</b> ${cols.slice(1).join(" — ")}`;
  });

  // Headers ### Header -> <b>Header</b>
  text = text.replace(/^#{1,6}\s*(.+)$/gm, "\n<b>$1</b>");

  // Markdown lists - item or * item
  text = text.replace(/^[*-]\s+(.+)$/gm, "• $1");

  // Blockquotes > quote -> <blockquote>quote</blockquote>
  text = text.replace(/^(?:&gt;|>)[ \t]?(.*)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Clean up excess newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
