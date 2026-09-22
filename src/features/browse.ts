import type { H } from "../core/handler";
import { fmt, rel } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb, pager } from "../tg/keyboards";

/**
 * Browse — the structured exploration tree the original bot lacks:
 *   category → subcategory → filtered list → repo card, plus time-travel browse
 *   ("what was hot in 2019"), org browse, user browse and awesome-list mining.
 */
const TREE: Record<string, { fa: string; en: string; icon: string; subs: { fa: string; en: string; q: string }[] }> = {
  ai: {
    fa: "هوش مصنوعی و مدل‌ها", en: "AI & Models", icon: "🤖",
    subs: [
      { fa: "مدل‌های زبانی بزرگ", en: "LLM frameworks", q: "topic:llm stars:>2000" },
      { fa: "عامل‌های خودکار (Agents)", en: "Agents", q: "topic:ai-agents stars:>500" },
      { fa: "استیبل دیفیوژن و تصویر", en: "Diffusion / image", q: "stable-diffusion OR comfyui stars:>1000" },
      { fa: "تبدیل گفتار به متن", en: "Speech / ASR", q: "topic:speech-recognition OR whisper stars:>800" },
      { fa: "بازیابی و RAG", en: "RAG / vector DB", q: "topic:rag OR topic:vector-database stars:>700" },
      { fa: "فاین‌تیون و آموزش", en: "Fine-tuning", q: "topic:fine-tuning OR topic:lora stars:>500" },
      { fa: "بینایی ماشین", en: "Computer vision", q: "topic:computer-vision stars:>3000" },
      { fa: "MCP و ابزارها", en: "MCP & tooling", q: "topic:mcp stars:>300" },
    ],
  },
  dev: {
    fa: "توسعه و زیرساخت", en: "Dev & Infra", icon: "⚙️",
    subs: [
      { fa: "کانتینر و Kubernetes", en: "Containers / K8s", q: "topic:kubernetes stars:>3000" },
      { fa: "دواپس و CI/CD", en: "DevOps / CI", q: "topic:devops OR topic:ci-cd stars:>1500" },
      { fa: "مونیتورینگ و مشاهده‌پذیری", en: "Observability", q: "topic:monitoring OR topic:observability stars:>1500" },
      { fa: "دیتابیس و ذخیره‌سازی", en: "Databases", q: "topic:database stars:>3000" },
      { fa: "ترمینال و CLI", en: "Terminal / CLI", q: "topic:cli topic:terminal stars:>2000" },
      { fa: "سرورلس و Edge", en: "Serverless / edge", q: "topic:serverless stars:>1000" },
      { fa: "آی‌اوپی و تیونینگ", en: "Linux tuning", q: "linux kernel OR sysctl topic:performance stars:>500" },
      { fa: "خودمیزبان", en: "Self-hosted", q: "topic:self-hosted stars:>1500" },
    ],
  },
  sec: {
    fa: "امنیت و حریم خصوصی", en: "Security & Privacy", icon: "🛡",
    subs: [
      { fa: "تست نفوذ", en: "Pentest", q: "topic:pentesting stars:>2000" },
      { fa: "آنتی‌فیلتر و پروکسی", en: "Anti-censorship", q: "topic:proxy OR topic:xray OR topic:v2ray stars:>500" },
      { fa: "اسکنر آسیب‌پذیری", en: "Vuln scanners", q: "topic:vulnerability-scanner stars:>800" },
      { fa: "رمزنگاری", en: "Cryptography", q: "topic:cryptography stars:>2000" },
      { fa: "حریم خصوصی", en: "Privacy tools", q: "topic:privacy stars:>2000" },
      { fa: "شناسایی تهدید", en: "Threat intel", q: "topic:threat-intelligence stars:>500" },
    ],
  },
  web: {
    fa: "وب و فرانت‌اند", en: "Web & Frontend", icon: "🎨",
    subs: [
      { fa: "ری‌اکت و نکست", en: "React / Next", q: "react OR nextjs stars:>10000" },
      { fa: "Vue و Svelte", en: "Vue / Svelte", q: "vue OR svelte stars:>5000" },
      { fa: "کامپوننت و UI کیت", en: "UI kits", q: "topic:ui-components stars:>2000" },
      { fa: "CSS و انیمیشن", en: "CSS / animation", q: "topic:css stars:>5000" },
      { fa: "فریم‌ورک‌های بک‌اند", en: "Backend frameworks", q: "topic:backend-framework stars:>2000" },
      { fa: "وب‌اسembly", en: "WebAssembly", q: "topic:webassembly stars:>1500" },
    ],
  },
  mobile: {
    fa: "موبایل و دسکتاپ", en: "Mobile & Desktop", icon: "📱",
    subs: [
      { fa: "فلاتر", en: "Flutter", q: "topic:flutter stars:>3000" },
      { fa: "ری‌اکت نیتیو", en: "React Native", q: "topic:react-native stars:>3000" },
      { fa: "سوئیفت و آی‌اواس", en: "Swift / iOS", q: "language:swift stars:>2000" },
      { fa: "کاتلین و اندروید", en: "Kotlin / Android", q: "language:kotlin stars:>2000" },
      { fa: "الکترون و توری", en: "Electron / Tauri", q: "electron OR tauri stars:>2000" },
    ],
  },
  data: {
    fa: "داده و علم داده", en: "Data & Science", icon: "📊",
    subs: [
      { fa: "نوت‌بوک و آموزش داده", en: "Notebooks / ML", q: "topic:jupyter-notebook stars:>2000" },
      { fa: "پردازش داده", en: "Data engineering", q: "topic:data-engineering OR topic:etl stars:>1000" },
      { fa: "مصورسازی", en: "Visualization", q: "topic:visualization stars:>3000" },
      { fa: "استریم و صف", en: "Streaming", q: "topic:kafka OR topic:streaming stars:>1500" },
    ],
  },
  osint: {
    fa: "OSINT و رصد", en: "OSINT & Recon", icon: "🕵️",
    subs: [
      { fa: "ابزارهای OSINT", en: "OSINT tooling", q: "topic:osint stars:>500" },
      { fa: "اسکرپینگ", en: "Scraping", q: "topic:scraper stars:>1000" },
      { fa: "تحلیل شبکه و IP", en: "Network intel", q: "ip geolocation OR asn lookup stars:>200" },
      { fa: "جست‌وجوی اطلاعات", en: "People search", q: "topic:username OR topic:people-search stars:>300" },
    ],
  },
  game: {
    fa: "بازی و گرافیک", en: "Games & Graphics", icon: "🎮",
    subs: [
      { fa: "موتورهای بازی", en: "Game engines", q: "topic:game-engine stars:>2000" },
      { fa: "گرافیک و رندر", en: "Graphics / render", q: "topic:graphics OR topic:rendering stars:>1500" },
      { fa: "بازی‌های اوپن‌سورس", en: "Open-source games", q: "topic:game stars:>1000" },
      { fa: "شیدر و WebGL", en: "Shaders / WebGL", q: "topic:shaders OR topic:webgl stars:>700" },
    ],
  },
  tools: {
    fa: "ابزارهای بهره‌وری", en: "Productivity", icon: "🧰",
    subs: [
      { fa: "کانفیگ و داتفایل", en: "Dotfiles", q: "topic:dotfiles stars:>3000" },
      { fa: "مرورگر و اکستنشن", en: "Extensions", q: "topic:browser-extension stars:>1000" },
      { fa: "اتوماسیون", en: "Automation", q: "topic:automation stars:>3000" },
      { fa: "آفیس و فایل", en: "Office / files", q: "topic:productivity stars:>2000" },
    ],
  },
};

export class BrowseFeature {
  async menu(h: H) {
    const fa = h.loc === "fa";
    const entries = Object.entries(TREE);
    await h.reply(
      `🗂 <b>${fa ? "مرور پروژه‌ها" : "Browse"}</b>\n\n` + (fa
        ? "دسته‌بندی‌های تخصصی لنز — هر زیرشاخه یک کوئری هوشمند و رتبه‌بندی‌شده است."
        : "Lens categories — every subcategory is a smart, ranked query."),
      kb(
        ...chunk(entries, 2).map((row) => row.map(([key, v]) => ({ text: `${v.icon} ${fa ? v.fa : v.en}`, cb: `b:c:${key}` }))),
        [
          { text: "🏢 " + (fa ? "سازمان‌ها" : "Organizations"), cb: "b:orgs" },
          { text: "👤 " + (fa ? "توسعه‌دهنده‌ها" : "Developers"), cb: "b:users" },
        ],
        [
          { text: "🕰 " + (fa ? "سفر در زمان" : "Time travel"), cb: "b:time" },
          { text: "🏅 " + (fa ? "لیست‌های Awesome" : "Awesome lists"), cb: "b:awesome" },
        ],
        [{ text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  async category(h: H, key: string) {
    const cat = TREE[key];
    if (!cat) return this.menu(h);
    const fa = h.loc === "fa";
    await h.reply(
      `${cat.icon} <b>${fa ? cat.fa : cat.en}</b>\n\n${fa ? "زیرشاخه را انتخاب کن:" : "Choose a subcategory:"}`,
      kb(
        ...cat.subs.map((s) => [{ text: `▪️ ${fa ? s.fa : s.en}`, cb: `b:s:${enc(s.q)}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:menu" }],
      ),
      !!h.cbId,
    );
  }

  /** Paginated list for an arbitrary query (used by browse + saved searches). */
  async list(h: H, query: string, page = 0, sort: "stars" | "updated" | "forks" = "stars") {
    const fa = h.loc === "fa";
    const q = decode(query);
    const res = await h.gh().searchRepos(q, sort, "desc", 10, page + 1).catch(() => null);
    const items = res?.items ?? [];
    if (!items.length) {
      return h.reply(fa ? "🫙 نتیجه‌ای نبود." : "No results.", kb([{ text: "◀️", cb: "b:menu" }]), !!h.cbId);
    }
    const head = `🗂 <b>${fa ? "نتایج" : "Results"}</b> · <code>${tgEscape(q.slice(0, 90))}</code>\n` +
      `<i>${fmt(res?.total_count ?? 0)} ${fa ? "مخزن" : "repos"}</i>\n\n`;
    const body = items.map((r: any, i2: number) =>
      `<b>${page * 10 + i2 + 1}. ${tgEscape(r.full_name)}</b>\n` +
      (r.description ? `   ${i(truncate(r.description, 100))}\n` : "") +
      `   ⭐ ${fmt(r.stargazers_count)} · 🍴 ${fmt(r.forks_count)}${r.language ? ` · 🧩 ${tgEscape(r.language)}` : ""} · 🕒 ${rel(r.pushed_at, fa)}\n` +
      (r.topics?.length ? `   ${r.topics.slice(0, 4).map((t: string) => code("#" + t)).join(" ")}\n` : ""),
    ).join("\n");
    const totalPages = Math.min(20, Math.ceil((res?.total_count ?? 0) / 10));
    await h.reply(
      head + body,
      kb(
        ...items.slice(0, 6).map((r: any, i2: number) => [{ text: `${page * 10 + i2 + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        pager("b", "l", page, totalPages, [query, sort]),
        [
          { text: (sort === "stars" ? "✅ " : "") + "⭐ " + (fa ? "ستاره" : "Stars"), cb: `b:l:0,${query},stars` },
          { text: (sort === "updated" ? "✅ " : "") + "🕒 " + (fa ? "جدید" : "Updated"), cb: `b:l:0,${query},updated` },
          { text: (sort === "forks" ? "✅ " : "") + "🍴 " + (fa ? "فورک" : "Forks"), cb: `b:l:0,${query},forks` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:menu" }],
      ),
      !!h.cbId,
    );
  }

  /**
   * Developers board — the people behind the ecosystem.
   * Ranks by followers inside the user's own interests when they set any, so
   * "developers" is personal instead of a generic leaderboard.
   */
  async users(h: H, page = 0) {
    const fa = h.loc === "fa";
    await h.loading?.(fa ? "👤 در حال جمع‌آوری توسعه‌دهنده‌ها…" : "👤 collecting developers…");
    const interests: string[] = (() => {
      try { return JSON.parse((h.user?.interests as string) ?? "[]"); } catch { return []; }
    })();
    const langs = interests.filter((i) => /^(js|ts|python|go|rust|java|c|cpp|ruby|php|kotlin|swift|csharp)$/i.test(i));
    const q = langs.length
      ? langs.slice(0, 2).map((l) => `language:${l}`).join(" ") + " followers:>2000"
      : "followers:>80000 type:user";
    const res = await h.gh().searchUsers(q, page).catch(() => null);
    const items = (res?.items ?? []) as any[];
    if (!items.length) {
      return h.reply(fa ? "چیزی پیدا نشد — بعداً دوباره بزن." : "nothing found.", kb([{ text: "◀️", cb: "b:menu" }]), !!h.cbId);
    }
    const rows = await Promise.all(items.slice(0, 8).map(async (u) => {
      const full = await h.gh().get<any>(`/users/${u.login}`, 3600).catch(() => null);
      return { u, full };
    }));
    const lines = rows.map((r, i) => {
      const f = r.full ?? {};
      const bits = [
        `👥 ${fmt(f.followers ?? 0)}`,
        f.public_repos != null ? `📦 ${fmt(f.public_repos)}` : "",
        f.location ? `📍 ${tgEscape(String(f.location).slice(0, 24))}` : "",
      ].filter(Boolean).join(" · ");
      return `${i + 1}. <a href="https://github.com/${r.u.login}">${tgEscape(r.u.login)}</a>` +
        (f.name ? ` — ${tgEscape(String(f.name).slice(0, 40))}` : "") + `\n   ${bits}` +
        (f.bio ? `\n   <i>${tgEscape(String(f.bio).slice(0, 110))}</i>` : "");
    });
    return h.reply(
      `👤 <b>${fa ? "توسعه‌دهنده‌ها" : "Developers"}</b>` +
        (langs.length ? ` · ${fa ? "بر پایه علاقه‌مندی‌ها" : "by your interests"}: ${langs.join(", ")}` : "") +
        `\n\n${lines.join("\n\n")}`,
      kb(
        [...items.slice(0, 5).map((u) => [{ text: `👤 ${u.login}`, url: `https://github.com/${u.login}` }])],
        [
          { text: "🎯 " + (fa ? "علاقه‌مندی‌هایم" : "My interests"), cb: "me:interests" },
          { text: "🔁 " + (fa ? "صفحه بعد" : "Next"), cb: `b:users:${page + 1}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:menu" }, { text: "🏠", cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  async orgs(h: H) {
    const fa = h.loc === "fa";
    const orgs: [string, string][] = [
      ["cloudflare", "☁️ Cloudflare"], ["microsoft", "🪟 Microsoft"], ["google", "🔵 Google"],
      ["facebook", "🔷 Meta"], ["openai", "🧠 OpenAI"], ["vercel", "▲ Vercel"],
      ["github", "🐙 GitHub"], ["mozilla", "🦊 Mozilla"], ["apache", "🪶 Apache"],
      ["Netflix", "🎬 Netflix"], ["Uber", "🚗 Uber"], ["airbnb", "🏠 Airbnb"],
      ["alibaba", "🅰️ Alibaba"], ["huggingface", "🤗 Hugging Face"], ["supabase", "⚡ Supabase"],
      ["torvalds", "🐧 Linus Torvalds"], ["sindresorhus", "😺 Sindre Sorhus"], ["antfu", "🎨 Anthony Fu"],
    ];
    await h.reply(
      `🏢 <b>${fa ? "سازمان‌ها و افراد برجسته" : "Organizations & people"}</b>`,
      kb(
        ...chunk(orgs, 3).map((row) => row.map(([login, label]) => ({ text: label, cb: `b:org:${login}` }))),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:menu" }],
      ),
      !!h.cbId,
    );
  }

  async org(h: H, login: string) {
    return this.profileListing(h, login);
  }

  async profileListing(h: H, login: string) {
    const fa = h.loc === "fa";
    const gh = h.gh();
    const [user, repos] = await Promise.all([
      gh.get(`/users/${login}`, 3600).catch(() => null),
      gh.searchRepos(`user:${login}`, "stars", "desc", 10).catch(() => null),
    ]);
    if (!user) return h.reply(fa ? "پیدا نشد." : "Not found.", kb([{ text: "◀️", cb: "b:orgs" }]), !!h.cbId);
    const items = repos?.items ?? [];
    const body = items.map((r: any, i2: number) =>
      `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stargazers_count)}${r.language ? ` · ${tgEscape(r.language)}` : ""}`).join("\n");
    await h.reply(
      `👤 <b>${tgEscape(user.name ?? user.login)}</b> <code>@${tgEscape(user.login)}</code>\n` +
        `${user.bio ? i(user.bio) + "\n" : ""}` +
        `👥 ${fmt(user.followers)} ${fa ? "دنبال‌کننده" : "followers"} · 📦 ${user.public_repos} ${fa ? "مخزن" : "repos"}\n` +
        `📍 ${tgEscape(user.location ?? "—")}\n\n` +
        `<b>${fa ? "محبوب‌ترین مخازن" : "Top repositories"}</b>\n${body}`,
      kb(
        ...items.slice(0, 6).map((r: any) => [{ text: `📦 ${r.name}`, cb: `s:go:${r.full_name}` }]),
        [{ text: "🌐 GitHub", url: user.html_url }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:orgs" }],
      ),
      !!h.cbId,
    );
  }

  /** Time travel: what was trending in a given year (nostalgia + archaeology). */
  async time(h: H) {
    const fa = h.loc === "fa";
    const years = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2018, 2015, 2012, 2008];
    await h.reply(
      `🕰 <b>${fa ? "سفر در زمان گیت‌هاب" : "GitHub time travel"}</b>\n\n` +
        (fa ? "ببین در هر سال چه چیزی موج می‌زد (مخازنی که آن سال ساخته شدند و بیشترین ستاره را دارند)." : "The biggest projects born in each year."),
      kb(
        ...chunk(years.map((y) => [String(y), String(y)] as [string, string]), 4).map((row) =>
          row.map(([label, y]) => ({ text: `📅 ${label}`, cb: `b:year:${y}` }))),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "b:menu" }],
      ),
      !!h.cbId,
    );
  }

  async year(h: H, year: number) {
    const q = `created:${year}-01-01..${year}-12-31 stars:>5000`;
    await this.list(h, enc(q), 0, "stars");
  }

  /** Mine awesome-list repos: extract linked projects from README tables/lists. */
  async awesome(h: H, full = "sindresorhus/awesome") {
    const fa = h.loc === "fa";
    const raw = await h.gh().fileRaw(full, "readme.md").catch(() => null) ?? await h.gh().fileRaw(full, "README.md").catch(() => null);
    if (!raw?.content) return h.reply(fa ? "README پیدا نشد." : "README not found.", kb([{ text: "◀️", cb: "b:menu" }]), !!h.cbId);
    const md = atob(raw.content.replace(/\n/g, "")).slice(0, 200_000);
    const links = [...md.matchAll(/\[([^\]]{2,60})\]\((https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+)\)/g)]
      .map((m) => ({ title: m[1], url: m[2] }))
      .filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i)
      .slice(0, 40);
    await h.reply(
      `🏅 <b>${tgEscape(full)}</b> — ${links.length} ${fa ? "پروژه استخراج شد" : "projects extracted"}\n` +
        (fa ? "<i>روی هرکدام بزن تا کارت کامل باز شود.</i>" : ""),
      kb(
        ...links.slice(0, 20).map((l) => [{ text: truncate(l.title, 40), cb: `s:go:${l.url.replace("https://github.com/", "")}` }]),
        [{ text: "🎲 " + (fa ? "یکی تصادفی" : "Random"), cb: "x:random" }],
      ),
      !!h.cbId,
    );
  }
}

function enc(s: string) { return encodeURIComponent(s).replace(/%/g, "_").slice(0, 40); }
function decode(s: string) { return decodeURIComponent(s.replace(/_/g, "%")); }
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function chunk<T>(arr: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
