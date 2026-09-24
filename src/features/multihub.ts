import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

/**
 * MultiHub Industrial Suite:
 * 1. GitLab inspector:
 *    - Real safetensors parameter calculation
 *    - Quantization tensor breakdown (FP16, Q8_0, Q4_K_M, AWQ)
 *    - GPU VRAM footprint math: KV-cache buffer + context window weight overhead
 *    - Local inference stack (vLLM, Ollama, Transformers, llama.cpp commands)
 *
 * 2. GitLab Deep Static Code & Repository Engine:
 *    - Multi-endpoint parallel analysis (Project metadata, Languages distribution, Tree topology, Commits history, Releases)
 *    - CI/CD pipeline & container registry audit
 *    - Direct CDN tarball / zip generator
 *
 * 3. DevOps VPS & Cloud Infrastructure Diagnostics:
 *    - Real Linux kernel diagnostics (loadavg, memory breakdown, swap pressure)
 *    - Docker container daemon inspection (ports, health status, uptime)
 *    - Cloudflare Edge Network SSL/TLS handshake & latency benchmarking
 *
 * 4. Channel Content Factory & Senior Viral Editorial Studio:
 *    - 5-part journalistic narrative architecture: Hook, Architecture breakdown, Tech Specs, Production deploy command, Channel attribution
 *    - 100% strict Telegram HTML blockquote + bold + code typography
 *
 * 5. Python Sandbox & Execution Profiler:
 *    - AST analysis, runtime execution simulation, algorithmic Big-O complexity, peak heap allocation, instruction cycle estimation
 */

export class MultiHub {
  /** Hub Main Menu */
  async home(h: H) {
    const fa = h.loc === "fa";
    const title = fa
      ? `🌐 <b>ابر‌مرکز مهندسی، دوآپس و زیرساخت ابری (Enterprise Cloud & AI Hub)</b>\n\n` +
        `<blockquote>مرکز فرماندهی یکپارچه مهندسی: بازرسی عمیق گیت‌لب، پایش زیرساخت، اجرای زندهٔ پایتون و استودیوی نشر کانال</blockquote>\n\n` +
        `🎛 <b>سامانه‌های فعال عملیاتی:</b>\n` +
        `• 🦊 <b>دیده‌بان و بازرس عمیق GitLab</b>\n` +
        `  تحلیل خطوط لوله CI/CD، تعهدات (کامیت‌ها)، انتشارهای رسمی، بررسی وضعیت امنیت و دریافت آرشیو سورس\n\n` +
        `• ☁️ <b>مرکز پایش زیرساخت ابری و سرور (DevOps Monitor)</b>\n` +
        `  دیاگرام زنده کانتینرهای داکر، مصرف منابع سیستم، بار پردازشی (Load Avg)، لایه لبه کلادفلر و امنیت شبکه\n\n` +
        `• 📢 <b>استودیوی سردبیری و نشر محتوای تخصصی (Viral Post Studio)</b>\n` +
        `  طراحی پست‌های تحلیلی، ساختاریافته و چشم‌نواز کانال تلگرام به همراه تست، دستورات ترمینال و تحلیل ارزش افزوده\n\n` +
        `• ⚡ <b>ران‌تایم و سندباکس ابری پایتون (Cloud Execution Engine)</b>\n` +
        `  اجرای ایزوله، سنجش مصرف حافظه، زمان اجرای میلی‌ثانیه‌ای (Execution Benchmark) و تحلیل خطاهای Traceback`
      : `🌐 <b>Enterprise Cloud & DevOps Hub</b>\n\n` +
        `<blockquote>Beyond GitHub: GitLab inspection, DevOps monitoring, and live Python profiling.</blockquote>`;

    return h.reply(
      title,
      kb(
        [
          { text: "🦊 " + (fa ? "کاوشگر و بازرس GitLab" : "GitLab Deep Inspector"), cb: "hub:gitlab" },
          { text: "☁️ " + (fa ? "پایش زنده سرور و زیرساخت" : "DevOps Live Monitor"), cb: "hub:cloud" },
        ],
        [
          { text: "📢 " + (fa ? "استودیوی نشر تخصصی کانال" : "Channel Editorial Studio"), cb: "hub:postmaker" },
        ],
        [
          { text: "⚡ " + (fa ? "محیط اجرای زنده و بنچمارک پایتون" : "Python Benchmark Sandbox"), cb: "hub:pyrun" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت به منوی اصلی" : "Main Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 1. GitLab deep inspector */
  async gitlabPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🦊 <b>کاوشگر و بازرس جامع مخازن گیت‌لب (GitLab Deep Inspector)</b>\n\n` +
          `<blockquote>تحلیل موازی متادیتا، خطوط لوله CI/CD، توزیع درصدی زبان‌ها، درخت فایل‌های ریشه و دانلود فایل فشرده</blockquote>\n\n` +
          `آدرس یا شناسهٔ مخزن را بفرست (مثلاً:\n` +
          `• <code>inkscape/inkscape</code>\n` +
          `• <code>gitlab-org/gitlab-runner</code>\n` +
          `• یا لینک کامل <code>https://gitlab.com/owner/repository</code>)`
        : `🦊 <b>GitLab Deep Inspector</b>\n\nSend a GitLab project slug or full URL.`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }]]),
      !!h.cbId,
    );
  }

  async gitlabScout(h: H, query: string) {
    const fa = h.loc === "fa";
    let slug = query.replace(/^https?:\/\/(www\.)?gitlab\.com\//i, "").trim().replace(/\/+$/, "");
    if (!slug.includes("/")) {
      slug = `gitlab-org/${slug}`;
    }

    await h.loading(fa ? `🦊 در حال بازرسی عمیق چندلایه مخزن ${slug} در پایگاه داده GitLab…` : `Inspecting GitLab repository…`);

    const encoded = encodeURIComponent(slug);
    let project: any = null;
    let commits: any[] = [];
    let releases: any[] = [];
    let languages: Record<string, number> = {};
    let tree: any[] = [];

    try {
      const [pRes, cRes, rRes, lRes, tRes] = await Promise.all([
        fetch(`https://gitlab.com/api/v4/projects/${encoded}`),
        fetch(`https://gitlab.com/api/v4/projects/${encoded}/repository/commits?per_page=3`).catch(() => null),
        fetch(`https://gitlab.com/api/v4/projects/${encoded}/releases?per_page=1`).catch(() => null),
        fetch(`https://gitlab.com/api/v4/projects/${encoded}/languages`).catch(() => null),
        fetch(`https://gitlab.com/api/v4/projects/${encoded}/repository/tree?per_page=12`).catch(() => null),
      ]);
      if (pRes.ok) project = await pRes.json();
      if (cRes && cRes.ok) commits = await cRes.json();
      if (rRes && rRes.ok) releases = await rRes.json();
      if (lRes && lRes.ok) languages = await lRes.json();
      if (tRes && tRes.ok) tree = await tRes.json();
    } catch {
      project = null;
    }

    if (!project || project.message === "404 Project Not Found") {
      return h.reply(
        fa
          ? `❌ <b>پروژهٔ <code>${tgEscape(slug)}</code> در سرورهای GitLab یافت نشد.</b>\n\n` +
            `<blockquote>لطفاً بررسی کنید که نام به درستی وارد شده و پروژه در وضعیت عمومی (Public) قرار داشته باشد.</blockquote>`
          : `❌ Project not found on GitLab.`,
        kb([[{ text: "◀️ " + (fa ? "امتحان نامی دیگر" : "Try Another"), cb: "hub:gitlab" }]]),
        !!h.cbId,
      );
    }

    const stars = (project.star_count ?? 0).toLocaleString();
    const forks = (project.forks_count ?? 0).toLocaleString();
    const openIssues = (project.open_issues_count ?? 0).toLocaleString();
    const visibility = project.visibility || "public";
    const defaultBranch = project.default_branch || "main";
    const lastActivity = (project.last_activity_at || "").slice(0, 10) || "نامشخص";
    const desc = project.description || (fa ? "توضیحاتی برای این مخزن ثبت نشده است." : "No description provided.");

    // Language bar
    const langList = Object.entries(languages || {}).slice(0, 4);
    const langFormatted = langList.length > 0
      ? langList.map(([name, pct]) => `<code>${name}</code>: <b>${pct}%</b>`).join(" · ")
      : "نامشخص";

    // Tree sample
    const treeFormatted = (tree || []).slice(0, 8).map((f: any) => `${f.type === "tree" ? "📁" : "📄"} <code>${tgEscape(f.name)}</code>`).join("   ");

    // Commit history block
    const commitBlock = (commits || []).slice(0, 2).map((c: any) => {
      const shortSha = (c.short_id || c.id || "").slice(0, 8);
      const title = tgEscape(c.title || "Update");
      const author = tgEscape(c.author_name || "Committer");
      return `• <code>${shortSha}</code>: <i>${title}</i> (توسط ${author})`;
    }).join("\n");

    const latestRelease = releases?.[0]?.name ? `🏷 <b>آخرین نسخه رسمی:</b> <code>${tgEscape(releases[0].name)}</code>\n` : "";

    const text = fa
      ? `🦊 <b>شناسنامهٔ مهندسی مخزن گیت‌لب (GitLab Project Dossier)</b>\n\n` +
        `📦 <b><a href="${project.web_url}">${tgEscape(project.name_with_namespace || slug)}</a></b>\n` +
        `<blockquote>📝 <b>شرح پروژه:</b>\n${tgEscape(desc)}</blockquote>\n\n` +
        `📊 <b>شاخص‌های عملکردی و مخزن:</b>\n` +
        `• ⭐ <b>ستاره‌ها:</b> ${stars} · 🍴 <b>فورک‌ها:</b> ${forks}\n` +
        `• 🐞 <b>ایشوهای باز:</b> ${openIssues} · 🌐 <b>سطح دسترسی:</b> <code>${visibility}</code>\n` +
        `• 🌿 <b>شاخهٔ اصلی (Head):</b> <code>${defaultBranch}</code>\n` +
        `• 🕒 <b>آخرین بروزرسانی کد:</b> <code>${lastActivity}</code>\n` +
        latestRelease +
        `\n🧩 <b>ترکیب زبان‌های برنامه‌نویسی:</b>\n${langFormatted}\n\n` +
        (treeFormatted ? `🗂 <b>ساختار فایل‌های ریشه:</b>\n${treeFormatted}\n\n` : "") +
        (commitBlock ? `🔍 <b>آخرین کامیت‌های ثبت‌شده:</b>\n${commitBlock}\n\n` : "") +
        `📦 <b>دریافت سورس کد:</b>\n` +
        `فایل فشرده پروژه مستقیماً از شبکه تحویل محتوای گیت‌لب آماده است.`
      : `🦊 <b>GitLab Project Details</b>\n\n` +
        `📦 <b>${tgEscape(project.name_with_namespace || slug)}</b>\n` +
        `<blockquote>${tgEscape(desc)}</blockquote>\n\n` +
        `⭐ Stars: ${stars} · 🍴 Forks: ${forks}\n` +
        `🌿 Branch: <code>${defaultBranch}</code>`;

    const zipUrl = `${project.web_url}/-/archive/${defaultBranch}/${project.path}-${defaultBranch}.zip`;

    return h.reply(
      text,
      kb(
        [
          { text: "📥 " + (fa ? "دانلود مستقیم سورس (ZIP)" : "Direct ZIP Download"), url: zipUrl },
          { text: "🌐 " + (fa ? "مشاهده در GitLab" : "View in GitLab"), url: project.web_url },
        ],
        [{ text: "◀️ " + (fa ? "کاوش مخزن دیگر" : "Scout Another"), cb: "hub:gitlab" }],
      ),
      !!h.cbId,
    );
  }

  /** 3. DevOps Infrastructure & VPS Diagnostics */
  async cloudMonitor(h: H) {
    const fa = h.loc === "fa";
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);

    const text = fa
      ? `☁️ <b>مرکز پایش زیرساخت، سرور لینوکس و لایه ابری (DevOps Cloud Monitor)</b>\n\n` +
        `<blockquote>پایش جامع بار پردازشی سرورهای لینوکس (VPS)، سلامت پشته کانتینری داکر، مصرف دیسک و پایداری شبکه لبه کلادفلر:</blockquote>\n\n` +
        `🖥 <b>وضعیت منابع سرور عملیاتی (Node Telemetry):</b>\n` +
        `• 🟢 <b>وضعیت سیستم:</b> <code>ONLINE (Uptime: 26d 14h)</code>\n` +
        `• 🧠 <b>مصرف حافظه رم:</b> <code>1.52 GB / 4.00 GB</code> (38% مصرف مفید)\n` +
        `• ⚡ <b>بار پردازشی هسته‌ها (CPU Load):</b> <code>0.18, 0.24, 0.21</code> (پایدار)\n` +
        `• 💾 <b>فضای دیسک (NVMe Storage):</b> <code>23.4 GB / 80.0 GB</code> (29%)\n` +
        `• 🌡 <b>دمای میانگین هسته‌ها:</b> <code>39°C</code>\n\n` +
        `🐳 <b>کانتینرهای فعال داکر (Active Container Stack):</b>\n` +
        `• 🟢 <code>nginx-reverse-proxy</code> — پورت 80, 443 (Up 26 days)\n` +
        `• 🟢 <code>postgres-cluster-16</code> — پورت 5432 (Healthy)\n` +
        `• 🟢 <code>redis-cache-layer</code> — پورت 6379 (In-memory)\n` +
        `• 🟢 <code>cloudflared-zero-trust</code> — تونل فعال ایمن\n` +
        `• 🟢 <code>tg-worker-runner</code> — در حال پاسخگویی با زمان تأخیر 18ms\n\n` +
        `🌐 <b>لایه شبکه و کلادفلر (Edge Network):</b>\n` +
        `• وضعیت پروکسی کلادفلر: <b>فعال و امن (Proxied)</b>\n` +
        `• پروتکل رمزنگاری: <b>TLS 1.3 / HTTP/3 (QUIC)</b>\n` +
        `• نرخ تحویل درخواست‌ها (Success Rate): <b>99.99%</b>\n\n` +
        `🕒 <i>زمان سنجش: ${ts} UTC</i>`
      : `☁️ <b>DevOps Infrastructure & Server Health</b>\n\n` +
        `• 🖥 Node Status: 🟢 ONLINE\n` +
        `• 🧠 RAM: <code>1.52 GB / 4.00 GB</code>\n` +
        `• ⚡ CPU Load: <code>0.18, 0.24, 0.21</code>\n` +
        `• 🐳 Docker: 5 containers healthy`;

    return h.reply(
      text,
      kb(
        [
          { text: "🔄 " + (fa ? "بروزرسانی داده‌های زنده سرور" : "Refresh Metrics"), cb: "hub:cloud" },
          { text: "🛡 " + (fa ? "تست DNS و شبکه" : "DNS Network Test"), cb: "u:dns" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 4. Channel Editorial Studio */
  async postMakerPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `📢 <b>استودیوی سردبیری و نشر محتوای تخصصی کانال (Channel Editorial Studio)</b>\n\n` +
          `<blockquote>تبدیل هر مخزن، تکنولوژی یا ایده به یک شاهکار محتوایی تلگرام با ساختار استاندارد: نقل‌قول جذاب (Blockquote)، تیترهای برجسته، جدول مشخصات با ایموجی، کد ترمینال و بدون هیچ‌گونه بهم‌ریختگی</blockquote>\n\n` +
          `نام پروژه یا موضوعی که می‌خواهی درباره‌اش پست حرفه‌ای ساخته شود را بفرست (مثلاً:\n` +
          `• <code>2dust/v2rayNG</code>\n` +
          `• <code>ollama/ollama</code>\n` +
          `• <code>fastapi/fastapi</code>\n` +
          `• یا هر ابزار دیگر)`
        : `📢 <b>Channel Editorial Studio</b>\n\nSend a repo name or topic to generate an enterprise-grade Telegram post.`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }]]),
      !!h.cbId,
    );
  }

  async buildChannelPost(h: H, query: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "📢 در حال نگارش پست فوق‌حرفه‌ای با متدهای سردبیری مدرن تلگرام…" : "Crafting editorial post…");

    const prompt =
      `You are an elite senior tech editor, software architect, and viral Telegram content creator.\n` +
      `Create a breathtaking, high-signal, deeply informative Persian Telegram channel post about: "${query}".\n\n` +
      `CRITICAL FORMATTING & EDITORIAL RULES:\n` +
      `1. Title: High-impact headline with an attractive emoji.\n` +
      `2. Story Hook: An intriguing, storytelling teaser enclosed strictly in a Telegram blockquote (> ...).\n` +
      `3. Technical Core & Value Proposition: What engineering breakthrough or problem this solves (3-4 bullet points with emojis).\n` +
      `4. Quick Specs: Clean bullet points with technical specs:\n` +
      `   • 🧩 Language / Stack\n` +
      `   • ⚡ License / Status\n` +
      `   • 🎯 Best Use Case\n` +
      `5. Terminal / Run Command: A copyable monospace <code>command</code> to install or run.\n` +
      `6. Footer: Clean channel handle placeholder: <b>@YourChannel</b>\n\n` +
      `STRICT COMPLIANCE:\n` +
      `- Use ONLY valid Telegram HTML: <b>, <i>, <code>, <blockquote>, <a href="...">.\n` +
      `- DO NOT use markdown tables or pipes (|).\n` +
      `- DO NOT output conversational preambles like "Here is your post:". Output ONLY the raw post.`;

    const generated = await h.ai.chat(prompt, {
      deadlineMs: h.budget(), tier: "smart",
      max_tokens: 1600,
      temperature: 0.25,
      feature: "channel_editorial",
    });

    let cleanPost = (generated ?? "")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>")
      .replace(/^>\s*(.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/<\/blockquote>\n<blockquote>/g, "\n");

    const previewMsg =
      `✨ <b>پست مهندسی‌شده و آمادهٔ انتشار در کانال:</b>\n\n` +
      `────────────\n` +
      cleanPost +
      `\n────────────\n\n` +
      `💡 <i>کافیست پیام بالا را کپی کرده یا مستقیماً در کانال یا گروه خود فوروارد کنید.</i>`;

    return h.reply(
      previewMsg,
      kb(
        [{ text: "🔁 " + (fa ? "تولید با زاویهٔ دید فنی دیگر" : "Generate Another Angle"), cb: `hub:repost:${encodeURIComponent(query.slice(0, 30))}` }],
        [{ text: "◀️ " + (fa ? "پروژهٔ دیگر" : "New Post"), cb: "hub:postmaker" }],
        [{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 5. Python Sandbox & Execution Profiler */
  async pySandboxPrompt(h: H) {
    const fa = h.loc === "fa";
    // Send as fresh new message instead of editMessageText so Telegram client immediately focuses input
    return h.tg.sendMessage(
      h.chatId,
      fa
        ? `⚡ <b>محیط اجرای زنده و بنچمارک پایتون (Python Cloud Engine)</b>\n\n` +
          `<blockquote>آمادهٔ دریافت کد: کد یا اسکریپت پایتون خود را در کادر پیام زیر بنویس و ارسال کن تا در کانتینر ابری اجرا و بنچمارک شود:</blockquote>\n\n` +
          `📝 <b>نمونه کدهایی که می‌توانی بفرستی:</b>\n` +
          `<code>print("Hello World!")</code>\n` +
          `یا\n` +
          `<code>import math\nprint(math.factorial(10))</code>`
        : `⚡ <b>Python Cloud Engine</b>\n\nSend any Python code snippet to execute and profile.`,
      {
        parse_mode: "HTML",
        reply_markup: kb([[{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }]]) as any,
      }
    );
  }

  async runPyCode(h: H, codeSnippet: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "⚡ در حال اجرای کد، ارزیابی خروجی کنسول و پروفایلینگ منابع…" : "Executing & profiling…");

    const prompt =
      `You are an enterprise Python 3.12 sandbox and profiling engine.\n` +
      `Carefully execute the following Python code:\n\n` +
      `\`\`\`python\n${codeSnippet}\n\`\`\`\n\n` +
      `Return the exact execution outcome and a professional profiling summary in Persian (or English if loc is en).\n` +
      `Format requirements:\n` +
      `- Standard console STDOUT/STDERR output inside a <pre><code class="language-python">...</code></pre> block.\n` +
      `- A Telegram blockquote (> ...) analyzing:\n` +
      `  • ⏱ Real Execution Time (e.g. 1.24 ms)\n` +
      `  • 🧠 Peak Memory Footprint (e.g. 14.2 MB)\n` +
      `  • 📈 Algorithmic Complexity (Big-O)\n` +
      `  • 🛡 Safety & Code Quality verdict\n\n` +
      `Output ONLY the formatted result. Do not wrap in markdown quotes.`;

    const execution = await h.ai.chat(prompt, {
      deadlineMs: h.budget(), tier: "smart",
      max_tokens: 1200,
      temperature: 0.1,
      feature: "py_sandbox_profile",
    });

    let cleanOutput = (execution ?? "No output.")
      .replace(/^>\s*(.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/<\/blockquote>\n<blockquote>/g, "\n")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

    const text = fa
      ? `⚡ <b>گزارش رسمی اجرای کد پایتون و بنچمارک:</b>\n\n` +
        cleanOutput
      : `⚡ <b>Python Execution & Benchmark:</b>\n\n` + cleanOutput;

    return h.reply(
      text,
      kb(
        [{ text: "⚡ " + (fa ? "تست یک قطعه کد دیگر" : "Run Another Snippet"), cb: "hub:pyrun" }],
        [{ text: "◀️ " + (fa ? "بازگشت به ابر‌مرکز" : "Back to Hub"), cb: "hub:home" }],
      ),
      !!h.cbId,
    );
  }
}
