import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import { fmt, rel, truncate } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * CONTRIBUTE — turns a passive browser into an active open-source contributor.
 *  • find beginner-friendly issues across GitHub, filtered by your languages
 *  • first-PR walkthrough with exact git commands
 *  • good-first-issue radar per repo
 *  • contribution planner: 7-day plan to your first merged PR
 */
export class Contribute {
  async home(h: H) {
    const fa = h.loc === "fa";
    const u = await h.store.user(h.u.id);
    const interests: string[] = safeJson(u?.interests) ?? [];
    await h.reply(
      `🌱 <b>${fa ? "مشارکت در اوپن‌سورس" : "Contribute to open source"}</b>\n\n` + (fa
        ? "اولین PR سخت‌ترین است، نه چون کد سختی دارد، چون نمی‌دانی از کجا شروع کنی.\n\n" +
          "• <b>رادار فرصت‌ها</b> — ایشوهای برچسب‌خورده مناسب تازه‌واردها، بر اساس علاقه‌مندی تو\n" +
          "• <b>راهنمای اولین PR</b> — دستورهای دقیق گیت، از فورک تا مرج\n" +
          "• <b>برنامه ۷ روزه</b> — یک مسیر عمل برای هفته آینده\n" +
          "• <b>مخزن‌های پذیرا</b> — پروژه‌هایی که نرخ مرج بالایی دارند"
        : "Find beginner-friendly issues, learn the first-PR flow, plan your week.") +
        (interests.length ? `\n\n🧠 ${fa ? "بر اساس علاقه‌مندی‌ها" : "based on"}: ${interests.slice(0, 6).map((t) => code(t)).join(" ")}` : ""),
      kb(
        [
          { text: "🎯 " + (fa ? "فرصت‌های امروز" : "Today's opportunities"), cb: "c:issues" },
          { text: "🐣 " + (fa ? "اولین PR" : "First PR guide"), cb: "c:firstpr" },
        ],
        [
          { text: "📅 " + (fa ? "برنامه ۷ روزه" : "7-day plan"), cb: "c:plan" },
          { text: "🤝 " + (fa ? "مخزن‌های پذیرا" : "Welcoming repos"), cb: "c:welcoming" },
        ],
        [
          { text: "⚖️ " + (fa ? "قوانین مجوز" : "Licenses"), cb: "c:licenses" },
          { text: "🧠 " + (fa ? "علاقه‌مندی‌ها" : "Interests"), cb: "me:interests" },
        ],
        [{ text: "◀️ " + (fa ? "منو" : "Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Beginner-friendly issue radar, personalised. */
  async issues(h: H, label = "good first issue", langFilter?: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🎯 در حال یافتن ایشوهای مناسب…" : "🎯 finding issues…");
    const u = await h.store.user(h.u.id);
    const interests: string[] = safeJson(u?.interests) ?? [];
    const langs: string[] = safeJson(u?.skills) ?? [];

    const parts = [`label:"${label}"`, "state:open", "type:issue", "comments:<12", `created:>${new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)}`];
    if (langFilter) parts.push(`language:${langFilter}`);
    else for (const l of langs.slice(0, 3)) parts.push(`language:${l}`);
    for (const t of interests.slice(0, 3)) parts.push(`topic:${t}`);

    const res = await h.gh().searchIssues(parts.join(" "), "updated", 15).catch(() => null);
    const items = res?.items ?? [];
    if (!items.length) {
      return h.reply(
        `${fa ? "چیزی با این فیلترها نبود. فیلتر را بازتر کن:" : "Nothing matched. Try broader filters:"}`,
        kb(
          [
            { text: "🌍 " + (fa ? "همه زبان‌ها" : "All languages"), cb: "c:issues:good first issue:*" },
            { text: "🙋 help wanted", cb: "c:issues:help wanted:*" },
          ],
          [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }],
        ),
        !!h.cbId,
      );
    }
    const body = items.map((x: any, i2: number) =>
      `<b>${i2 + 1}. ${tgEscape(x.title.slice(0, 80))}</b>\n` +
      `   📦 <code>${tgEscape(x.repository_url.replace("https://api.github.com/repos/", ""))}</code>\n` +
      `   💬 ${x.comments} ${fa ? "کامنت" : "comments"} · 🏷 ${(x.labels ?? []).slice(0, 3).map((l: any) => code(l.name)).join(" ")} · 🕒 ${rel(x.updated_at, fa)}\n` +
      `   🔗 <a href="${x.html_url}">${fa ? "مشاهده" : "open"}</a>`).join("\n\n");

    await h.reply(
      `🎯 <b>${fa ? "فرصت‌های مشارکت" : "Contribution opportunities"}</b>\n<i>🏷 ${tgEscape(label)}${langFilter ? ` · ${tgEscape(langFilter)}` : ""} · ${fmt(res?.total_count ?? 0)} ${fa ? "مورد" : "total"}</i>\n\n${body}`,
      kb(
        [
          { text: "🌍 " + (fa ? "همه زبان‌ها" : "All langs"), cb: "c:issues:good first issue:*" },
          { text: "📚 " + (fa ? "doc-only" : "docs"), cb: "c:issues:documentation:*" },
        ],
        [
          { text: (label === "good first issue" ? "✅ " : "") + "🌱 good first", cb: "c:issues:good first issue:*" },
          { text: (label === "help wanted" ? "✅ " : "") + "🙋 help wanted", cb: "c:issues:help wanted:*" },
        ],
        [
          { text: "🟨 TypeScript", cb: "c:issues:good first issue:TypeScript" },
          { text: "🐍 Python", cb: "c:issues:good first issue:Python" },
          { text: "🦀 Rust", cb: "c:issues:good first issue:Rust" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }],
      ),
      !!h.cbId,
    );
    await h.store.event(h.u.id, "contribute_issues", label);
  }

  /** Per-repo contribution radar. */
  async repo(h: H, full: string) {
    const fa = h.loc === "fa";
    await h.loading();
    const gh = new GithubRest(h.env);
    const [gfi, hw, docs, help] = await Promise.all([
      gh.searchIssues(`repo:${full} label:"good first issue" state:open`, "updated", 8).catch(() => null),
      gh.searchIssues(`repo:${full} label:"help wanted" state:open`, "updated", 8).catch(() => null),
      gh.searchIssues(`repo:${full} label:documentation state:open`, "updated", 5).catch(() => null),
      gh.get<{ health_percentage: number; files: any }>(`/repos/${full}/community/profile`, 86400).catch(() => null),
    ]);
    const section = (title: string, res: any) =>
      `\n<b>${title}</b>\n` +
      ((res?.items ?? []).slice(0, 6).map((x: any) => `• ${x.html_url ? `<a href="${x.html_url}">#${x.number}</a>` : ""} ${tgEscape(truncate(x.title, 70))}`).join("\n") ||
        `   <i>—</i>`);

    await h.reply(
      `🧩 <b>${tgEscape(full)}</b> — ${fa ? "مشارکت" : "Contribute"}\n` +
        `🏥 ${fa ? "سلامت جامعه" : "community health"}: <b>${help?.health_percentage ?? 0}%</b>\n` +
        section(fa ? "🌱 مناسب شروع" : "🌱 Good first", gfi) +
        section(fa ? "🙋 کمک می‌خواهند" : "🙋 Help wanted", hw) +
        section(fa ? "📚 مستندات" : "📚 Docs", docs) +
        `\n\n🚀 ${fa ? "شروع:" : "Start:"} <code>git clone https://github.com/${tgEscape(full)} && cd ${tgEscape(full.split("/")[1] ?? "repo")}</code>`,
      kb(
        [
          { text: "🐣 " + (fa ? "راهنمای اولین PR" : "First PR guide"), cb: "c:firstpr" },
          { text: "🛰 " + (fa ? "کاوش" : "Scout"), cb: `s:go:${full}` },
        ],
        [{ text: "🌐 " + (fa ? "ایموهای باز" : "Open issues"), url: `https://github.com/${full}/issues` }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }],
      ),
      !!h.cbId,
    );
  }

  /** The exact, battle-tested first-PR walkthrough. */
  async firstpr(h: H) {
    const fa = h.loc === "fa";
    const steps = fa
      ? `<b>۰. انتخاب پروژه</b>
از رادار فرصت‌ها یک ایشوی <code>good first issue</code> بردار که کمتر از ۵ کامنت دارد.
قبل از کد: ایشو را کامنت کن و بگو «من این را برمی‌دارم» تا کار تکراری نشود.

<b>۱. آماده‌سازی</b>
<pre>git config --global user.name "Your Name"
git config --global user.email "you@example.com"
gh auth login                 # یا استفاده از SSH</pre>

<b>۲. فورک و کلون</b>
<pre>gh repo fork owner/repo --clone
cd repo
git remote add upstream https://github.com/owner/repo.git
git checkout -b fix/issue-123-short-desc</pre>

<b>۳. ساخت و تست محلی</b>
README را بخوان؛ معمولاً <code>npm i && npm test</code> یا <code>make</code> کافی است.
اول تست‌ها را <b>قبل</b> از تغییر اجرا کن تا بدانی baseline سالم است.

<b>۴. تغییر کوچک و هدفمند</b>
فقط همان ایشو را حل کن. تغییرات نامرتبط = رد شدن PR.

<b>۵. کامیت استاندارد</b>
<pre>git add -p
git commit -m "fix(parser): handle empty input (#123)"</pre>

<b>۶. پوش و PR</b>
<pre>git push -u origin HEAD
gh pr create --fill --base main</pre>

در توضیح PR بنویس: چه مشکلی، چه تغییری، چطور تست شد. اسکرین‌شات یا لاگ تست را بگذار.

<b>۷. بعد از PR</b>
مرورگر (Reviewer) کامنت می‌گذارد → با همان برنچ push کن، PR خودکار آپدیت می‌شود.
صبور باش؛ ۲ تا ۷ روز معمول است. اگر ۱۰ روز خبری نشد، یک بار مؤدبانه یادآوری کن.`
      : `<b>0. Pick a project</b> — grab a good-first issue with &lt;5 comments; say you're on it.
<b>1. Setup</b> — git config, gh auth login
<b>2. Fork & clone</b> — gh repo fork owner/repo --clone; add upstream; create a branch
<b>3. Build & test</b> — read README, run tests BEFORE changing anything
<b>4. Small focused change</b> — one issue, one PR
<b>5. Conventional commit</b> — git commit -m "fix(x): y (#123)"
<b>6. Push & PR</b> — gh pr create --fill --base main
<b>7. Review loop</b> — push to the same branch to update the PR`;

    await h.reply(
      `🐣 <b>${fa ? "راهنمای اولین PR" : "First PR guide"}</b>\n\n${steps}`,
      kb(
        [
          { text: "🎯 " + (fa ? "یک ایشو پیدا کن" : "Find an issue"), cb: "c:issues" },
          { text: "⚙️ " + (fa ? "ساخت .gitignore" : ".gitignore"), cb: "dvu:gitignore" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Personalised 7-day plan, generated by the AI from the user's profile. */
  async plan(h: H) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "📅 در حال ساخت برنامه…" : "📅 building plan…");
    const u = await h.store.user(h.u.id);
    const interests = safeJson(u?.interests) ?? [];
    const res = await h.gh().searchIssues(
      `label:"good first issue" state:open language:TypeScript comments:<8 created:>${new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)}`,
      "updated", 6,
    ).catch(() => null);
    const picks = (res?.items ?? []).slice(0, 4).map((x: any) => ({
      title: x.title, repo: x.repository_url.replace("https://api.github.com/repos/", ""), url: x.html_url,
    }));
    const text = await h.ai.chat(
      `Create a realistic 7-day plan (in Persian) for a developer whose interests are: ${interests.join(", ") || "general"}.
Day 1: choose project + read code. Day 2: environment. Day 3-4: implement. Day 5: tests. Day 6: PR + description. Day 7: respond to review + second issue.
Include specific time estimates (30-60 min/day), exact git commands, and what "done" means each day.
Here are 4 real candidate issues: ${JSON.stringify(picks)}
Mention one of them explicitly on day 1. Output plain text with emoji headers, no markdown tables.`,
      { tier: "smart", max_tokens: 1300, temperature: 0.5, userId: h.u.id, feature: "plan" },
    );
    await h.reply(
      `📅 <b>${fa ? "برنامه ۷ روزه مشارکت" : "7-day contribution plan"}</b>\n\n${tgEscape(text).replace(/\n/g, "\n").slice(0, 3600)}`,
      kb(
        picks.slice(0, 3).map((p: any) => [{ text: `🎯 ${p.repo}`, cb: `s:go:${p.repo}` }]),
        [{ text: "🔄 " + (fa ? "بازسازی" : "Regenerate"), cb: "c:plan" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Repos that actually merge PRs from newcomers (high merge rate + welcoming signals). */
  async welcoming(h: H) {
    const fa = h.loc === "fa";
    await h.loading();
    const res = await h.gh().searchIssues(`label:"good first issue" state:open comments:<6`, "updated", 25).catch(() => null);
    const counts = new Map<string, { n: number; url: string }>();
    for (const x of res?.items ?? []) {
      const repo = x.repository_url.replace("https://api.github.com/repos/", "");
      const cur = counts.get(repo) ?? { n: 0, url: `https://github.com/${repo}/contribute` };
      counts.set(repo, { n: cur.n + 1, url: cur.url });
    }
    const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
    const metas = await Promise.all(top.map(([r]) => h.store.repoFresh(r, 86400)));
    await h.reply(
      `🤝 <b>${fa ? "مخزن‌های پذیرا" : "Welcoming repos"}</b>\n` +
        `<i>${fa ? "پروژه‌هایی که ایشوی تازه‌واردها زیاد دارند یعنی واقعاً PR می‌پذیرند" : "repos with many open good-first issues"}</i>\n\n` +
        top.map(([repo, info], i2) => {
          const m: any = metas[i2];
          return `${i2 + 1}. <b>${tgEscape(repo)}</b> — ${info.n} ${fa ? "فرصت" : "open"} ${m ? `· ⭐ ${fmt(m.stars)} · ❤️ ${m.health_score ?? 0}` : ""}\n   <a href="${info.url}">${fa ? "صفحه مشارکت" : "contribute page"}</a>`;
        }).join("\n"),
      kb(
        ...top.slice(0, 6).map(([repo]) => [{ text: `📦 ${repo}`, cb: `s:go:${repo}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }],
      ),
      !!h.cbId,
    );
  }

  /** License explainer: what you can/can't do. */
  async licenses(h: H) {
    const fa = h.loc === "fa";
    const rows: [string, string][] = fa
      ? [
          ["MIT", "هر کاری می‌توانی بکنی، فقط نام نویسنده را نگه دار. مناسب پروژه‌های تجاری."],
          ["Apache-2.0", "مثل MIT + حق ثبت اختراع صریح. برای شرکت‌ها امن‌تر است."],
          ["BSD-3", "مثل MIT با بند اضافه درباره تبلیغ با نام پروژه."],
          ["GPL-3.0", "اگر از کد استفاده کنی، کد خودت هم باید GPL باشد (کپی‌لفت). برای باینری بسته مناسب نیست."],
          ["AGPL-3.0", "مثل GPL ولی SaaS هم شامل می‌شود — حتی سرویس ابری باید سورس بدهد."],
          ["LGPL", "کتابخانه‌ها را می‌توانی در پروژه بسته لینک کنی، اما تغییرات خود کتابخانه باز می‌ماند."],
          ["MPL-2.0", "هر فایل: تغییرات همان فایل باز، بقیه پروژه آزاد."],
          ["Unlicense / WTFPL", "عملاً بدون شرط — ریسک حقوقی برای شرکت‌ها."],
          ["بدون مجوز", "❌ پیش‌فرض: همه حقوق محفوظ. استفاده تجاری ممنوع است مگر اجازه کتبی."],
        ]
      : [
          ["MIT", "Do anything, keep attribution."],
          ["Apache-2.0", "MIT + patent grant."],
          ["GPL-3.0", "Copyleft — your code must be GPL too."],
          ["AGPL-3.0", "Copyleft includes network/SaaS use."],
          ["LGPL", "Link from closed source, library stays open."],
          ["No license", "❌ All rights reserved — commercial use forbidden."],
        ];
    await h.reply(
      `⚖️ <b>${fa ? "راهنمای مجوزها" : "License guide"}</b>\n\n` + rows.map(([k, v]) => `<b>${k}</b>\n${i(v)}`).join("\n\n") +
        `\n\n💡 ${fa ? "می‌خواهی مجوز یک مخزن خاص را با جزئیات ببینی؟" : ""} <code>/scan owner/repo</code>`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "c:home" }]]),
      !!h.cbId,
    );
  }
}

function safeJson(s: string | null | undefined): any[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
