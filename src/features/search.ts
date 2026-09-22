import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import type { Env } from "../env";
import { VectorIndex } from "../ai/vector";
import { extractKeywords, scoreMatch, searchLadder } from "../search/keywords";
import { fmt } from "./cards";
import { b, code, i, link, tgEscape } from "../tg/types";
import { kb, pager, type Loc } from "../tg/keyboards";

/**
 * Multi-modal search:
 *   1. semantic  — Vectorize over the indexed corpus (understands intent, any language)
 *   2. lexical   — GitHub search with AI-translated qualifiers
 *   3. hybrid    — RRF fusion of both (default = best results)
 *   4. natural   — plain sentences, filters like "typescript stars>5k updated this month"
 */
export class SearchFeature {
  private rest(env: Env) { return new GithubRest(env); }

  /** Turn a free-text query into GitHub qualifiers (cached per query hash by AiBrain). */
  /**
   * Free text → GitHub query.
   *
   * The AI plan is a bonus, never a dependency: if the model is unavailable
   * (spent neurons, gateway down) the offline keyword layer still produces a
   * real query, so a Persian sentence can no longer be sent to GitHub verbatim
   * and come back empty. `ladder` is the relaxation chain the caller walks.
   */
  private async buildQuery(h: H, raw: string) {
    const q = raw.trim();
    let plan: any = null;

    // explicit "owner/repo" → direct
    if (/^[\w.-]+\/[\w.-]+$/.test(q)) return { direct: q, plan: null, ladder: [] as string[] };

    const hasQualifiers = /(language:|stars:|topic:|created:|pushed:|license:|user:|org:)/i.test(q);
    if (!hasQualifiers) plan = await h.ai.plan_search(q, h.loc).catch(() => null);

    const keywords = extractKeywords(q, 8);
    const ladder = hasQualifiers
      ? [q]
      : searchLadder(q, { aiQuery: plan?.github_query ?? null, language: plan?.language ?? null });

    return { direct: null, ghQuery: ladder[0] ?? q, plan, ladder, keywords };
  }

  async run(h: H, rawQuery: string, page = 0, mode: "hybrid" | "semantic" | "lexical" = "hybrid") {
    const { direct, plan, ladder, keywords } = await this.buildQuery(h, rawQuery);

    if (direct) return this.showRepo(h, direct);

    // ── lexical: walk the relaxation ladder until GitHub answers ──
    let lexical: any[] = [];
    let usedQuery = ladder[0] ?? rawQuery;
    if (mode !== "semantic") {
      const chain = page > 0 ? [usedQuery] : ladder;
      for (const q of chain) {
        const res = await this.rest(h.env).searchRepos(q, "stars", "desc", 20, page + 1).catch(() => null);
        const items = res?.items ?? [];
        if (items.length) {
          usedQuery = q;
          lexical = items.map((r: any) => ({
            id: r.full_name, full_name: r.full_name, description: r.description, stars: r.stargazers_count,
            forks: r.forks_count, language: r.language, topics: r.topics ?? [], url: r.html_url,
            license: r.license?.spdx_id ?? null, pushed_at: r.pushed_at, score: 0, source: "lexical",
          }));
          break;
        }
      }
      if (!lexical.length) return this.emptyState(h, rawQuery, keywords);
    }

    // ── semantic ──
    let semantic: any[] = [];
    if (mode !== "lexical") {
      const vi = new VectorIndex(h.env, h.ai);
      const hits = await vi.search(rawQuery, { topK: 15 }).catch(() => []);
      semantic = hits.map((x) => ({
        id: x.id, full_name: x.id, description: "", stars: x.meta?.stars ?? 0, language: x.meta?.language,
        topics: String(x.meta?.topics ?? "").split(",").filter(Boolean), url: `https://github.com/${x.id}`,
        score: x.score, source: "semantic", license: x.meta?.license ?? null,
      }));
    }

    const merged = mode === "hybrid" ? VectorIndex.fuse(lexical, semantic) : (mode === "semantic" ? semantic : lexical);

    /* Relevance first, popularity second. GitHub hands us its own star-ordered
       page; re-scoring against the user's own keywords is what turns "similar
       things" into "the thing I asked for". Lexical results carry no semantic
       score, so they are ranked by keyword coverage and stars. */
    const scored = merged.map((r) => ({ ...r, match: scoreMatch(r, keywords ?? []) }));
    const exact = scored.filter((r) => r.match.coverage >= 0.5);
    const near = scored.filter((r) => r.match.coverage < 0.5);
    const ranked = (exact.length >= 3 ? [...exact] : [...scored])
      .sort((a, b) => (b.match.weight - a.match.weight) || ((b.stars ?? 0) - (a.stars ?? 0)));
    const top = ranked.slice(0, 10);
    if (!top.length) return this.emptyState(h, rawQuery, keywords);
    const precise = exact.length >= 3;

    const fa = h.loc === "fa";
    const aiOn = !!(plan?.github_query);
    const keywordLine = keywords?.length
      ? (fa ? `\n🔑 کلمات: <code>${keywords.slice(0, 5).join(" · ")}</code>` : `\nKeywords: <code>${keywords.slice(0, 5).join(" · ")}</code>`)
      : "";

    /* Two honest modes. With the model available the user gets the exact
       answer; with it down we say plainly that these are the closest results
       and offer the one thing that fixes it (a donated key). */
    const title = precise
      ? (fa ? "🎯 نتایج دقیق" : "🎯 Exact matches")
      : (fa ? "✨ نزدیک‌ترین نتایج" : "✨ Closest matches");
    const note = precise
      ? (aiOn
          ? (fa ? "\n<i>مرتب‌شده بر اساس تطابق با پرسش تو، نه فقط ستاره.</i>" : "")
          : (fa ? "\n<i>هوش مصنوعی در دسترس نبود، پس بر اساس کلمات کلیدی مرتب شد.</i>" : ""))
      : (fa
          ? `\n<i>چیزی که عیناً خواستی پیدا نشد؛ این‌ها نزدیک‌ترین‌ها هستند.</i>` +
            (aiOn ? "" : `\n<i>هوش مصنوعی امروز خاموش است — با یک کلید، جست‌وجو دقیق‌تر می‌شود.</i>`)
          : `\n<i>No exact match — these are the closest.</i>`);

    const header =
      `<b>${title}</b>\n` +
      (usedQuery ? `🔎 <code>${tgEscape(String(usedQuery).slice(0, 120))}</code>` : `🔎 <code>${tgEscape(rawQuery.slice(0, 120))}</code>`) +
      keywordLine + "\n" + note;

    const body = top
      .map((r, idx) => {
        const meta = [`⭐ ${fmt(r.stars)}`];
        if (r.language) meta.push(tgEscape(r.language));
        if (r.forks) meta.push(`🍴 ${fmt(r.forks)}`);
        const tags = (r.topics ?? []).slice(0, 3).map((t: string) => `#${t}`).join(" ");
        return (
          `<b>${idx + 1}. ${tgEscape(r.full_name)}</b>\n` +
          `   ${meta.join(" · ")}\n` +
          (r.description ? `   ${i(truncate(r.description, 100))}\n` : "") +
          (tags ? `   ${tags}` : "")
        ).trimEnd();
      })
      .join("\n\n");

    const rows = top.slice(0, 8).map((r, idx) => [{ text: `${idx + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]);
    const nav = pager("n", "page", page, Math.max(1, Math.ceil((lexical.length || 10) / 10)), [encodeURIComponent(rawQuery).slice(0, 30)]);
    const keyboard = kb(
      ...rows,
      nav,
      // honest escape hatch: when we could only offer "close" results, the fix
      // is one key away — put it right there instead of hiding it in a menu
      ...(precise ? [] : [aiOn
        ? [{ text: "✏️ " + (fa ? "دقیق‌تر بگو" : "Refine query"), cb: `n:search` }, { text: "🎯 " + (fa ? "فیلترها" : "Filters"), cb: `n:filters:${enc(rawQuery)}` }]
        : [{ text: "🤝 " + (fa ? "اهدا کلید برای دقت بیشتر" : "Donate a key for precision"), cb: "keys:home" }, { text: "🎯 " + (fa ? "فیلترها" : "Filters"), cb: `n:filters:${enc(rawQuery)}` }]]),
      [
        { text: "🎯 " + (fa ? "فیلترها" : "Filters"), cb: `n:filters:${enc(rawQuery)}` },
        { text: "🔔 " + (fa ? "ذخیره جست‌وجو" : "Save search"), cb: `n:save:${enc(rawQuery)}` },
      ],
      [{ text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }],
    );

    await h.store.event(h.u.id, "search", rawQuery.slice(0, 60), { mode, count: merged.length });
    await h.store.bumpLeaderboard(h.u.id, "queries");
    await h.reply(header + "\n" + body, keyboard, !!h.cbId);
  }

  private async showRepo(h: H, full: string) {
    const gh = new GithubRest(h.env);
    const m = await gh.repo(full, 300).catch(() => null);
    if (!m) return h.reply("❌ " + (h.loc === "fa" ? "مخزن یافت نشد." : "Repository not found."), undefined, !!h.cbId);
    const rendered = await h.card.render(
      { ...m, full_name: m.full_name, stars: m.stargazers_count, forks: m.forks_count, watchers: m.watchers_count, issues: m.open_issues_count, languages: [], topics: m.topics ?? [], health: 0, redFlags: [], raw: m },
      { loc: h.loc },
    );
    await h.reply(rendered.text, rendered.keyboard, !!h.cbId);
  }

  /**
   * Nothing matched — but say *why* and hand over the next step. When the
   * keyword layer produced terms, those become the one-tap retries; when the
   * words were all noise, we say so instead of blaming the user's phrasing.
   */
  private async emptyState(h: H, q: string, keywords: string[] = []) {
    const fa = h.loc === "fa";
    const alts = keywords.length
      ? keywords.slice(0, 4)
      : await h.ai
          .chat(`Suggest 3 GitHub search keywords for: "${q}". Return a JSON array of strings only.`, {
            tier: "fast", max_tokens: 120, cacheKey: `alt:${enc(q)}`, cacheTtl: 86400,
          })
          .then((raw) => {
            try { return (JSON.parse(raw.replace(/```json|```/g, "").trim()) as string[]).slice(0, 3); } catch { return ["react", "vpn", "telegram bot"]; }
          });

    await h.reply(
      `🫙 <b>${fa ? "چیزی پیدا نشد" : "Nothing found"}</b>\n\n` +
        (fa
          ? `برای «${tgEscape(q)}» نتیجه‌ای نبود.\n` +
            (keywords.length
              ? `با این کلیدواژه‌ها گشتم و چیزی نبود. یکی‌شان را جدا امتحان کن:\n`
              : `کلمه‌های پرسشت عمومی بودند. با یک اسم دقیق‌تر امتحان کن:\n`)
          : `No results for “${tgEscape(q)}”. Try one of these:\n`) +
        alts.map((a) => `• ${code(a)}`).join("\n"),
      kb(
        alts.slice(0, 4).map((a) => [{ text: `🔎 ${a.slice(0, 28)}`, cb: `n:q:${enc(a)}` }]),
        [{ text: "🔥 " + (fa ? "داغ‌ترین‌های همین حالا" : "Trending now"), cb: "t:menu" },
         { text: "✨ " + (fa ? "گنج‌ها" : "Gems"), cb: "x:gems" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "n:search" }],
      ),
      !!h.cbId,
    );
  }

  /** Global search hub with quick categories (mirrors the original's /search but smarter). */
  async hub(h: H) {
    const fa = h.loc === "fa";
    const cats: [string, string][] = [
      ["🤖 AI / LLM", "topic:llm OR topic:ai stars:>1000"],
      ["🔐 Security", "topic:security stars:>500"],
      ["🌐 VPN / Proxy", "vpn OR proxy OR xray OR sing-box stars:>300"],
      ["📱 Telegram Bots", "telegram-bot stars:>300"],
      ["🎨 Frontend UI", "topic:ui topic:components stars:>800"],
      ["⚙️ DevOps", "topic:devops OR topic:kubernetes stars:>1000"],
      ["🦀 Rust tools", "language:rust stars:>800"],
      ["🐍 Python tools", "language:python stars:>1500"],
      ["🕵️ OSINT", "topic:osint stars:>300"],
      ["💰 Fintech", "topic:fintech OR topic:trading stars:>500"],
      ["🧠 Learning", "topic:awesome stars:>3000"],
      ["🏠 Self-hosted", "topic:self-hosted stars:>800"],
    ];
    await h.reply(
      `🔎 <b>${fa ? "جست‌وجوی هوشمند" : "Smart search"}</b>\n\n` +
        (fa
          ? "هر موضوعی، به فارسی یا انگلیسی بنویس؛ خودم ترجمه، فیلتر و رتبه‌بندی می‌کنم.\nمثال: <i>«یک ابزار خوب برای مانیتورینگ سرور»</i>"
          : "Write in any language — I translate, filter and rank automatically."),
      kb(
        ...chunk(cats, 2).map((row) => row.map(([label, q]) => ({ text: label, cb: `n:advanced:${enc(q)}` }))),
        [{ text: "🎯 " + (fa ? "جست‌وجوی پیشرفته" : "Advanced filters"), cb: "n:filters:" }],
        [
          { text: "🗂 " + (fa ? "مرور دسته‌ها" : "Browse"), cb: "b:menu" },
          { text: "🔥 " + (fa ? "داغ‌ترین‌ها" : "Trending"), cb: "t:menu" },
        ],
        [{ text: "🏠 " + (fa ? "منوی اصلی" : "Main menu"), cb: "m:home" }],
      ),
    );
  }

  /** Advanced filter builder (stars / language / date / license / topic). */
  async filters(h: H, query = "") {
    const fa = h.loc === "fa";
    await h.reply(
      `🎯 <b>${fa ? "فیلترهای پیشرفته" : "Advanced filters"}</b>\n\n` +
        (fa ? "ترکیب زیر را انتخاب کن یا مستقیم عبارت بنویس:\n" : "Pick a preset or type a raw query:\n") +
        `<code>language:go stars:>2000 pushed:>2025-01-01 license:mit topic:database</code>`,
      kb(
        [
          { text: "⭐ " + (fa ? "بیش از ۱۰ هزار ستاره" : "stars > 10k"), cb: `n:advanced:stars:>10000` },
          { text: "🆕 " + (fa ? "ساخته‌شده در ۹۰ روز اخیر" : "created < 90d"), cb: `n:advanced:created:>${iso(-90)}` },
        ],
        [
          { text: "⚡ " + (fa ? "آپدیت این هفته" : "pushed this week"), cb: `n:advanced:pushed:>${iso(-7)}` },
          { text: "⚖️ MIT", cb: `n:advanced:license:mit` },
        ],
        [
          { text: "🟨 TypeScript", cb: `n:advanced:language:typescript stars:>1000` },
          { text: "🐍 Python", cb: `n:advanced:language:python stars:>1000` },
        ],
        [
          { text: "🦀 Rust", cb: `n:advanced:language:rust stars:>1000` },
          { text: "🐹 Go", cb: `n:advanced:language:go stars:>1000` },
        ],
        [
          { text: "🌱 Good first issue", cb: `n:advanced:label:"good first issue" state:open` },
          { text: "🔥 Help wanted", cb: `n:advanced:label:"help wanted" state:open` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "n:search" }],
      ),
    );
  }
}

// helper stubs so the class stays small
function enc(s: string) { return encodeURIComponent(s).replace(/%/g, "_").slice(0, 40); }
function iso(days: number) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function chunk<T>(arr: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
