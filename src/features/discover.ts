import type { H } from "../core/handler";
import { GithubRest, healthScore } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { fmt, normalise, rel, truncate } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";
import { extractKeywords } from "../search/keywords";

/**
 * DISCOVERY ENGINE — the "you didn't know you needed this" part of the bot.
 *
 *  • hidden gems  — high health, low stars (before they explode)
 *  • random       — weighted by your interests, never the same twice
 *  • similar      — co-star graph + topic/language overlap
 *  • trending map — where the whole ecosystem is moving this week
 *  • share cards  — screenshot-style PNG via Browser Rendering
 */
export class Discover {
  /** Hidden gems: quality over hype. Fresh repos with great hygiene and few stars. */
  async gems(h: H, page = 0) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "✨ در حال کاوش گنج‌های پنهان…" : "✨ finding hidden gems…");
    const since = new Date(Date.now() - 240 * 86400000).toISOString().slice(0, 10);
    const res = await h.gh().searchRepos(`stars:50..800 pushed:>${iso(-30)} created:>${since} archived:false`, "updated", "desc", 30, 1).catch(() => null);
    let items = res?.items ?? [];
    if (!items.length) return h.reply(fa ? "چیزی پیدا نشد." : "Nothing found.", kb([]), !!h.cbId);

    // re-rank locally by a quality/obscurity blend
    const scored = items.map((r: any) => {
      const health = healthScore({
        stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count,
        pushed_at: r.pushed_at, created_at: r.created_at, license: r.license?.spdx_id, archived: r.archived,
        description: r.description, has_readme: true, contributors: 5, commits_last_year: 40, releases_last_year: 2,
      });
      const ageDays = (Date.now() - Date.parse(r.created_at)) / 86400000;
      const perDay = r.stargazers_count / Math.max(1, ageDays);
      const gem = health * 1.4 + perDay * 6 - Math.log10(r.stargazers_count + 1) * 8;
      return { ...r, health, perDay: Math.round(perDay * 100) / 100, gem: Math.round(gem * 10) / 10 };
    }).sort((a: any, b: any) => b.gem - a.gem);

    const slice = scored.slice(page * 8, page * 8 + 8);
    const body = slice.map((r: any, i2: number) =>
      `${page * 8 + i2 + 1}. <b>${tgEscape(r.full_name)}</b> — ${fa ? "نگین" : "gem"} <b>${r.gem}</b>\n` +
      `   ⭐ ${fmt(r.stargazers_count)} (${r.perDay}/day) · ❤️ ${r.health}/100 · 🧩 ${tgEscape(r.language ?? "—")}\n` +
      `   ${i(truncate(r.description ?? "", 95))}\n` +
      `   ${(r.topics ?? []).slice(0, 4).map((t: string) => code("#" + t)).join(" ")}`).join("\n\n");

    await h.reply(
      `✨ <b>${fa ? "گنج‌های پنهان" : "Hidden gems"}</b>\n<i>${fa ? "کیفیت بالا، شهرت کم — قبل از انفجار ستاره‌ای" : "high quality, low hype"}</i>\n\n${body}`,
      kb(
        ...slice.slice(0, 6).map((r: any, i2: number) => [{ text: `${page * 8 + i2 + 1}. ${r.full_name}`, cb: `s:go:${r.full_name}` }]),
        [
          { text: "➡️ " + (fa ? "بعدی" : "More"), cb: `x:gems:${page + 1}` },

        ],
        
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "gems", `page${page}`);
  }

  /** Random repo, weighted by the user's interests & favourite languages. */
  async random(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const interests: string[] = safeJson(u?.interests) ?? [];
    const pool: string[] = [];
    if (interests.length) {
      const pick = interests[Math.floor(Math.random() * interests.length)];
      pool.push(`topic:${pick} stars:>200`);
    }
    const stars = [50, 200, 1000, 5000, 20000][Math.floor(Math.random() * 5)];
    pool.push(`stars:>${stars}`);

    /* GitHub search is flaky at random offsets (it caps at 1000 results and
     * 422s on odd window/page combinations). Degrade instead of apologising:
     * page 1 with the user's pool → page 1, plain window → star-window only →
     * a guaranteed-populated "pushed this year" query. */
    const attempts: Array<() => Promise<any>> = [
      () => h.gh().searchRepos(pool.join(" "), "stars", "desc", 30, Math.floor(Math.random() * 5) + 1),
      () => h.gh().searchRepos(pool.join(" "), "stars", "desc", 30, 1),
      () => h.gh().searchRepos(`stars:>${stars}`, "stars", "desc", 30, 1),
      () => h.gh().searchRepos("stars:>1000 pushed:>2026-01-01", "stars", "desc", 30, 1),
    ];
    let items: any[] = [];
    for (const attempt of attempts) {
      const res = await attempt().catch(() => null);
      items = res?.items ?? [];
      if (items.length) break;
    }
    if (!items.length) return h.reply(fa ? "🎲 چیزی پیدا نشد، دوباره بزن." : "Nothing found.", kb([[{ text: "🎲 " + (fa ? "دوباره" : "Again"), cb: "x:random" }]]), !!h.cbId);
    const r = items[Math.floor(Math.random() * items.length)];
    const meta = normalise({ ...r, full_name: r.full_name, stars: r.stargazers_count, forks: r.forks_count, issues: r.open_issues_count, topics: r.topics ?? [], languages: [], health: 0, redFlags: [], raw: r });
    const card = await h.card.render(meta, { loc: h.loc });
    /* The rich card carries its own heading, so the «کشف تصادفی» banner rides
       above it as a kicker line instead of being glued onto the plain text. */
    const { aside } = await import("../tg/rich");
    await h.replyRich(
      aside(`🎲 ${fa ? "کشف تصادفی" : "Random discovery"}`) + (card.rich ?? card.text),
      kb(
        [
          { text: "🎲 " + (fa ? "یکی دیگر" : "Another"), cb: "x:random" },
          { text: "✨ " + (fa ? "گنج‌های پنهان" : "Hidden gems"), cb: "x:gems" },
        ],
        ...card.keyboard.inline_keyboard.slice(2, 6),

      ),
      !!h.cbId,
    );
  }

  /** Similar repos: co-star graph first, then topic/language overlap from GitHub. */
  /**
   * «مشابه» — co-star graph first, then a real search ladder.
   *
   * The old fallback built `topic:a OR topic:b OR language:x stars:>500`, which
   * GitHub answers with nothing (qualifiers are ANDed, not ORed), so the card
   * rendered as a bare dash. Now each attempt is a query GitHub actually
   * accepts, and the source of the list is stated honestly.
   */
  async similar(h: H, full: string) {
    const fa = h.loc === "fa";
    const coStar = await h.store.similar(full, 8).catch(() => [] as any[]);
    let rows: any[] = coStar.map((c: any) => ({ full_name: c.full_name, weight: c.weight }));
    let source = fa ? "گراف «کسانی که این را ستاره کردند»" : "co-star graph";

    if (rows.length < 4) {
      // the repo itself, live if we have no local copy
      const meta: any = (await h.store.repoFresh(full, 86400).catch(() => null)) ?? (await h.gh().repo(full, 600).catch(() => null));
      const topics: string[] = safeJson(meta?.topics) ?? [];
      const lang: string | null = meta?.language ?? null;
      const words = extractKeywords(String(meta?.description ?? ""), 4);
      const seen = new Set(rows.map((r) => r.full_name));
      const ladder = [
        topics[0] && lang ? `topic:${topics[0]} language:${lang}` : "",
        topics[0] ? `topic:${topics[0]}` : "",
        topics[0] ? `topic:${topics[0]} stars:>50` : "",
        lang ? `language:${lang} stars:>2000` : "",
        words.length >= 2 ? `${words.slice(0, 2).join(" ")}` : "",
        words[0] ? `${words[0]}` : "",
        "stars:>5000",
      ].filter(Boolean) as string[];

      for (const q of ladder) {
        const res = await h.gh().searchRepos(q, "stars", "desc", 12).catch(() => null);
        const items = (res?.items ?? []).filter((r: any) => r.full_name !== full);
        if (items.length) {
          rows = items.map((r: any) => ({ full_name: r.full_name, stars: r.stargazers_count, description: r.description, language: r.language }));
          source = words.length && q.includes(words[0])
            ? (fa ? `هم‌موضوعی بر پایهٔ «${words.slice(0, 2).join("، ")}»` : `same topic: ${words.slice(0, 2).join(", ")}`)
            : lang && q.includes("language:") ? (fa ? `هم‌زبانی (${lang})` : `same language (${lang})`)
            : (fa ? "محبوب‌های گیت‌هاب (نمونهٔ گسترده‌تر)" : "popular on GitHub (broader list)");
          break;
        }
      }
    }
    const unique = rows.filter((r, i) => rows.findIndex((x) => x.full_name === r.full_name) === i).slice(0, 10);

    const body = unique.map((r: any, i2: number) =>
      `${i2 + 1}. <b>${tgEscape(r.full_name)}</b>${r.stars ? ` — ⭐ ${fmt(r.stars)}` : ""}${r.language ? ` · ${tgEscape(r.language)}` : ""}\n` +
      (r.description ? `   ${i(truncate(r.description, 90))}` : "")).join("\n");

    await h.reply(
      `✨ <b>${fa ? "مشابه" : "Similar to"} ${tgEscape(full)}</b>\n<i>${source}</i>\n\n` +
        (body || (fa ? "چیزی پیدا نشد — دوباره بزن." : "nothing found — try again.")),
      kb(
        ...unique.slice(0, 6).map((r: any) => [{ text: `📦 ${r.full_name}`.slice(0, 42), cb: `s:go:${r.full_name}` }]),
        [
          { text: "🎲 " + (fa ? "تصادفی" : "Random"), cb: "x:random" },
          { text: "⚖️ " + (fa ? "مقایسه" : "Compare"), cb: `s:cmp:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  /** Star-growth chart for a single repo (from our own snapshots). */
  async chart(h: H, full: string) {
    const fa = h.loc === "fa";
    const eng = new TrendingEngine(h.env);
    const hist = await eng.history(full, 180);
    if (!hist.rows.length) {
      const meta = await h.store.repoFresh(full, 600);
      return h.reply(
        `📈 <b>${tgEscape(full)}</b>\n\n` +
          (fa ? "هنوز اسنپ‌شاتی برای این مخزن ندارم. با اشتراک، هر ۱۵ دقیقه رصدش می‌کنم و از فردا نمودار داری.\n\n" : "No snapshots yet — subscribe to start tracking.\n\n") +
          `⭐ ${fa ? "اکنون" : "now"}: <b>${fmt(meta?.stars ?? 0)}</b>`,
        kb([[{ text: "🔔 " + (fa ? "رصد کن" : "Track"), cb: `sub:add:${full}` }, { text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }]]),
        !!h.cbId,
      );
    }
    const values = hist.rows.map((r) => r.stars);
    const rows = 10;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const W = 28;
    const sampled = Array.from({ length: W }, (_, i) => values[Math.floor((i / (W - 1)) * (values.length - 1))] ?? min);
    const grid = Array.from({ length: rows }, (_, ri) => {
      const level = max - (ri / (rows - 1)) * span;
      return sampled.map((v) => (v >= level ? "█" : " ")).join("");
    }).join("\n");
    const total = values.at(-1)! - values[0];
    const span2 = hist.rows.length;

    await h.reply(
      `📈 <b>${tgEscape(full)}</b> — ${fa ? `رشد ${span2} روز` : `${span2}d growth`}\n\n` +
        `<pre>${grid}\n${"─".repeat(W)}\n${min.toLocaleString()} → ${max.toLocaleString()}</pre>\n` +
        `📊 ${fa ? "تغییر" : "delta"}: <b>${total >= 0 ? "+" : ""}${fmt(total)}</b> ⭐  (${((total / Math.max(1, span2)) * 1).toFixed(1)}/day)\n` +
        (hist.spark ? `🧬 ۳۰ روز آخر: <code>${hist.spark}</code>\n` : "") +
        `🗓 ${fa ? "روزهای ثبت‌شده" : "snapshots"}: ${hist.rows.length}`,
      kb(
        [
          { text: "🔔 " + (fa ? "رصد" : "Track"), cb: `sub:add:${full}` },
          { text: "🛰 " + (fa ? "کاوش" : "Scout"), cb: `s:go:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  /** File browser: navigate the repository tree from inside Telegram. */
  async files(h: H, full: string, path = "") {
    const fa = h.loc === "fa";
    const gh = new GithubRest(h.env);
    const listing = await gh.contents(full, path, 900).catch(() => null);
    if (!listing) return h.reply(fa ? "❌ پوشه خوانده نشد." : "❌ unreadable", kb([{ text: "◀️", cb: `s:card:${full}` }]), true);

    if (!Array.isArray(listing)) {
      // a single file → preview
      const f: any = listing;
      if (f.size > 200_000) return h.reply(`📄 <b>${tgEscape(f.name)}</b> — ${(f.size / 1024).toFixed(0)} KB\n<i>${fa ? "برای مشاهده، لینک گیت‌هاب" : "open on GitHub"}</i>`, kb([{ text: "🌐 GitHub", url: f.html_url }]));
      const raw = await gh.fileRaw(full, f.path).catch(() => null);
      const content = raw?.content ? atob(raw.content.replace(/\n/g, "")).slice(0, 3000) : "";
      return h.reply(
        `📄 <b>${tgEscape(f.path)}</b>\n<pre>${tgEscape(content)}</pre>`,
        kb(
          [
            { text: "🌐 GitHub", url: f.html_url },
            { text: "⬆️ " + (fa ? "بالا" : "Up"), cb: `r:files:${full}${pathOf(path)}` },
          ],
          [{ text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
        ),
        !!h.cbId,
      );
    }

    const dirs = listing.filter((x: any) => x.type === "dir").slice(0, 10);
    const files2 = listing.filter((x: any) => x.type === "file").slice(0, 14);
    const icon = (n: string) =>
      /\.(md|txt)$/i.test(n) ? "📝" : /\.(json|ya?ml|toml)$/i.test(n) ? "🧾" : /\.(ts|js|py|go|rs|java|c|cpp|rb|php|swift|kt)$/i.test(n) ? "📜" :
      /\.(png|jpe?g|svg|gif|webp)$/i.test(n) ? "🖼" : /docker/i.test(n) ? "🐳" : /license/i.test(n) ? "⚖️" : "📄";

    await h.reply(
      `🗂 <b>${tgEscape(full)}</b>${path ? ` / <code>${tgEscape(path)}</code>` : " /"}\n\n` +
        (dirs.length ? `📁 ${dirs.map((d: any) => `<code>${tgEscape(d.name)}/</code>`).join("  ")}\n\n` : "") +
        files2.map((f: any) => `${icon(f.name)} <code>${tgEscape(f.name)}</code> <i>${(f.size / 1024).toFixed(1)}KB</i>`).join("\n") +
        `\n\n📥 ${fa ? "دانلود کل مخزن" : "download whole repo"}: /dl ${tgEscape(full)}`,
      kb(
        ...dirs.slice(0, 6).map((d: any) => [{ text: `📁 ${d.name}`, cb: `r:files:${full}${path ? path + "/" : ""}${d.name}` }]),
        ...files2.slice(0, 6).map((f: any) => [{ text: `${icon(f.name)} ${truncate(f.name, 34)}`, cb: `r:files:${full}${path ? path + "/" : ""}${f.name}` }]),
        [
          { text: path ? "⬆️ " + (fa ? "پوشه بالا" : "Up") : "🌐 GitHub", ...(path ? { cb: `r:files:${full}${pathOf(path)}` } : { url: `https://github.com/${full}` }) },
          { text: "📥 " + (fa ? "دانلود" : "Download"), cb: `d:repo:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "کارت" : "Card"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  /** Share card: PNG screenshot of a generated HTML card via Browser Rendering. */
  async shareCard(h: H, full: string) {
    const fa = h.loc === "fa";
    const meta: any = await h.store.repoFresh(full, 900);
    if (!meta) return h.reply(fa ? "❌ پیدا نشد." : "❌ not found", kb([]), !!h.cbId);

    const url = `${h.env.WORKER_URL}/api/card?repo=${encodeURIComponent(full)}&v=2`;
    if (h.env.BROWSER) {
      await h.loading(fa ? "🖼 در حال ساخت کارت تصویری…" : "🖼 rendering card…");
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${h.env.CF_ACCOUNT_ID}/browser-rendering/screenshot`, {
          method: "POST",
          headers: { authorization: `Bearer ${h.env.CF_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ url, viewport: { width: 1200, height: 630 }, screenshotOptions: { type: "png" } }),
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          await h.tg.sendPhoto(h.chatId, buf, `🖼 <b>${tgEscape(full)}</b> — ⭐ ${fmt(meta.stars)} · ❤️ ${meta.health_score ?? 0}/100`, {
            parse_mode: "HTML",
            reply_markup: kb(
              [{ text: "🌐 " + (fa ? "باز کردن" : "Open"), url: `https://github.com/${full}` }],
              [{ text: "📤 " + (fa ? "اشتراک‌گذاری" : "Share"), url: `https://t.me/share/url?url=${encodeURIComponent(`https://github.com/${full}`)}&text=${encodeURIComponent(full)}` }],
            ),
          });
          await h.store.event(h.u.id, "share_card", full);
          return;
        }
      } catch { /* fall through to link */ }
    }
    // fallback: link to the live HTML card
    await h.reply(
      `🖼 <b>${tgEscape(full)}</b>\n\n${fa ? "کارت تصویری آنلاین" : "Online share card"}: ${url}`,
      kb([{ text: "🔗 " + (fa ? "باز کردن کارت" : "Open card"), url }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]),
      !!h.cbId,
    );
  }

  /** Ecosystem map: which topics are heating up this week across tracked repos. */
  async map(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT payload FROM trending WHERE period='weekly' AND language='all' AND day=(SELECT MAX(day) FROM trending WHERE period='weekly') ORDER BY rank LIMIT 40`,
    ).all<{ payload: string }>().catch(() => ({ results: [] as any[] }));
    const topics = new Map<string, number>();
    for (const row of results ?? []) {
      try {
        const r = JSON.parse(row.payload);
        for (const t of r.topics ?? []) topics.set(t, (topics.get(t) ?? 0) + 1);
      } catch { /* skip */ }
    }
    const top = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    const max = top[0]?.[1] ?? 1;
    await h.reply(
      `🗺 <b>${fa ? "نقشه اکوسیستم این هفته" : "Ecosystem map (this week)"}</b>\n` +
        `<i>${fa ? "موضوعاتی که در مخازن در حال رشد بیشترین تکرار را دارند" : "topics with the strongest presence in rising repos"}</i>\n\n<pre>` +
        tgEscape(top.map(([t, c]) => `${t.padEnd(18, " ")} ${"█".repeat(Math.round((c / max) * 16))} ${c}`).join("\n")) +
        `</pre>`,
      kb(
        ...top.slice(0, 6).map(([t]) => [{ text: `#${t}`, cb: `b:s:${encodeURIComponent(`topic:${t} stars:>300`).replace(/%/g, "_")}` }]),
      ),
      !!h.cbId,
    );
  }
}

function pathOf(path: string) { const parts = path.split("/"); parts.pop(); return parts.length ? "/" + parts.join("/") : ""; }
function iso(days: number) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function safeJson(s: string | null | undefined): any[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
