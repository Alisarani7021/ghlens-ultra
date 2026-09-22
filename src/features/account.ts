import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { fmt } from "./cards";

/**
 * «وضعیت حساب گیت‌هاب من» — the connected account's real dashboard.
 *
 * The owner's requirement: once you connect GitHub, the bot should show
 * everything the account holds — how many repositories, which are private,
 * what they are, languages, stars, organizations, limits — not just a name.
 * Everything here is read with the *user's own* token, so private repositories
 * are included; nothing is shown from the shared deployment token.
 */
interface GhUser {
  login: string; name: string | null; avatar_url: string; bio: string | null;
  company: string | null; blog: string | null; location: string | null;
  public_repos: number; public_gists: number; followers: number; following: number;
  created_at: string; updated_at: string; type: string; hireable: boolean | null;
  twitter_username?: string | null; email?: string | null;
}
interface GhRepo {
  full_name: string; description: string | null; private: boolean; fork: boolean; archived: boolean;
  stargazers_count: number; forks_count: number; open_issues_count: number; watchers_count: number;
  language: string | null; size: number; pushed_at: string | null; created_at: string;
  html_url: string; topics?: string[]; visibility?: string; default_branch: string;
}

export const account = {
  /** No token yet → explain what linking gives, with the two ways to do it. */
  async needsLink(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      fa
        ? `🔗 <b>اول حساب گیت‌هابت را وصل کن</b>\n\n` +
          `با اتصال حساب، این‌ها را می‌بینی:\n` +
          `• 📦 تعداد و فهرست همهٔ مخزن‌ها — <b>خصوصی و عمومی</b>\n` +
          `• 📊 زبان‌ها، ستاره‌ها، اندازه، آخرین پوش\n` +
          `• 🏢 سازمان‌ها، 👥 دنبال‌کننده‌ها، ⭐ ستاره‌های تو\n` +
          `• ⚡ سقف درخواست ۵٬۰۰۰ در ساعت به‌جای ۶۰\n\n` +
          `اتصال با توکن شخصی همیشه کار می‌کند و فقط خواندنِ عمومی کافی است.`
        : `🔗 Connect GitHub first — then the bot shows your repositories (public and private), languages, stars and organizations.`,
      kb(
        [{ text: "🐙 " + (fa ? "اتصال حساب" : "Connect account"), cb: "me:link" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "me:home" }],
      ),
      !!h.cbId,
    );
  },

  /** The dashboard itself. */
  async home(h: H) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);

    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "📊 در حال خواندن وضعیت حسابت…" : "📊 reading your account…");

    const me = await gh.get<GhUser>("/user", 60).catch(() => null);
    if (!me) {
      return h.reply(
        fa ? `❌ توکن حساب کار نکرد. یک بار دیگر وصلش کن: /login` : `❌ The stored token no longer works. Reconnect with /login.`,
        kb([[{ text: "🔗 " + (fa ? "اتصال دوباره" : "Reconnect"), cb: "me:link" }], [{ text: "◀️", cb: "me:home" }]]),
        !!h.cbId,
      );
    }

    // up to 300 repos is enough for counts and a solid language breakdown
    const repos = await gh.paginate<GhRepo>("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc", 3, 100)
      .catch(() => [] as GhRepo[]);
    const orgs = await gh.get<{ login: string; description: string | null }[]>("/user/orgs", 600).catch(() => [] as { login: string; description: string | null }[]);
    const limits = await gh.rateLimit().catch(() => null as any);

    const priv = repos.filter((r) => r.private);
    const pub = repos.filter((r) => !r.private);
    const owned = repos.filter((r) => (r.full_name ?? "").split("/")[0]?.toLowerCase() === me.login.toLowerCase());
    const stars = owned.reduce((s, r) => s + (r.stargazers_count ?? 0), 0);
    const forks = owned.reduce((s, r) => s + (r.forks_count ?? 0), 0);
    const issues = owned.reduce((s, r) => s + (r.open_issues_count ?? 0), 0);
    const sizeMb = Math.round(repos.reduce((s, r) => s + (r.size ?? 0), 0) / 1024);
    const archived = repos.filter((r) => r.archived).length;
    const forkCount = repos.filter((r) => r.fork).length;

    const langs = new Map<string, number>();
    for (const r of repos) if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
    const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const langTotal = topLangs.reduce((s, [, n]) => s + n, 0) || 1;

    const days = Math.floor((Date.now() - Date.parse(me.created_at)) / 86400000);
    const recent = repos.slice(0, 5);

    const text =
      `🐙 <b>${tgEscape(me.name ?? me.login)}</b> <code>@${tgEscape(me.login)}</code>\n` +
      (me.bio ? `<i>${tgEscape(me.bio.slice(0, 160))}</i>\n` : "") +
      (me.company ? `🏢 ${tgEscape(me.company)} ` : "") +
      (me.location ? `📍 ${tgEscape(me.location)} ` : "") +
      (me.blog ? `🔗 ${tgEscape(me.blog.slice(0, 60))}\n` : "\n") +
      `\n<b>${fa ? "📦 مخزن‌ها" : "📦 Repositories"}</b>\n` +
      `• کل: <b>${repos.length}</b>${repos.length >= 300 ? "+" : ""}  ·  🌐 عمومی <b>${pub.length}</b>  ·  🔒 خصوصی <b>${priv.length}</b>\n` +
      `• 🍴 فورک: ${forkCount}  ·  🗄 آرشیو: ${archived}  ·  💾 ${fmt(sizeMb)}MB\n` +
      `• ⭐ ستاره‌های گرفته: <b>${fmt(stars)}</b>  ·  🍴 فورک‌ها: ${fmt(forks)}  ·  🐞 ایشو باز: ${fmt(issues)}\n` +
      `\n<b>${fa ? "🧩 زبان‌ها" : "🧩 Languages"}</b>\n` +
      (topLangs.map(([l, n]) => {
        const pct = Math.round((n / langTotal) * 100);
        return `• ${tgEscape(l)} <code>${pct}%</code> ${"▰".repeat(Math.max(1, Math.round(pct / 10)))}`;
      }).join("\n") || "• —") +
      `\n\n<b>${fa ? "👥 شبکه" : "👥 Network"}</b>\n` +
      `• دنبال‌کننده <b>${fmt(me.followers)}</b>  ·  دنبال‌شده <b>${fmt(me.following)}</b>  ·  🏢 سازمان‌ها <b>${orgs.length}</b>  ·  📝 گیت‌ها <b>${me.public_gists}</b>\n` +
      `• 📅 عضو از ${new Date(me.created_at).toISOString().slice(0, 10)} (<b>${fmt(days)}</b> روز)\n` +
      (limits?.remaining != null ? `• ⚡ سقف درخواست: <b>${fmt(limits.remaining)}</b>/${fmt(limits.limit ?? 5000)}\n` : "") +
      `\n<b>${fa ? "🕒 آخرین کارها" : "🕒 Latest"}</b>\n` +
      recent.map((r) => `${r.private ? "🔒" : "🌐"} <b>${tgEscape(r.full_name)}</b>${r.archived ? " 🗄" : ""} · ⭐ ${fmt(r.stargazers_count)} · ${r.pushed_at ? new Date(r.pushed_at).toISOString().slice(0, 10) : "—"}`).join("\n");

    await h.reply(text, kb(
      [{ text: "📦 " + (fa ? "مخزن‌های من" : "My repos"), cb: "gh:repos:0" }, { text: "🔒 " + (fa ? "خصوصی‌ها" : "Private"), cb: "gh:private" }],
      [{ text: "🏢 " + (fa ? "سازمان‌ها" : "Orgs"), cb: "gh:orgs" }, { text: "⭐ " + (fa ? "ستاره‌های من" : "My stars"), cb: "gh:starred:0" }],
      [{ text: "📊 " + (fa ? "آمار دقیق" : "Details"), cb: "gh:stats" }, { text: "🔁 " + (fa ? "تازه‌سازی" : "Refresh"), cb: "gh:home" }],
      [{ text: "🔓 " + (fa ? "جدا کردن حساب" : "Unlink"), cb: "me:unlink" }, { text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
    ), !!h.cbId);
    await h.store.event(h.u.id, "gh_account", me.login);
  },

  /** Paginated repository list, newest first, with visibility and stars. */
  async repos(h: H, page = 0) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);
    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "📦 در حال خواندن مخزن‌ها…" : "📦 loading repositories…");
    const per = 10;
    const list = await gh.get<GhRepo[]>(`/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=${per}&page=${page + 1}`, 60)
      .catch(() => [] as GhRepo[]);
    if (!list.length) return h.reply(fa ? "🫙 مخزن دیگری نیست." : "no more repos", kb([[{ text: "◀️", cb: "gh:home" }]]), true);
    const body = list.map((r, i) =>
      `${page * per + i + 1}. ${r.private ? "🔒" : "🌐"} <b>${tgEscape(r.full_name)}</b>${r.archived ? " 🗄" : ""}${r.fork ? " 🍴" : ""}\n` +
      (r.description ? `   <i>${tgEscape(r.description.slice(0, 110))}</i>\n` : "") +
      `   ⭐ ${fmt(r.stargazers_count)} · 🍴 ${fmt(r.forks_count)} · 🐞 ${fmt(r.open_issues_count)} · ${r.language ? tgEscape(r.language) : "—"} · ${r.pushed_at ? new Date(r.pushed_at).toISOString().slice(0, 10) : "—"}`
    ).join("\n");
    const rows: any[] = [];
    if (page > 0) rows.push([{ text: "⬅️ " + (fa ? "قبلی" : "Prev"), cb: `gh:repos:${page - 1}` }]);
    if (list.length === per) rows.push([{ text: (fa ? "بعدی" : "Next") + " ➡️", cb: `gh:repos:${page + 1}` }]);
    rows.push([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gh:home" }]);
    await h.reply(
      `📦 <b>${fa ? "مخزن‌های من" : "My repositories"}</b> — ${fa ? "صفحه" : "page"} ${page + 1}\n\n${body}`,
      kb(...rows), true,
    );
  },

  async privateRepos(h: H) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);
    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "🔒 در حال خواندن مخزن‌های خصوصی…" : "🔒 loading private repos…");
    const list = await gh.get<GhRepo[]>(`/user/repos?visibility=private&sort=pushed&per_page=10`, 60).catch(() => [] as GhRepo[]);
    await h.reply(
      list.length
        ? `🔒 <b>${fa ? "مخزن‌های خصوصی" : "Private repositories"}</b>\n\n` +
          list.map((r, i) => `${i + 1}. <b>${tgEscape(r.full_name)}</b>${r.archived ? " 🗄" : ""}\n   ⭐ ${fmt(r.stargazers_count)} · 🐞 ${fmt(r.open_issues_count)} · 💾 ${fmt(Math.round((r.size ?? 0) / 1024))}MB · ${r.pushed_at ? new Date(r.pushed_at).toISOString().slice(0, 10) : "—"}`).join("\n")
        : (fa ? "🔓 مخزن خصوصی نداری — همه‌چیز عمومی است." : "No private repositories."),
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gh:home" }]]), true,
    );
  },

  async orgs(h: H) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);
    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "🏢 در حال خواندن سازمان‌ها…" : "🏢 loading organizations…");
    const list = await gh.get<{ login: string; description: string | null; public_repos?: number }[]>("/user/orgs?per_page=30", 600).catch(() => []);
    await h.reply(
      list.length
        ? `🏢 <b>${fa ? "سازمان‌های من" : "My organizations"}</b>\n\n` +
          list.map((o, i) => `${i + 1}. <b>${tgEscape(o.login)}</b>${o.public_repos != null ? ` — ${fmt(o.public_repos)} ${fa ? "مخزن عمومی" : "repos"}` : ""}${o.description ? `\n   <i>${tgEscape(o.description.slice(0, 100))}</i>` : ""}`).join("\n")
        : (fa ? "🏢 عضو هیچ سازمانی نیستی." : "No organizations."),
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gh:home" }]]), true,
    );
  },

  async starred(h: H, page = 0) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);
    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "⭐ در حال خواندن ستاره‌ها…" : "⭐ loading stars…");
    const per = 10;
    const list = await gh.get<GhRepo[]>(`/user/starred?sort=created&direction=desc&per_page=${per}&page=${page + 1}`, 60).catch(() => [] as GhRepo[]);
    if (!list.length) return h.reply(fa ? "⭐ ستاره‌ای ثبت نشده." : "no stars", kb([[{ text: "◀️", cb: "gh:home" }]]), true);
    const rows: any[] = [];
    if (page > 0) rows.push([{ text: "⬅️", cb: `gh:starred:${page - 1}` }]);
    if (list.length === per) rows.push([{ text: "➡️", cb: `gh:starred:${page + 1}` }]);
    rows.push([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gh:home" }]);
    await h.reply(
      `⭐ <b>${fa ? "ستاره‌های من" : "My stars"}</b> — ${fa ? "صفحه" : "page"} ${page + 1}\n\n` +
        list.map((r, i) => `${page * per + i + 1}. <b>${tgEscape(r.full_name)}</b> · ⭐ ${fmt(r.stargazers_count)} · ${r.language ? tgEscape(r.language) : "—"}`).join("\n"),
      kb(...rows), true,
    );
  },

  /** Deeper numbers: sizes, activity, per-repo breakdown. */
  async stats(h: H) {
    const fa = h.loc === "fa";
    if (!h.userToken) return this.needsLink(h);
    const gh = new GithubRest(h.env, h.userToken);
    await h.loading(fa ? "📊 در حال محاسبه…" : "📊 computing…");
    const repos = await gh.paginate<GhRepo>("/user/repos?affiliation=owner&sort=pushed", 3, 100).catch(() => [] as GhRepo[]);
    if (!repos.length) return h.reply(fa ? "مخزنی نیست." : "no repos", kb([[{ text: "◀️", cb: "gh:home" }]]), true);
    const byLang = [...repos.reduce((m, r) => m.set(r.language ?? "—", (m.get(r.language ?? "—") ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    const top = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 5);
    const stale = repos.filter((r) => r.pushed_at && Date.now() - Date.parse(r.pushed_at) > 365 * 86400000).length;
    const empty = repos.filter((r) => !r.description).length;
    const big = [...repos].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 3);
    await h.reply(
      `📊 <b>${fa ? "آمار دقیق حساب" : "Account details"}</b>\n\n` +
        `<b>${fa ? "به تفکیک زبان" : "By language"}</b>\n` + byLang.map(([l, n]) => `• ${tgEscape(l)}: <b>${n}</b>`).join("\n") +
        `\n\n<b>${fa ? "پرستاره‌ترین‌ها" : "Most starred"}</b>\n` + top.map((r, i) => `${i + 1}. <b>${tgEscape(r.full_name)}</b> — ⭐ ${fmt(r.stargazers_count)} · 🍴 ${fmt(r.forks_count)}`).join("\n") +
        `\n\n<b>${fa ? "بزرگ‌ترین‌ها" : "Largest"}</b>\n` + big.map((r) => `• <b>${tgEscape(r.full_name)}</b> — ${fmt(Math.round((r.size ?? 0) / 1024))}MB`).join("\n") +
        `\n\n<b>${fa ? "نکته‌های نگهداری" : "Maintenance"}</b>\n` +
        `• ${fa ? "بدون پوش در یک سال" : "No push in a year"}: <b>${stale}</b>\n` +
        `• ${fa ? "بدون توضیح" : "No description"}: <b>${empty}</b>\n` +
        `• ${fa ? "آرشیوشده" : "Archived"}: <b>${repos.filter((r) => r.archived).length}</b>\n` +
        `• ${fa ? "فورک" : "Forks"}: <b>${repos.filter((r) => r.fork).length}</b>`,
      kb([[{ text: "📦 " + (fa ? "مخزن‌ها" : "Repos"), cb: "gh:repos:0" }, { text: "🔁 " + (fa ? "تازه‌سازی" : "Refresh"), cb: "gh:stats" }], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gh:home" }]]),
      true,
    );
  },
};
