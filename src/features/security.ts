import type { H } from "../core/handler";
import { setMode } from "../core/mode";
import { GithubRest } from "../github/rest";
import { SecurityEngine } from "../github/osv";
import { fmt, truncate } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * SECURITY HUB — vulnerability intelligence that actually runs.
 *  • full dependency scan: manifests → OSV.dev batch API → ranked findings
 *  • secret heuristics over high-risk files (.env, configs, compose)
 *  • advisory monitoring & alert subscriptions (deduped in `advisories`)
 *  • posture score per repository with remediation advice
 */
export class SecurityFeature {
  async home(h: H) {
    const fa = h.loc === "fa";
    const recent = await h.env.DB.prepare(
      `SELECT full_name, severity, summary, published FROM advisories ORDER BY seen_at DESC LIMIT 5`,
    ).all<any>().catch(() => ({ results: [] as any[] }));
    await h.reply(
      `🛡 <b>${fa ? "مرکز امنیت" : "Security hub"}</b>\n\n` + (fa
        ? "اسکن واقعی وابستگی‌ها با دیتابیس OSV (همان دیتابیس Google/GitHub)، جست‌وجوی کلیدهای لو رفته و پایش هشدارها.\n\n" +
          "• <b>اسکن مخزن</b> — همه manifestها خوانده و وابستگی‌ها با OSV تطبیق داده می‌شوند\n" +
          "• <b>جست‌وجوی کلید</b> — الگوهای AWS/GitHub/Stripe/Telegram/کلید خصوصی\n" +
          "• <b>پایش</b> — با اشتراک، هر CVE جدید همان لحظه به تلگرامت می‌رسد"
        : "Real dependency scanning via OSV.dev, secret heuristics and advisory monitoring."),
      kb(
        [
          { text: "🔬 " + (fa ? "اسکن مخزن" : "Scan a repo"), cb: "sec:scan" },
          { text: "🔑 " + (fa ? "جست‌وجوی کلید" : "Secret hunt"), cb: "sec:secrets" },
        ],
        [
          { text: "📡 " + (fa ? "پایش CVE جدید" : "Monitor new CVEs"), cb: "sec:watch" },
          { text: "🧰 " + (fa ? "شبکه و IP" : "Network tools"), cb: "u:ip" },
        ],
        recent.results?.length
          ? [[{ text: "🗂 " + (fa ? "هشدارهای اخیر" : "Recent advisories"), cb: "sec:recent" }]]
          : [],
        
      ),
      !!h.cbId,
    );
  }

  async askRepo(h: H, action: string) {
    const fa = h.loc === "fa";
    await setMode(h.session, `sec:${action === "secrets" ? "secrets" : "scan"}`);
    await h.reply(
      `🛡 <b>${action === "secrets" ? (fa ? "جست‌وجوی کلید لو رفته" : "Secret hunt") : (fa ? "اسکن آسیب‌پذیری" : "Vulnerability scan")}</b>\n\n` +
        (fa ? "اسم مخزن را بفرست (فرمت <code>owner/repo</code>)." : "Send the repo (owner/repo).") +
        (action === "secrets" ? `\n\n<i>${fa ? "فایل‌های بررسی‌شده: .env, config.js, config.json, settings.py, docker-compose.yml, .npmrc" : ""}</i>` : "") +
        `\n\n${fa ? "نمونه" : "e.g."}: <code>${action === "secrets" ? "/secrets" : "/security"} django/django</code>`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "sec:home" }]]),
    );
  }

  /** Full dependency scan (the flagship security feature). */
  async scan(h: H, full: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🔬 در حال اسکن وابستگی‌ها با OSV…" : "🔬 scanning dependencies with OSV…");
    const gh = new GithubRest(h.env);
    const engine = new SecurityEngine(h.env, gh);
    const [result, secrets] = await Promise.all([
      engine.scanRepo(full, { maxManifests: 3 }).catch(() => ({ manifests: [] as any[], vulns: [] as any[], counts: {} as Record<string, number> })),
      engine.secretHeuristics(full).catch(() => []),
    ]);

    const order = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"] as const;
    const sevIcon: Record<string, string> = { CRITICAL: "🟥", HIGH: "🟧", MODERATE: "🟨", LOW: "🟩", UNKNOWN: "⬜️" };
    const counts: Record<string, number> = (result.counts ?? {}) as Record<string, number>;
    const total = result.vulns.length;
    const score = Math.max(0, 100 - (counts.CRITICAL ?? 0) * 30 - (counts.HIGH ?? 0) * 15 - (counts.MODERATE ?? 0) * 5 - (counts.LOW ?? 0));
    const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

    /* A security report wants to be scanned in one glance: the grade and the
       severity counts as a table, each vulnerability a row, the manifests in
       a collapsible section, the secret warnings in an aside of their own. */
    const { richDoc } = await import("../hub/richdoc");
    const { table, details, aside, ul, p } = await import("../tg/rich");
    const sevRows: string[][] = [["severity", fa ? "تعداد" : "count"]];
    for (const s of order) if (counts[s]) sevRows.push([`${sevIcon[s]} ${s}`, `<b>${counts[s]}</b>`]);
    const vulnItems = result.vulns.slice(0, 10).map((v: any) =>
      `${sevIcon[v.severity]} <b>${v.severity}</b> — <code>${tgEscape(v.package)}</code>${v.fixed ? ` → ${fa ? "اصلاح در" : "fix"} ${code(v.fixed)}` : ""}<br>` +
      `${tgEscape(truncate(v.summary, 110))}<br>` +
      `${v.url ? `<a href="${v.url}">${tgEscape(v.id)}</a>` : tgEscape(v.id)}${v.aliases?.length ? ` · ${v.aliases.slice(0, 2).map((a: string) => code(a)).join(" ")}` : ""}`,
    );
    const manifestItems = result.manifests.map((m: any) => `<code>${tgEscape(m.path)}</code> — ${m.eco}, ${m.deps} ${fa ? "وابستگی" : "deps"}`);
    const body = [
      sevRows.length > 1 ? table(sevRows, { caption: fa ? "آسیب‌پذیری‌های وابستگی‌ها (OSV.dev)" : "dependency advisories (OSV.dev)" }) : "",
      total
        ? ul(vulnItems) + (total > 10 ? p(`<i>…${fa ? `و ${total - 10} مورد دیگر` : `and ${total - 10} more`}</i>`) : "")
        : aside(fa ? "هیچ آسیب‌پذیری شناخته‌شده‌ای در وابستگی‌ها پیدا نشد ✅" : "No known vulnerabilities found ✅", fa ? "سالم" : "clean"),
      manifestItems.length
        ? details(`📦 ${fa ? `مانیفست‌های بررسی‌شده (${manifestItems.length})` : `manifests scanned (${manifestItems.length})`}`, ul(manifestItems))
        : "",
      secrets.length
        ? aside(
            `🔑 <b>${fa ? "هشدار کلید" : "Secret warnings"}</b><br>` +
              secrets.map((s: any) => `⚠️ <code>${tgEscape(s.file)}</code> — ${tgEscape(s.kind)}`).join("<br>") +
              `<br><i>${fa ? "این‌ها الگوی احتمالی‌اند؛ مطمئن شو کلید واقعی جا نمانده و فوراً rotate کن." : "heuristic matches — rotate anything real."}</i>`,
            fa ? "کلیدهای احتمالی" : "possible secrets")
        : "",
      p(`📚 ${fa ? "منابع" : "Sources"}: <a href="https://osv.dev">OSV.dev</a> · <a href="https://github.com/${full}/security">GitHub advisories</a>`),
    ].filter(Boolean).join("\n");

    await h.replyRich(
      richDoc({
        title: `🛡 ${tgEscape(full)} — ${fa ? "گزارش امنیتی" : "Security report"}`,
        meta: `🎓 ${fa ? "نمره" : "score"}: <b>${score}/100 (${grade})</b> · ${total} ${fa ? "آسیب‌پذیری" : "advisories"}`,
        body,
      }),
      kb(
        [
          { text: "🔔 " + (fa ? "هشدار CVE برای این مخزن" : "Alert me on CVEs"), cb: `sub:add:${full}:security` },
          { text: "📥 " + (fa ? "دانلود و بررسی محلی" : "Get source"), cb: `d:repo:${full}` },
        ],
        [
          { text: "🛰 " + (fa ? "کاوش عمیق" : "Deep scout"), cb: `s:go:${full}` },
          { text: "🧰 " + (fa ? "ابزار شبکه" : "Network tools"), cb: "u:ip" },
        ],
      ),
      !!h.cbId,
    );

    // remember for monitoring
    for (const v of result.vulns.slice(0, 25)) {
      await h.env.DB.prepare(`INSERT OR REPLACE INTO advisories (id, full_name, severity, summary, published, seen_at) VALUES (?,?,?,?,?,?)`)
        .bind(v.id, full, v.severity, v.summary.slice(0, 300), "", Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    await h.store.event(h.u.id, "security", full, { total, critical: counts.CRITICAL ?? 0 });
    await h.store.addXp(h.u.id, 2, "security_scan");
  }

  async secrets(h: H, full: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🔑 در حال جست‌وجوی کلیدها…" : "🔑 hunting secrets…");
    const gh = new GithubRest(h.env);
    const engine = new SecurityEngine(h.env, gh);
    const hits = await engine.secretHeuristics(full).catch(() => []);
    const files = [".env", ".env.example", "config.js", "config.json", "settings.py", "docker-compose.yml", ".npmrc"];
    await h.reply(
      `🔑 <b>${tgEscape(full)}</b> — ${fa ? "نتیجه جست‌وجوی کلید" : "secret hunt"}\n\n` +
        (hits.length
          ? hits.map((s) => `⚠️ <code>${tgEscape(s.file)}</code> — <b>${tgEscape(s.kind)}</b>`).join("\n") +
            `\n\n🚨 <b>${fa ? "اقدام فوری" : "Immediate actions"}</b>\n` +
            (fa
              ? `1. کلید را در سرویس مبدأ <b>باطل و بازتولید</b> کن (rotate)\n2. تاریخچه git را بازنویسی کن: <code>git filter-repo --path .env --invert-paths</code>\n3. <code>.env</code> را در <code>.gitignore</code> بگذار\n4. از <code>gitleaks</code> یا GitHub secret scanning استفاده کن`
              : `1. rotate the key  2. purge history  3. .gitignore  4. enable secret scanning`)
          : `✅ ${fa ? "در فایل‌های پرخطر الگوی مشکوکی پیدا نشد." : "No suspicious patterns in high-risk files."}`) +
        `\n\n<i>${fa ? "فایل‌های بررسی‌شده" : "checked"}: ${files.map((f) => code(f)).join(" ")}</i>`,
      kb(
        [
          { text: "🛡 " + (fa ? "اسکن کامل" : "Full scan"), cb: `sec:repo:${full}` },
          { text: "🌐 " + (fa ? "فایل‌ها" : "Files"), cb: `r:files:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "sec:home" }],
      ),
      !!h.cbId,
    );
  }

  async watch(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT full_name, COUNT(*) AS c FROM advisories GROUP BY full_name ORDER BY c DESC LIMIT 10`,
    ).all<any>().catch(() => ({ results: [] as any[] }));
    await h.reply(
      `📡 <b>${fa ? "پایش آسیب‌پذیری‌ها" : "Vulnerability monitoring"}</b>\n\n` + (fa
        ? "مخازنی که در سیستم رصد می‌شوند و تعداد هشدار ثبت‌شده:\n\n" +
          ((results ?? []).map((r) => `• <b>${tgEscape(r.full_name)}</b> — ${r.c}`).join("\n") || "<i>—</i>") +
          "\n\nبرای فعال‌سازی هشدار لحظه‌ای، روی هر مخزن 🔔 را بزن و گزینه امنیت را انتخاب کن."
        : "Monitored repos and recorded advisories."),
      kb(
        [{ text: "🧰 " + (fa ? "ابزار شبکه" : "Network"), cb: "u:ip" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "sec:home" }],
      ),
      !!h.cbId,
    );
  }

  async recent(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT full_name, severity, summary, seen_at FROM advisories ORDER BY seen_at DESC LIMIT 20`,
    ).all<any>().catch(() => ({ results: [] as any[] }));
    const icon: Record<string, string> = { CRITICAL: "🟥", HIGH: "🟧", MODERATE: "🟨", LOW: "🟩", UNKNOWN: "⬜️" };
    await h.reply(
      `🗂 <b>${fa ? "هشدارهای اخیر" : "Recent advisories"}</b>\n\n` +
        ((results ?? []).map((r) => `${icon[r.severity] ?? "⬜️"} <b>${tgEscape(r.full_name)}</b> — ${tgEscape(truncate(r.summary, 90))}`).join("\n") ||
          (fa ? "<i>هنوز چیزی ثبت نشده. یک اسکن انجام بده.</i>" : "<i>nothing yet</i>")),
      kb([[{ text: "🔬 " + (fa ? "اسکن جدید" : "New scan"), cb: "sec:scan" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "sec:home" }]]),
      !!h.cbId,
    );
  }
}
