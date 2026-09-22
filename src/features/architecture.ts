import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import { parseRepoRef } from "../core/repo-ref";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

export class ArchitectureExplainer {
  async explain(h: H, input: string) {
    const fa = h.loc === "fa";
    const full = parseRepoRef(input) ?? input.trim();
    if (!full || !full.includes("/")) {
      return h.reply(
        fa
          ? "🗺 <b>تحلیل معماری و جریان کد (Code Flow)</b>\n\nنام یا لینک مخزن را بفرست تا کل ساختار و معماری پروژه را در ۳۰ ثانیه تحلیل کنم."
          : "🗺 Send a repo reference to analyze its architecture and code flow.",
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "m:home" }]]),
        !!h.cbId,
      );
    }

    await h.loading(fa ? "🗺 در حال استخراج ساختار فایل‌ها و تحلیل معماری…" : "Analyzing repository architecture…");
    const gh = new GithubRest(h.env);
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
    const readmeSnippet = readmeRaw?.content ? atob(readmeRaw.content.replace(/\s/g, "")).slice(0, 2000) : "";

    const prompt =
      `You are a senior software architect. Analyze the repository "${full}" based on its file tree and description.\n` +
      `Description: ${repo.description ?? "none"}\n` +
      `Primary Language: ${repo.language ?? "unknown"}\n` +
      `File paths (sample):\n${fileListSnippet}\n\n` +
      `Readme excerpt:\n${readmeSnippet}\n\n` +
      `Provide a clear, crisp architecture breakdown in ${fa ? "fluent Persian" : "English"}:\n` +
      `1. 🎯 Entrypoint & Core: Where execution starts (main files)\n` +
      `2. 🔄 Data Flow: How requests/data flow from input to output\n` +
      `3. 🧩 Key Modules: Roles of major directories/files\n` +
      `4. ⚡ Tech Stack & Architecture Pattern (e.g. Clean Arch, Monolith, MVC, Microservice)\n` +
      `5. 💡 Summary for newcomers (1 sentence)\n\n` +
      `Keep it structured with clean bullet points and emojis. Do not exceed 3200 characters.`;

    const analysis = await h.ai.chat(prompt, {
      tier: "smart",
      max_tokens: 1500,
      temperature: 0.2,
      feature: "architecture",
    });

    const body =
      `🗺 <b>${fa ? "معماری و ساختار پروژه" : "Project Architecture & Code Flow"}</b>\n` +
      `📦 <b>${tgEscape(full)}</b> · ⭐ ${repo.stargazers_count ?? 0} · 🧩 ${repo.language ?? "—"}\n\n` +
      (analysis || (fa ? "تحلیل هوش مصنوعی در دسترس نبود." : "Analysis unavailable."));

    return h.reply(
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
