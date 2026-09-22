/**
 * Offline query understanding — no model, no network, no quota.
 *
 * The search path used to depend entirely on an LLM to turn «یک ابزار خوب برای
 * مانیتورینگ سرور» into a GitHub query. When the model was unavailable (or the
 * account's neurons were spent) the Persian sentence went to GitHub verbatim,
 * matched nothing, and every search ended in "چیزی پیدا نشد" no matter what the
 * user typed. This module makes search work with the AI switched off, and makes
 * the AI's answer better when it is on: the model now gets a starting query
 * instead of having to invent one.
 */

/** Persian/Arabic tech vocabulary → the English words GitHub actually indexes. */
const FA_TECH: Record<string, string[]> = {
  // infrastructure / ops
  سرور: ["server"], مانیتورینگ: ["monitoring", "observability"], پایش: ["monitoring"],
  زیرساخت: ["infrastructure"], کانتینر: ["container", "docker"], داکر: ["docker"],
  کوبرنتیز: ["kubernetes"], ابر: ["cloud"], کلاد: ["cloud"], فایر: ["firewall"],
  فایروال: ["firewall"], شبکه: ["network"], پروکسی: ["proxy"], تونل: ["tunnel"],
  دیپلوی: ["deploy", "deployment"], استقرار: ["deployment"], سی‌آی: ["ci", "cicd"],
  مانیتور: ["monitor"], لاگ: ["logging", "logs"], متریک: ["metrics"],
  هشدار: ["alerting", "alerts"], بکاپ: ["backup"], بازیابی: ["restore"],
  پشتیبان: ["backup"], مقیاس: ["scaling", "scalable"], تعادل: ["load-balancer", "balancer"],
  واکشی: ["retrieval"],
  // data / ai
  هوش: ["ai"], مصنوعی: ["ai"], یادگیری: ["machine-learning"], ماشین: ["machine-learning"],
  مدل: ["model", "llm"], زبانی: ["llm", "language-model"], داده: ["data"],
  پایگاه: ["database"], دیتابیس: ["database"], دیتا: ["data", "dataset"], جستجو: ["search"],
  جست‌وجو: ["search"], برداری: ["vector", "embedding"],
  تصویر: ["image"], ویدیو: ["video"], صدا: ["audio", "speech"], تشخیص: ["detection"],
  ترجمه: ["translation"], خلاصه: ["summarization", "summary"], متن: ["text", "nlp"],
  // web / app
  وب: ["web"], سایت: ["website"], فرانت: ["frontend"], فرانت‌اند: ["frontend"],
  بک‌اند: ["backend"], بکند: ["backend"], اپ: ["app"], اپلیکیشن: ["application"],
  ری‌اکت: ["react"], ویو: ["vue"], نود: ["node"], جنگو: ["django"], لاراول: ["laravel"],
  قالب: ["template", "theme"], رابط: ["ui"], کاربری: ["ui", "ux"], داشبورد: ["dashboard"],
  پنل: ["panel", "dashboard"], فرم: ["form"], جدول: ["table", "grid"],
  // tooling / dev
  ابزار: ["tool"], کتابخانه: ["library"], فریمورک: ["framework"],
  افزونه: ["extension", "plugin"], پلاگین: ["plugin"], اسکریپت: ["script"],
  تست: ["testing", "test"], آزمون: ["test"], خطا: ["bug", "error"], باگ: ["bug"],
  بهینه: ["optimization", "performance"], سرعت: ["performance", "speed"],
  کد: ["code"], برنامه: ["program"], نویسی: ["programming", "coding"],
  رفع: ["fix"], اشکال: ["bug"], دیباگ: ["debug", "debugger"], بیلد: ["build"],
  پکیج: ["package", "package-manager"], مدیریت: ["manager"],
  نسخه: ["version", "versioning"], احراز: ["authentication", "auth"],
  هویت: ["identity"], مجوز: ["license", "permission"], رمز: ["password", "crypto"],
  رمزنگاری: ["encryption", "cryptography"], امنیت: ["security"], آسیب‌پذیری: ["vulnerability"],
  // content / community
  آموزش: ["tutorial", "learning"], یادگیری_منابع: ["learning", "resources"], مرجع: ["reference"],
  کتاب: ["book", "books"], پروژه: ["project"], مخزن: ["repository"], گیت‌هاب: ["github"],
  باز: ["open-source"], سورس: ["source", "open-source"], منبع: ["source"],
  بازی: ["game"], سرگرمی: ["entertainment"], ربات: ["bot"], تلگرام: ["telegram"],
  تلگرامی: ["telegram"], واتساپ: ["whatsapp"], خودکار: ["automation", "automatic"],
  اسکرپ: ["scraper", "crawler"], خزش: ["crawler"], دانلود: ["download", "downloader"],
  آپلود: ["upload"], فشرده: ["compression", "zip"], اشتراک: ["share", "sharing"],
  فایل: ["file"], سیستم: ["system"], لینوکس: ["linux"], ویندوز: ["windows"],
  موبایل: ["mobile", "android"], اندروید: ["android"], آیفون: ["ios"],
  هوشمند: ["ai"], سریع: ["performance"], سبک: ["lightweight"],
  ساده: ["simple"], حرفه‌ای: ["professional"], رایگان: ["free"],
  متن‌باز: ["open-source"], مخفی: ["privacy"], حریم: ["privacy"], خصوصی: ["privacy", "private"],
  آفیس: ["office"], پرداخت: ["payment"], فروشگاه: ["shop", "ecommerce"],
  مالی: ["finance", "financial"], ارز: ["currency", "crypto", "exchange"], بلاکچین: ["blockchain"],
  نمودار: ["chart", "graph", "visualization"], گراف: ["graph"], نقشه: ["map", "mapping"],
  تقویم: ["calendar"], زمان: ["time", "datetime"], یادداشت: ["notes", "note-taking"],
  ایمیل: ["email", "mail"], خبر: ["news", "rss"], فید: ["feed", "rss"],
  فیلم: ["movie", "video"], موسیقی: ["music"], پادکست: ["podcast"],
  // intents a README answers (the questions people actually ask a repo)
  نصب: ["install", "installation"], نصبش: ["install", "installation"], نصب_کنم: ["install"],
  راه‌اندازی: ["setup", "getting-started"], راه‌اندازي: ["setup"],
  پیکربندی: ["configuration", "config"], پیکربندي: ["configuration"],
  استفاده: ["usage", "how-to-use"], استفادش: ["usage"], شروع: ["getting-started", "quickstart"],
  اجرا: ["run", "execute"], اجراش: ["run"], لایسنس: ["license"],
  مشارکت: ["contributing", "contribute"], سوالات: ["faq"], پرسش‌ها: ["faq"],
  مثال: ["example", "examples"], نمونه: ["example", "demo"], مستندات: ["docs", "documentation"],
  وابستگی: ["dependencies", "requirements"], پیش‌نیاز: ["prerequisites", "requirements"],
  سازگاری: ["compatibility", "supported"], محدودیت: ["limitations"], تفاوت: ["differences", "comparison"],
  مزیت: ["advantages", "features"], ویژگی: ["features"], قابلیت: ["features", "capabilities"],
  امکانات: ["features"], پشتیبانی: ["support", "supported"], زبان‌ها: ["languages"],
  // quality / structure
  اعتبارسنجی: ["validation", "validator"], ولیدیشن: ["validation"], اسکیما: ["schema"],
  جیسون: ["json"], یامل: ["yaml"], کانفیگ: ["config", "configuration"],
  تنظیمات: ["config", "settings"], وب‌سوکت: ["websocket"], ای‌پی‌آی: ["api"], سرویس: ["service"],
  میکروسرویس: ["microservice", "microservices"], صف: ["queue"], کش: ["cache"],
  همگام: ["sync", "synchronization"], همگام‌سازی: ["sync"], نسخه‌گذاری: ["version-control", "git"],
  گیت: ["git"], پایپ‌لاین: ["pipeline"], جریان: ["stream", "streaming"], لحظه‌ای: ["realtime"],
  زنده: ["live", "realtime"], رویداد: ["event"], وب‌هوک: ["webhook"], کرون: ["cron"],
  زمان‌بند: ["scheduler"], زمان‌بندی: ["scheduler", "cron"], تست‌نویسی: ["testing"],
  پوشش: ["coverage"], لینت: ["linting", "linter"], فرمت: ["formatting", "formatter"],
  باندلر: ["bundler"], کامپایلر: ["compiler"], مفسر: ["interpreter"], مرورگر: ["browser"],
  افزونه‌پذیر: ["plugin", "extensible"], موتور: ["engine"], شبیه‌ساز: ["simulator", "emulator"],
  // security
  توکن: ["token"], کلید: ["key", "keys"], امضا: ["signature"], هش: ["hash", "hashing"],
  سندباکس: ["sandbox"], ماشین_مجازی: ["vm", "virtual-machine"], کوئری: ["query"],
  تزریق: ["injection"], نشت: ["leak", "leakage"], رصد: ["monitoring"], فیلتر: ["filter"],
  دورزدن: ["bypass"], فیلترشکن: ["proxy", "vpn"], تحریم: ["proxy", "bypass"],
  // data & ai extras
  ایمیج: ["image", "docker-image"], تنظیم: ["tuning"], پرامپت: ["prompt", "prompting"],
  عامل: ["agent"], همکار: ["copilot", "agent"], رگ: ["rag"], جاسازی: ["embedding"],
  مدل‌سازی: ["modeling"], پیش‌بینی: ["prediction", "forecast"], پیشنهاد: ["recommendation", "recommender"],
  دسته‌بندی: ["classification"], خوشه: ["clustering"], رگرسیون: ["regression"],
  باینری: ["binary"], اجرایی: ["executable", "binary"], لاگ‌گیری: ["logging"],
  رخداد: ["event", "incident"], داشبوردی: ["dashboard"], گزارش: ["report", "reporting"],
  تحلیل: ["analytics", "analysis"], آمار: ["statistics"], بصری: ["visualization"],
  نقشه_ذهنی: ["mindmap"],
  // languages (Persian names → real language names, useful as search words too)
  پایتون: ["python"], جاوااسکریپت: ["javascript"], تایپ‌اسکریپت: ["typescript"],
  تایپاسکریپت: ["typescript"], گو: ["golang"], رست: ["rust"], جاوا: ["java"],
  سی‌شارپ: ["csharp"], روبی: ["ruby"], کاتلین: ["kotlin"], سوئیفت: ["swift"],
  دارت: ["dart"], فلاتر: ["flutter"], پی‌اچ‌پی: ["php"], اسکالا: ["scala"],
  بش: ["bash"], شل: ["shell"], زیش: ["zsh"], پاورشل: ["powershell"], سی: ["c"],
  ری‌اکت_نیتیو: ["react-native"], الکترون: ["electron"], تنسور: ["tensorflow"],
  پایتورچ: ["pytorch"], پانداس: ["pandas"], نامپای: ["numpy"], ری: ["r"],
  // domains
  فروشگاهی: ["ecommerce"], انبار: ["inventory"], حسابداری: ["accounting"],
  آموزش_آنلاین: ["e-learning", "lms"], سازمانی: ["crm", "erp"], پشتیبانی_مشتری: ["helpdesk"],
  گفتگو: ["chat"], تالار: ["forum"], وبلاگ: ["blog"], مدیریت_محتوا: ["cms"],
  اشتراک_گذاری: ["sharing"], آفیس_متن‌باز: ["office", "documents"], ویکی: ["wiki"],
  یادداشت‌برداری: ["note-taking", "notes"], کارها: ["todo", "tasks"], عادت: ["habit"],
  بودجه: ["budget", "finance"], امور_مالی: ["finance"], قیمت: ["price", "pricing"],
  رمزارز: ["crypto", "cryptocurrency"], صرافی: ["exchange"], کیف‌پول: ["wallet"],
  کیفیت: ["quality", "qa"], مانیتورینگ_شبکه: ["network-monitoring", "snmp"],
  uptime: ["uptime", "status-page"], статус: ["status-page"],
  زیرنویس: ["subtitle", "subtitles"], دابینگ: ["dubbing"], متن‌به‌گفتار: ["tts", "text-to-speech"],
  گفتاربه‌متن: ["stt", "speech-to-text"], تشخیص_چهره: ["face-detection"],
  ترجمه_متن: ["translation"], خلاصه‌ساز: ["summarization"], چت‌بات: ["chatbot", "chat"],
  اتوماسیون: ["automation", "workflow"], گردش‌کار: ["workflow"], همگام‌سازی_فایل: ["file-sync"],
};

/**
 * Words that exist in nearly every repository. They are kept (they still help
 * disambiguate) but ranked last, so «مانیتورینگ سرور» searches `monitoring
 * server` instead of `tool toolkit cli`.
 */
const GENERIC = new Set([
  "tool", "toolkit", "cli", "library", "framework", "app", "application", "project", "program",
  "code", "coding", "system", "simple", "fast", "speed", "free", "lightweight", "lite",
  "professional", "pro", "smart", "manager", "management", "best", "good", "nice", "new",
]);

/** Words that only add noise to a GitHub query. */
const STOP = new Set([
  "یک", "یه", "برای", "با", "از", "در", "به", "که", "و", "یا", "این", "آن", "چه", "چی",
  "چیزی", "هر", "هم", "را", "می", "میشه", "می‌شه", "کن", "کنم", "کنه", "بده", "بفرست",
  "خوب", "بهترین", "بهترین‌ها", "خیلی", "لطفا", "لطفاً", "ممنون", "داره", "دارد", "هست",
  "a", "an", "the", "for", "with", "of", "in", "to", "and", "or", "is", "are", "best",
  "good", "me", "please", "some", "any", "how", "what", "i", "want", "need", "show",
  "ابزاری", "ابزارهایی", "چند", "تا", "رو", "بکن", "بکنید", "کنید", "داشتن", "داشته",
  "میخوام", "می‌خوام", "میخواهم", "می‌خواهم", "پیدا", "بگرد", "جستجو", "جست‌وجو",
]);

const LATIN = /^[a-z0-9][a-z0-9.+#_-]*$/i;

/** Distinctive first, generic last — the query's meaning lives in the nouns. */
export function rankKeywords(kws: string[]): string[] {
  return [...kws].sort((a, b) => Number(GENERIC.has(a)) - Number(GENERIC.has(b)));
}

/** Split a sentence into Persian and Latin tokens. */
function tokenize(text: string): string[] {
  return text
    .replace(/[\u200c\u200f\u200e]/g, " ")          // ZWNJ / bidi marks
    .replace(/[^\p{L}\p{N}.+#/_-]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Turn free text (Persian, English or a mix) into English search keywords.
 * Latin words pass through, Persian words are looked up in the vocabulary and,
 * when the exact word is unknown, the longest known prefix/substring wins so
 * «مانیتورینگی» still maps to monitoring.
 */
export function extractKeywords(text: string, max = 6): string[] {
  const out: string[] = [];
  const push = (w: string) => {
    const k = w.toLowerCase();
    if (!k || out.includes(k) || k.length < 2) return;
    out.push(k);
  };

  for (const tok of tokenize(text)) {
    if (LATIN.test(tok)) {
      if (tok.length >= 2 && !STOP.has(tok)) push(tok);
      continue;
    }
    if (STOP.has(tok)) continue;
    const exact = FA_TECH[tok];
    if (exact) { exact.forEach(push); continue; }
    // strip common Persian suffixes/prefixes and retry
    const stripped = tok.replace(/^(ال|بی|هم)/, "").replace(/(ها|های|هایی|ی|ات|ان)$/, "");
    const hit = FA_TECH[stripped] ?? FA_TECH[tok.replace(/(ها|های|هایی)$/, "")];
    if (hit) { hit.forEach(push); continue; }
    // substring match against the vocabulary (longest first)
    const key = Object.keys(FA_TECH).filter((k) => k.length >= 3 && tok.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (key) FA_TECH[key]!.forEach(push);
  }
  return out.slice(0, max);
}

/**
 * Relaxation ladder: the exact intent first, then progressively broader
 * queries. The caller walks it until GitHub returns something, so a search
 * never ends in a shrug while results exist one step down.
 */
export function searchLadder(text: string, opts: { language?: string | null; aiQuery?: string | null } = {}): string[] {
  const kws = rankKeywords(extractKeywords(text, 8));
  const lang = opts.language ? ` language:${opts.language}` : "";
  const q: string[] = [];
  if (opts.aiQuery) q.push(opts.aiQuery);
  // GitHub ANDs unquoted terms, so two strong words beat four mediocre ones
  if (kws.length >= 2) q.push(`${kws.slice(0, 2).join(" ")}${lang}`);
  if (kws.length >= 3) q.push(`${kws.slice(0, 3).join(" ")}${lang}`);
  if (kws.length >= 2) q.push(`${kws.slice(0, 4).map((k) => `"${k}"`).join(" OR ")}${lang}`);
  if (kws.length) {
    q.push(`${kws[0]}${lang}`);
    q.push(`topic:${kws[0]}`);
    q.push(`${kws[0]}${lang} stars:>200`.trim());
  }
  return [...new Set(q.map((x) => x.trim()).filter((x) => x.length > 2))];
}
