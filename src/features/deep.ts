import type { H } from "../core/handler";
import { GithubGraphQL, toRepoMeta, type RepoMeta } from "../github/graphql";
import { GithubRest, bar, healthScore, sparkline } from "../github/rest";
import { TrendingEngine } from "../github/trending";
import { fmt, meterBar, rel, truncate } from "./cards";
import { b, code, i, link, pre, tgEscape } from "../tg/types";
import { kb, pager } from "../tg/keyboards";

/**
 * DEEP SCOUT — the flagship feature.
 *
 * One GraphQL round-trip (deepScout) feeds twelve specialist tabs:
 *   1. 📊 overview      2. 📈 growth & momentum    3. 🧩 language DNA
 *   4. 👥 community     5. 🚀 releases & changelog  6. 🐞 issues & triage
 *   7. 🔀 pull requests 8. 🕒 commit archaeology   9. 🏗 CI & repo hygiene
 *  10. 🛡 security      11. 📰 changelog          12. 🎯 contribution radar
 *
 * Every tab is generated from live API data (nothing fabricated) and the AI
 * layer only ever summarises numbers we actually fetched.
 */
export class DeepScout {
  constructor(private gql = GithubGraphQL) {}

  private async scout(h: H, full: string) {
    const [owner, name] = full.split("/");
    const gql = new GithubGraphQL(h.env, h.userToken ?? h.env.GITHUB_TOKEN);
    const data = await gql.deepScout(owner, name).catch(() => null);
    if (!data?.repository) return null;
    const meta = toRepoMeta(data);
    return { meta, r: data.repository };
  }

  async home(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `🛰 <b>${fa ? "کاوش عمیق" : "Deep scout"}</b>\n\n` + (fa
        ? "دوازده تب تخصصی روی هر مخزن: رشد ستاره‌ها، دی‌ان‌ای زبان‌ها، جامعه، ریلیزها، آیتم‌های باز، پول‌ریکوئست‌ها، باستان‌شناسی کامیت‌ها، سلامت CI، امنیت، چنج‌لاگ تولیدشده و رادار مشارکت.\n\nاسم مخزن را بفرست یا از فهرست انتخاب کن."
        : "Twelve expert tabs per repository. Send a repo name or pick one below."),
      kb(
        [{ text: "🔥 " + (fa ? "از داغ‌ترین‌ها" : "From trending"), cb: "s:fromtrending" }],
        [
          { text: "➡️ " + (fa ? "مثال: Cloudflare Workers" : "e.g. cloudflare/workers-sdk"), cb: "s:go:cloudflare/workers-sdk" },
        ],
        [
          { text: "🧠 " + (fa ? "تحلیل هوشمند یک مخزن" : "AI dossier"), cb: "ai:repo:cloudflare/workers-sdk" },
          { text: "⚖️ " + (fa ? "مقایسه دو مخزن" : "Compare two"), cb: "s:cmp:" },
        ],
        [{ text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Entry: run the scout and open the overview tab (tab 0). */
  async open(h: H, full: string, tab = 0) {
    const ok = await h.session?.acquire(`scout:${full}`);
    if (!ok) await h.toast(h.loc === "fa" ? "یک کاوش دیگر در جریان است…" : "another scout in progress…");
    try {
      await h.loading(h.loc === "fa" ? "🛰 در حال کاوش عمیق (۱۲ تب)…" : "🛰 deep scouting (12 tabs)…");
      const data = await this.scout(h, full);
      if (!data) return h.reply(`❌ ${h.loc === "fa" ? "مخزن پیدا نشد یا دسترسی ندارم." : "Repo not found."}`, kb([{ text: "◀️", cb: "m:home" }]), !!h.cbId);
      await h.store.saveRepo(data.meta);
      const text = await this.tab(h, data, tab);
      await h.reply(text, this.tabsKeyboard(h, full, tab), !!h.cbId);
      await h.store.event(h.u.id, "scout", full, { tab });
    } finally {
      await h.session?.release();
    }
  }

  /** Renders tab N. */
  async tab(h: H, data: { meta: RepoMeta; r: any }, tab: number): Promise<string> {
    const { meta: m, r } = data;
    const fa = h.loc === "fa";
    switch (tab) {
      case 0: return this.tOverview(h, m, r);
      case 1: return this.tGrowth(h, m, r);
      case 2: return this.tLanguages(h, m, r);
      case 3: return this.tCommunity(h, m, r);
      case 4: return this.tReleases(h, m, r);
      case 5: return this.tIssues(h, m, r);
      case 6: return this.tPRs(h, m, r);
      case 7: return this.tCommits(h, m, r);
      case 8: return this.tHygiene(h, m, r);
      case 9: return this.tSecurity(h, m, r);
      case 10: return this.tChangelog(h, m, r);
      case 11: return this.tContribute(h, m, r);
      default: return this.tOverview(h, m, r);
    }
  }

  tabsKeyboard(h: H, full: string, active: number) {
    const fa = h.loc === "fa";
    const T: [string, string][] = [
      ["📊", fa ? "نمای کلی" : "Overview"],
      ["📈", fa ? "رشد" : "Growth"],
      ["🧩", fa ? "زبان‌ها" : "Languages"],
      ["👥", fa ? "جامعه" : "Community"],
      ["🚀", fa ? "ریلیزها" : "Releases"],
      ["🐞", fa ? "ایشوها" : "Issues"],
      ["🔀", fa ? "PRها" : "PRs"],
      ["🕒", fa ? "کامیت‌ها" : "Commits"],
      ["🏗", fa ? "CI" : "CI / hygiene"],
      ["🛡", fa ? "امنیت" : "Security"],
      ["📰", fa ? "چنج‌لاگ" : "Changelog"],
      ["🎯", fa ? "مشارکت" : "Contribute"],
    ];
    const rows: { text: string; cb: string }[][] = [];
    for (let i = 0; i < T.length; i += 3) {
      rows.push(T.slice(i, i + 3).map(([icon, label], j) => ({
        text: (active === i + j ? "✅ " : "") + `${icon} ${label}`,
        cb: `s:t:${i + j},${full}`,
      })));
    }
    return kb(
      ...rows,
      [
        { text: "🖼 " + (fa ? "کارت تصویری" : "Share card"), cb: `r:card:${full}` },
        { text: "🤖 " + (fa ? "تحلیل AI" : "AI brief"), cb: `ai:repo:${full}` },
      ],
      [
        { text: "⭐ " + (fa ? "ذخیره" : "Save"), cb: `f:add:${full}` },
        { text: "🔔 " + (fa ? "اشتراک" : "Subscribe"), cb: `sub:add:${full}` },
        { text: "📥 " + (fa ? "دانلود" : "Download"), cb: `d:repo:${full}` },
      ],
      [{ text: "🏠 " + (fa ? "منو" : "Menu"), cb: "m:home" }, { text: "◀️ " + (fa ? "کارت مخزن" : "Repo card"), cb: `s:card:${full}` }],
    );
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  private tOverview(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const good = (r.goodFirstIssues?.totalCount ?? 0) + (r.helpWanted?.totalCount ?? 0);
    return (
      `📊 <b>${tgEscape(m.full_name)}</b> — ${fa ? "نمای کلی" : "Overview"}\n\n` +
      (m.description ? i(tgEscape(truncate(m.description, 260))) + "\n\n" : "") +
      `⭐ <b>${fmt(m.stars)}</b>  🍴 ${fmt(m.forks)}  👀 ${fmt(m.watchers)}  🐞 ${fmt(m.issues)}  🔀 ${fmt(m.prs)}\n` +
      `🏷 ${fa ? "نسخه‌ها" : "releases"}: ${fmt(m.releases)}   👥 ${fa ? "مشارکت‌کننده" : "contributors"}: ${fmt(m.contributors)}\n` +
      `${m.language ? `🧩 ${tgEscape(m.language)}` : ""}  ⚖️ ${tgEscape(m.license ?? (fa ? "بدون مجوز" : "none"))}  📅 ${rel(m.created_at, fa)}\n\n` +
      `${fa ? "سلامت" : "Health"}: <b>${m.health}/100</b> ${meterBar(m.health)}\n` +
      `${fa ? "سلامت جامعه" : "Community"}: <b>${m.community_health}%</b> ${meterBar(m.community_health)}\n` +
      `${fa ? "سرعت رشد" : "Velocity"}: <b>${m.stars_per_day}</b> ⭐/${fa ? "روز" : "day"}\n\n` +
      (m.topics.length ? `🏷 ${m.topics.slice(0, 14).map((t) => code("#" + t)).join(" ")}\n\n` : "") +
      (good ? `🌱 <b>${good}</b> ${fa ? "آیتم مناسب تازه‌واردها" : "beginner-friendly issues"}\n` : "") +
      (m.redFlags.length ? `\n⚠️ <b>${fa ? "هشدارها" : "Red flags"}</b>: ${m.redFlags.join(" • ")}\n` : "") +
      `\n🔗 ${link("github.com/" + m.full_name, `https://github.com/${m.full_name}`)}` +
      (m.homepage ? ` · ${link(fa ? "سایت" : "site", m.homepage)}` : "") +
      (r.fundingLinks?.length ? ` · 💖 ${r.fundingLinks.map((f: any) => link(f.platform, f.url)).join(" ")}` : "")
    );
  }

  private async tGrowth(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const eng = new TrendingEngine(h.env);
    const hist = await eng.history(m.full_name, 120);
    const weeks = (r.commitHistory?.target?.history?.nodes ?? []) as any[];
    const perWeek = bucketByWeek(weeks.map((c) => Date.parse(c.committedDate)));
    const growth = hist.last && hist.first ? hist.last - hist.first : 0;
    const days = hist.rows.length || 1;
    return (
      `📈 <b>${tgEscape(m.full_name)}</b> — ${fa ? "رشد و شتاب" : "Growth"}\n\n` +
      `⭐ ${fa ? "اکنون" : "now"}: <b>${fmt(hist.last ?? m.stars)}</b>\n` +
      (hist.first ? `🏁 ${fa ? "شروع بازه" : "window start"}: ${fmt(hist.first)} → <b>+${fmt(growth)}</b> ⭐\n` : "") +
      `🚀 ${fa ? "میانگین" : "avg"}: <b>${(growth / days).toFixed(1)}</b> ⭐/${fa ? "روز" : "day"}\n\n` +
      (hist.spark ? `${fa ? "۳۰ روز اخیر" : "last 30 days"}:\n<code>${hist.spark}</code>\n\n` : "") +
      `🕒 ${fa ? "فعالیت کامیت (هفتگی)" : "commit activity (weekly)"}:\n<code>${sparkline(perWeek)}</code>\n` +
      `${fa ? "اوج" : "peak"}: ${Math.max(...perWeek, 0)} ${fa ? "کامیت در هفته" : "commits/week"}\n\n` +
      `<i>${fa ? "برای نمودار دقیق‌تر، ربات را در این مخزن مچ کن تا هر ۱۵ دقیقه اسنپ‌شات بگیرد." : "Subscribe so we snapshot every 15 minutes."}</i>`
    );
  }

  private tLanguages(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const total = m.languages.reduce((s, l) => s + l.bytes, 0) || 1;
    const lines = m.languages.slice(0, 10).map((l) => {
      const pct = (l.bytes / total) * 100;
      return `${l.name.padEnd(14, " ")} ${pct.toFixed(1).padStart(5)}%  ${bar(pct, 16)}`;
    }).join("\n");
    const diversity = m.languages.length;
    const main = m.language ?? "—";
    return (
      `🧩 <b>${tgEscape(m.full_name)}</b> — ${fa ? "دی‌ان‌ای زبان‌ها" : "Language DNA"}\n\n` +
      `<pre>${tgEscape(lines)}</pre>\n` +
      `${fa ? "زبان اصلی" : "primary"}: <b>${tgEscape(main)}</b>\n` +
      `${fa ? "تنوع زبانی" : "diversity"}: <b>${diversity}</b> ${diversity > 6 ? "🌍" : diversity > 2 ? "🧩" : "🎯"}\n` +
      `${fa ? "حجم کد" : "code size"}: <b>${(m.size_kb / 1024).toFixed(1)} MB</b>\n\n` +
      `<i>${fa ? "ترکیب زبان‌ها از GitHub Linguist می‌آید و بر اساس بایت واقعی کد محاسبه شده." : "Computed from real byte counts via GitHub Linguist."}</i>`
    );
  }

  private tCommunity(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const cp = r.communityProfile ?? {};
    const nodes = r.contributorList?.target?.history?.nodes ?? [];
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const key = n?.author?.user?.login ?? n?.author?.name ?? "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8);
    const totalCommits = [...counts.values()].reduce((s, v) => s + v, 0) || 1;
    const busFactor = busFactorOf([...counts.values()]);
    const check = (v: boolean) => (v ? "✅" : "❌");
    return (
      `👥 <b>${tgEscape(m.full_name)}</b> — ${fa ? "جامعه و سلامت" : "Community"}\n\n` +
      `🏅 ${fa ? "سلامت جامعه" : "community health"}: <b>${cp.healthPercentage ?? 0}%</b> ${meterBar(cp.healthPercentage ?? 0)}\n` +
      `${fa ? "تعداد مشارکت‌کننده (نمونه)" : "contributors (sample)"}: <b>${counts.size}</b>\n` +
      `${fa ? "ضریب اتوبوس" : "bus factor"}: <b>${busFactor}</b> ${busFactor <= 1 ? "🚨" : busFactor <= 2 ? "⚠️" : "🟢"}\n\n` +
      `<b>${fa ? "فعال‌ترین مشارکت‌کننده‌ها" : "Top contributors"}</b>\n` +
      top.map(([login, c], i2) => {
        const pct = Math.round((c / totalCommits) * 100);
        return `${i2 + 1}. <code>${tgEscape(login)}</code> — ${c} ${fa ? "کامیت" : "commits"} (${pct}%) ${bar(pct, 10)}`;
      }).join("\n") +
      `\n\n<b>${fa ? "چک‌لیست نگهداری" : "Maintenance checklist"}</b>\n` +
      `${check(cp.hasReadme)} README   ${check(cp.hasLicense)} LICENSE   ${check(cp.hasContributing)} CONTRIBUTING\n` +
      `${check(cp.hasCodeOfConduct)} CODE_OF_CONDUCT   ${check(cp.hasIssueTemplate)} issue template   ${check(cp.hasPullRequestTemplate)} PR template\n` +
      `${check(m.has_ci)} CI   ${check(!!r.securityPolicyUrl)} SECURITY.md   ${check(r.hasDiscussionsEnabled)} Discussions\n\n` +
      (fa ? `<i>ضریب اتوبوس = چند نفر باید بروند تا پروژه بخوابد. عدد ۱ خطر بزرگی است.</i>` : "")
    );
  }

  private tReleases(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const rels = (r.releases?.nodes ?? []) as any[];
    const tags = (r.tags?.nodes ?? []) as any[];
    const assets = rels.flatMap((x) => x.releaseAssets?.nodes ?? []);
    const totalDownloads = assets.reduce((s, a) => s + (a.downloadCount ?? 0), 0);
    const cadence = cadenceDays(rels.map((x) => Date.parse(x.publishedAt)));
    return (
      `🚀 <b>${tgEscape(m.full_name)}</b> — ${fa ? "ریلیزها" : "Releases"}\n\n` +
      `🏷 ${fa ? "کل نسخه‌ها" : "total releases"}: <b>${fmt(m.releases)}</b>   ⏱ ${fa ? "ریتم انتشار" : "cadence"}: <b>${cadence ? `${cadence} ${fa ? "روز" : "days"}` : "—"}</b>\n` +
      `📦 ${fa ? "دانلود دارایی‌ها" : "asset downloads"}: <b>${fmt(totalDownloads)}</b>\n\n` +
      rels.slice(0, 6).map((x) => {
        const prerelease = x.isPrerelease ? " 🧪" : "";
        const dls = (x.releaseAssets?.nodes ?? []).reduce((s: number, a: any) => s + (a.downloadCount ?? 0), 0);
        return (
          `• <b>${tgEscape(x.tagName || x.name || "?")}</b>${prerelease} — ${rel(x.publishedAt, fa)}${dls ? ` · ⬇️ ${fmt(dls)}` : ""}\n` +
          (x.description ? `  ${i(tgEscape(firstLine(x.description, 100)))}\n` : "")
        );
      }).join("") +
      (tags.length ? `\n🏷 ${fa ? "آخرین تگ‌ها" : "recent tags"}: ${tags.slice(0, 10).map((t) => code(t.name)).join(" ")}\n` : "") +
      `\n📥 ${fa ? "برای دانلود آخرین نسخه از تب دانلود استفاده کن." : "Use the download tab for assets."}`
    );
  }

  private tIssues(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const open = r.issues?.nodes ?? [];
    const closed = r.closedIssues?.totalCount ?? 0;
    const total = (r.issues?.totalCount ?? 0) + closed;
    const closeRate = total ? Math.round((closed / total) * 100) : 0;
    const stale = open.filter((x: any) => Date.now() - Date.parse(x.updatedAt) > 90 * 86400000).length;
    const labels = new Map<string, number>();
    for (const x of open) for (const l of x.labels?.nodes ?? []) labels.set(l.name, (labels.get(l.name) ?? 0) + 1);
    return (
      `🐞 <b>${tgEscape(m.full_name)}</b> — ${fa ? "ایشوها" : "Issues"}\n\n` +
      `🔓 ${fa ? "باز" : "open"}: <b>${fmt(m.issues)}</b>   ✅ ${fa ? "بسته" : "closed"}: ${fmt(closed)}\n` +
      `📊 ${fa ? "نرخ بستن" : "close rate"}: <b>${closeRate}%</b> ${meterBar(closeRate)}\n` +
      (stale ? `🥀 ${fa ? "بدون فعالیت ۹۰+ روز" : "stale 90d+"}: <b>${stale}</b> ${fa ? "از ۱۲ مورد آخر" : "of last 12"}\n` : "") +
      `🌱 good first issue: <b>${m.good_first}</b>   🙋 help wanted: <b>${m.help_wanted}</b>\n\n` +
      (labels.size ? `🏷 ${fa ? "برچسب‌های داغ" : "hot labels"}: ${[...labels.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([k, v]) => `${code(k)}×${v}`).join(" ")}\n\n` : "") +
      `<b>${fa ? "تازه‌ترین موارد باز" : "Latest open"}</b>\n` +
      open.slice(0, 8).map((x: any) =>
        `• ${link(`#${x.number} ${truncate(x.title, 70)}`, x.url)} — ${rel(x.updatedAt, fa)} 💬 ${x.comments?.totalCount ?? 0}`).join("\n")
    );
  }

  private tPRs(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const prs = (r.pullRequests?.nodes ?? []) as any[];
    const merged = r.closedPRs?.totalCount ?? 0;
    const all = r.allPRs?.totalCount ?? 1;
    const mergeRate = all ? Math.round((merged / all) * 100) : 0;
    const drafts = prs.filter((p) => p.isDraft).length;
    const conflicts = prs.filter((p) => p.mergeable === "CONFLICTING").length;
    return (
      `🔀 <b>${tgEscape(m.full_name)}</b> — ${fa ? "پول‌ریکوئست‌ها" : "Pull requests"}\n\n` +
      `🔓 ${fa ? "باز" : "open"}: <b>${fmt(m.prs)}</b>   ✅ ${fa ? "مرج‌شده" : "merged"}: ${fmt(merged)}\n` +
      `📊 ${fa ? "نرخ مرج" : "merge rate"}: <b>${mergeRate}%</b> ${meterBar(mergeRate)}\n` +
      `📝 ${fa ? "پیش‌نویس" : "draft"}: <b>${drafts}</b>   ⚔️ ${fa ? "تعارض" : "conflicts"}: <b>${conflicts}</b>\n\n` +
      `<b>${fa ? "در انتظار بررسی" : "Awaiting review"}</b>\n` +
      (prs.slice(0, 8).map((p: any) => {
        const size = (p.additions ?? 0) + (p.deletions ?? 0);
        const sizeIcon = size > 1000 ? "🐘" : size > 300 ? "📦" : "🍃";
        return `• ${link(`#${p.number} ${truncate(p.title, 62)}`, p.url)}\n   ${sizeIcon} +${p.additions}/-${p.deletions} · 📄 ${p.changedFiles} · 💬 ${p.comments?.totalCount ?? 0} · ${rel(p.updatedAt, fa)}`;
      }).join("\n") || `<i>${fa ? "هیچ PR بازی نیست" : "no open PRs"}</i>`) +
      `\n\n🤖 <i>${fa ? "می‌خواهی یک PR را برایت بازبینی کنم؟" : "Want an AI review of a PR?"} <code>/review owner/repo#12</code></i>`
    );
  }

  private tCommits(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const nodes = (r.commitHistory?.target?.history?.nodes ?? []) as any[];
    const total = r.commitHistory?.target?.history?.totalCount ?? 0;
    const authors = new Map<string, number>();
    for (const c of nodes) {
      const k = c.author?.user?.login ?? c.author?.name ?? "?";
      authors.set(k, (authors.get(k) ?? 0) + 1);
    }
    const conventional = nodes.filter((c) => /^(feat|fix|chore|docs|refactor|test|perf|ci|build|style)(\(.+\))?!?:/.test(c.messageHeadline)).length;
    const convPct = nodes.length ? Math.round((conventional / nodes.length) * 100) : 0;
    const emoji = nodes.filter((c) => /\p{Extended_Pictographic}/u.test(c.messageHeadline)).length;
    return (
      `🕒 <b>${tgEscape(m.full_name)}</b> — ${fa ? "باستان‌شناسی کامیت" : "Commit archaeology"}\n\n` +
      `📜 ${fa ? "کل کامیت‌ها (شاخه پیش‌فرض)" : "total commits"}: <b>${fmt(total)}</b>\n` +
      `🧹 ${fa ? "پیروی از Conventional Commits" : "conventional commits"}: <b>${convPct}%</b> ${meterBar(convPct)}\n` +
      `😀 ${fa ? "کامیت‌های ایموجی‌دار" : "emoji commits"}: ${emoji}/${nodes.length}\n\n` +
      `<b>${fa ? "آخرین کامیت‌ها" : "Latest commits"}</b>\n` +
      nodes.slice(0, 12).map((c) => {
        const type = (c.messageHeadline.match(/^(\w+)(\(.+\))?!?:/) ?? [])[1] ?? "";
        const icon = type === "feat" ? "✨" : type === "fix" ? "🐛" : type === "docs" ? "📝" : type === "perf" ? "⚡" : type === "refactor" ? "♻️" : "•";
        return `${icon} ${link(truncate(c.messageHeadline, 62), c.url)}\n   <code>${tgEscape((c.oid ?? "").slice(0, 7))}</code> · ${tgEscape(c.author?.user?.login ?? c.author?.name ?? "?")} · ${rel(c.committedDate, fa)}`;
      }).join("\n") +
      `\n\n📰 <i>${fa ? "تب چنج‌لاگ: خلاصه انسانی این کامیت‌ها" : "Changelog tab: human-readable summary"}</i>`
    );
  }

  private tHygiene(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const files = new Set<string>((r.rootFiles?.entries ?? []).map((e: any) => e.name));
    const workflows = (r.workflows?.entries ?? []).map((e: any) => e.name);
    const have = (names: string[]) => names.some((n) => [...files].some((f) => f.toLowerCase() === n.toLowerCase()));
    const boostrap: [string, boolean, string][] = [
      ["README", have(["readme.md", "readme.rst", "readme"]), fa ? "بدون README هیچ‌کس پروژه را نمی‌فهمد" : "no README = nobody understands it"],
      ["LICENSE", have(["license", "license.md", "license.txt"]), fa ? "بدون مجوز، استفاده تجاری ریسکی است" : "without a license, commercial use is risky"],
      ["CONTRIBUTING", have(["contributing.md"]), fa ? "راهنمای مشارکت جذب مشارکت‌کننده را ۲ برابر می‌کند" : "doubles contributor conversion"],
      ["CODE_OF_CONDUCT", have(["code_of_conduct.md", "code-of-conduct.md"]), fa ? "برای پروژه‌های بزرگ ضروری است" : "required for larger communities"],
      ["SECURITY.md", have(["security.md"]), fa ? "کانال گزارش آسیب‌پذیری" : "vulnerability disclosure channel"],
      ["CHANGELOG", have(["changelog.md", "changelog"]), fa ? "تاریخ تغییرات قابل پیگیری" : "trackable history"],
      ["Docker", have(["dockerfile", "docker-compose.yml", "compose.yaml"]), fa ? "اجرای سریع بدون دردسر" : "frictionless first run"],
      [".editorconfig", have([".editorconfig"]), fa ? "یکسانی سبک کد بین مشارکت‌کننده‌ها" : "consistent code style"],
      [".gitignore", have([".gitignore"]), ""],
      ["Dependabot / Renovate", have([".github/dependabot.yml", "renovate.json"]), fa ? "به‌روزرسانی خودکار وابستگی‌ها" : "automated dependency updates"],
    ];
    const present = boostrap.filter(([, ok]) => ok).length;
    const score = Math.round((present / boostrap.length) * 100);
    return (
      `🏗 <b>${tgEscape(m.full_name)}</b> — ${fa ? "سلامت مخزن و CI" : "Repo hygiene & CI"}\n\n` +
      `🧪 ${fa ? "امتیاز بهداشت" : "hygiene score"}: <b>${score}%</b> ${meterBar(score)}\n` +
      `⚙️ ${fa ? "ورک‌فلوهای Actions" : "Actions workflows"}: <b>${workflows.length}</b>\n` +
      (workflows.length ? workflows.slice(0, 8).map((w: string) => `   • ${tgEscape(w)}`).join("\n") + "\n" : "") +
      `\n<b>${fa ? "چک‌لیست فایل‌ها" : "File checklist"}</b>\n` +
      boostrap.map(([name, ok, why]) => `${ok ? "✅" : "❌"} <code>${tgEscape(name)}</code>${!ok && why ? ` — ${i(why)}` : ""}`).join("\n") +
      `\n\n🎁 ${fa ? "می‌خواهی ورک‌فلوی گمشده را برایت بسازم؟" : "Want me to generate the missing workflow?"}\n<code>/workflow ci for node with tests on PR</code>`
    );
  }

  private tSecurity(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const alerts = (r.securityAdvisories?.nodes ?? []) as any[];
    const sev = (s: string) => (s === "CRITICAL" ? "🟥" : s === "HIGH" ? "🟧" : s === "MODERATE" ? "🟨" : "🟩");
    return (
      `🛡 <b>${tgEscape(m.full_name)}</b> — ${fa ? "امنیت" : "Security"}\n\n` +
      `${r.hasVulnerabilityAlertsEnabled ? "✅" : "❌"} ${fa ? "هشدارهای آسیب‌پذیری فعال" : "vulnerability alerts enabled"}\n` +
      `${r.securityPolicyUrl ? "✅" : "❌"} ${fa ? "فایل SECURITY.md" : "SECURITY.md"}\n` +
      `${r.isFork ? "⚠️" : "✅"} ${fa ? "مخزن اصلی (نه فورک)" : "upstream (not a fork)"}\n` +
      `${m.license ? "✅" : "⚠️"} ${fa ? "مجوز مشخص" : "declared license"}\n\n` +
      (alerts.length
        ? `<b>${fa ? "آسیب‌پذیری‌های شناخته‌شده" : "Known advisories"} (${alerts.length})</b>\n` +
          alerts.slice(0, 6).map((a) =>
            `${sev(a.securityAdvisory?.severity)} <b>${tgEscape(a.securityAdvisory?.severity ?? "?")}</b> — ${tgEscape(truncate(a.securityAdvisory?.summary ?? "", 90))}\n` +
            `   <code>${tgEscape(a.securityAdvisory?.ghsaId ?? "")}</code>${a.vulnerableManifestPath ? ` · <code>${tgEscape(a.vulnerableManifestPath)}</code>` : ""} · ${rel(a.securityAdvisory?.publishedAt, fa)}`).join("\n")
        : `<i>${fa ? "هیچ هشدار فعالی از GitHub نداریم." : "No active GitHub advisories."}</i>`) +
      `\n\n🔬 <i>${fa ? "اسکن کامل وابستگی‌ها (OSV) + جست‌وجوی لو رفتن کلیدها:" : "Full dependency scan (OSV) + secret hunt:"}\n<code>/security ${m.full_name}</code></i>`
    );
  }

  private async tChangelog(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const nodes = (r.commitHistory?.target?.history?.nodes ?? []) as any[];
    const cached = await h.env.STATE.get(`chg:${m.full_name}`);
    const commits = nodes.slice(0, 40).map((c) => ({ message: c.messageHeadline, author: c.author?.name }));
    const text = cached ?? await h.ai.changelog(commits, h.loc);
    if (!cached && text) await h.env.STATE.put(`chg:${m.full_name}`, text, { expirationTtl: 21600 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return (
      `📰 <b>${tgEscape(m.full_name)}</b> — ${fa ? "چنج‌لاگ تولیدشده" : "Generated changelog"}\n` +
      `<i>${fa ? "از ۴۰ کامیت آخر شاخه پیش‌فرض، با هوش مصنوعی" : "from the last 40 commits, via AI"}</i>\n\n` +
      (text?.slice(0, 3200) ?? (fa ? "تولید نشد." : "unavailable.")) +
      `\n\n<i>${fa ? "برای بازتولید: /changelog " : "regenerate: /changelog "}${tgEscape(m.full_name)}</i>`
    );
  }

  private tContribute(h: H, m: RepoMeta, r: any) {
    const fa = h.loc === "fa";
    const gfi = (r.goodFirstIssues?.nodes ?? []) as any[];
    const hw = (r.helpWanted?.nodes ?? []) as any[];
    const smallBugs = (r.issues?.nodes ?? []).filter((x: any) =>
      (x.labels?.nodes ?? []).some((l: any) => /bug|good first|help wanted|easy|beginner/i.test(l.name)));
    const list = [...gfi, ...hw, ...smallBugs].slice(0, 10);
    return (
      `🎯 <b>${tgEscape(m.full_name)}</b> — ${fa ? "رادار مشارکت" : "Contribution radar"}\n\n` +
      `🌱 good first issue: <b>${m.good_first}</b>   🙋 help wanted: <b>${m.help_wanted}</b>\n` +
      `✅ ${fa ? "پذیرش PR" : "PR acceptance"}: <b>${r.closedPRs?.totalCount ?? 0}</b> ${fa ? "مرج‌شده" : "merged"} ${fa ? "از" : "of"} ${fmt(r.allPRs?.totalCount ?? 0)}\n` +
      `⏱ ${fa ? "آخرین فعالیت" : "last activity"}: ${rel(m.pushed_at, fa)}\n\n` +
      (list.length
        ? `<b>${fa ? "کارهای مناسب شروع" : "Good starting points"}</b>\n` +
          list.map((x) => `• ${link(`#${x.number} ${truncate(x.title, 68)}`, x.url)}`).join("\n")
        : `<i>${fa ? "فعلاً آیتِم برچسب‌دار مناسبی نیست؛ می‌توانی روی مستندات کار کنی." : "No labelled starter issues right now."}</i>`) +
      `\n\n📘 ${fa ? "راهنمای مشارکت: فورک → برنچ → کامیت Conventional → PR با توضیح و اسکرین‌شات." : ""}\n` +
      `🤖 <i><code>/webhook-setup ${m.full_name}</code> ${fa ? "تا از فرصت‌های جدید باخبر شوی" : "to get notified of new ones"}</i>`
    );
  }

  // ── compare ─────────────────────────────────────────────────────────────
  async compare(h: H, a: string, b?: string) {
    const fa = h.loc === "fa";
    if (!b) {
      await h.session?.set("cmp", { a });
      return h.reply(
        `⚖️ <b>${fa ? "مقایسه" : "Compare"}</b>\n\n` + (fa
          ? `مخزن اول: <code>${tgEscape(a || "—")}</code>\nحالا مخزن دوم را بفرست (قالب <code>owner/repo</code>).`
          : `First: <code>${tgEscape(a || "—")}</code>. Now send the second one.`),
        kb([{ text: "◀️ " + (fa ? "لغو" : "Cancel"), cb: "m:home" }]),
        !!h.cbId,
      );
    }
    await h.loading(fa ? "⚖️ در حال مقایسه…" : "⚖️ comparing…");
    const gql = new GithubGraphQL(h.env, h.userToken ?? h.env.GITHUB_TOKEN);
    const [oa, na] = a.split("/"); const [ob, nb] = b.split("/");
    const [da, db] = await Promise.all([
      gql.deepScout(oa, na).catch(() => null),
      gql.deepScout(ob, nb).catch(() => null),
    ]);
    if (!da?.repository || !db?.repository) return h.reply(fa ? "یکی از مخازن پیدا نشد." : "One repo not found.", kb([{ text: "◀️", cb: "s:home" }]), !!h.cbId);
    const ma = toRepoMeta(da), mb = toRepoMeta(db);
    const cmp = (x: number, y: number) => (x > y ? "⬅️" : x < y ? "➡️" : "🟰");
    const row = (label: string, x: string, y: string, mark = "") => `${label.padEnd(16, " ")}│ ${x.padStart(9, " ")} ${mark} ${y.padStart(9, " ")}`;
    const lines = [
      row("", ma.full_name.slice(0, 18), mb.full_name.slice(0, 18)),
      "─".repeat(46),
      row(fa ? "⭐ ستاره" : "⭐ stars", fmt(ma.stars), fmt(mb.stars), cmp(ma.stars, mb.stars)),
      row(fa ? "🍴 فورک" : "🍴 forks", fmt(ma.forks), fmt(mb.forks), cmp(ma.forks, mb.forks)),
      row(fa ? "🐞 ایشو" : "🐞 issues", fmt(ma.issues), fmt(mb.issues), cmp(mb.issues, ma.issues)),
      row(fa ? "🔀 PR باز" : "🔀 open PR", fmt(ma.prs), fmt(mb.prs), cmp(mb.prs, ma.prs)),
      row(fa ? "❤️ سلامت" : "❤️ health", String(ma.health), String(mb.health), cmp(ma.health, mb.health)),
      row(fa ? "👥 جامعه" : "👥 community", `${ma.community_health}%`, `${mb.community_health}%`, cmp(ma.community_health, mb.community_health)),
      row(fa ? "🚀 سرعت" : "🚀 velocity", String(ma.stars_per_day), String(mb.stars_per_day), cmp(ma.stars_per_day, mb.stars_per_day)),
      row(fa ? "🧩 زبان" : "🧩 language", (ma.language ?? "—").slice(0, 9), (mb.language ?? "—").slice(0, 9)),
      row(fa ? "⚖️ مجوز" : "⚖️ license", (ma.license ?? "—").slice(0, 9), (mb.license ?? "—").slice(0, 9)),
      row(fa ? "🌱 good first" : "🌱 good-first", String(ma.good_first), String(mb.good_first), cmp(ma.good_first, mb.good_first)),
    ];
    const winner = ma.health === mb.health ? null : ma.health > mb.health ? ma : mb;
    const verdict = await h.ai.chat(
      `In 2 Persian sentences, give a verdict for choosing between ${a} (health ${ma.health}, stars ${ma.stars}, ${
        ma.language}, last push ${ma.pushed_at}) and ${b} (health ${mb.health}, stars ${mb.stars}, ${mb.language}, last push ${mb.pushed_at}). ` +
        `Mention who should pick which.`,
      { tier: "fast", max_tokens: 320, cacheKey: `cmp:${a}:${b}:${ma.stars}:${mb.stars}`, cacheTtl: 604800 },
    );
    await h.reply(
      `⚖️ <b>${fa ? "مقایسه مخازن" : "Repo comparison"}</b>\n\n<pre>${tgEscape(lines.join("\n"))}</pre>\n` +
        (winner ? `🏆 ${fa ? "برنده سلامت" : "health winner"}: <b>${tgEscape(winner.full_name)}</b> (${winner.health}/100)\n\n` : "") +
        `🧠 ${i(tgEscape(verdict))}`,
      kb(
        [{ text: `① ${a.slice(0, 28)}`, cb: `s:go:${a}` }, { text: `② ${b.slice(0, 28)}`, cb: `s:go:${b}` }],
        [
          { text: "🤖 " + (fa ? "مقایسه هوشمند" : "AI compare"), cb: `ai:cmp:${a}|${b}` },
          { text: "🖼 " + (fa ? "کارت مقایسه" : "Compare card"), cb: `r:cmpcard:${a}|${b}` },
        ],
        [{ text: "🔁 " + (fa ? "مقایسه جدید" : "New compare"), cb: "s:cmp:" }],
      ),
      !!h.cbId,
    );
  }
}

// ── small analytic helpers ─────────────────────────────────────────────────
function bucketByWeek(timestamps: number[], weeks = 24): number[] {
  const now = Date.now();
  const buckets = new Array(weeks).fill(0);
  for (const t of timestamps) {
    const idx = weeks - 1 - Math.floor((now - t) / (7 * 86400000));
    if (idx >= 0 && idx < weeks) buckets[idx]++;
  }
  return buckets;
}

function busFactorOf(commitCounts: number[], threshold = 0.5): number {
  const total = commitCounts.reduce((s, v) => s + v, 0);
  if (!total) return 0;
  let acc = 0, n = 0;
  for (const c of commitCounts.sort((a, b) => b - a)) {
    acc += c; n++;
    if (acc / total >= threshold) break;
  }
  return n;
}

function cadenceDays(timestamps: number[]): number | null {
  const ts = timestamps.filter(Boolean).sort((a, b) => b - a);
  if (ts.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 0; i < ts.length - 1; i++) gaps.push((ts[i] - ts[i + 1]) / 86400000);
  const med = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  return Math.max(1, Math.round(med || 1));
}

function firstLine(s: string, n: number) {
  const line = String(s).split("\n").find((l) => l.trim()) ?? "";
  return truncate(line.replace(/[#*`>]/g, "").trim(), n);
}
