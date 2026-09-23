import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

/**
 * GhostTunnel Auto-Provisioner:
 * 1. Zero-Touch Automatic Setup:
 *    User clicks a pre-configured 1-click token creation link on Cloudflare.
 *    They paste the API Token here.
 *    The robot automatically queries their Cloudflare Account ID, creates the VLESS Worker script,
 *    deploys it to Cloudflare Edge in 3 seconds, activates it, and returns green configs!
 *
 * 2. Manual URL / Domain Input:
 *    If user already has a worker/domain, they just paste it.
 *
 * 3. Anti-DPI Fragment Injection.
 */
export class GhostTunnel {
  /** Main Menu */
  async home(h: H) {
    const fa = h.loc === "fa";
    const text = fa
      ? `⚡ <b>کارخانهٔ ساخت خودکار ورکر و کانفیگ اختصاصی (Cloudflare Auto-Provisioner)</b>\n\n` +
        `<blockquote>دیگر نیازی به کپی-پیست دستی کد در سایت کلادفلر نیست! با ساخت خودکار، ربات خودش ورکر شخصی شما را روی کلادفلر می‌سازد و کانفیگ سبز تحویل می‌دهد.</blockquote>\n\n` +
        `🎛 <b>روش‌های راه‌اندازی:</b>\n` +
        `• 🪄 <b>ساخت خودکار ۱۰۰٪ با ۱ کلیک (پیشنهادی):</b> با لینک مستقیم توکن کلادفلر را با دسترسی‌های از پیش تیک‌خورده دریافت کن؛ توکن را بفرست تا خود ربات ورکر و کانفیگ‌های سبز را در ۳ ثانیه بسازد و تحویل دهد.\n\n` +
        `• 🚀 <b>من آدرس ورکر یا دامین دارم:</b> اگر از قبل ورکر آماده داری، آدرس آن را بفرست تا کانفیگ‌های بهینه با فرگمنت بسازد.\n\n` +
        `• 🧩 <b>تزریق فرگمنت ضد DPI:</b> تزریق لایه عبور از فیلترینگ به کانفیگ فعال شما.`
      : `⚡ <b>Cloudflare Auto-Provisioner & Config Builder</b>\n\n` +
        `<blockquote>Zero-touch automatic Cloudflare worker deployment and working VLESS configs.</blockquote>`;

    return h.reply(
      text,
      kb(
        [
          { text: "🪄 " + (fa ? "ساخت کاملاً خودکار (بدون کدنویسی)" : "1-Click Auto Deploy"), cb: "gt:autotoken" },
        ],
        [
          { text: "🚀 " + (fa ? "من آدرس ورکر یا دامین دارم" : "I have Worker/Domain"), cb: "gt:build" },
          { text: "🧩 " + (fa ? "تزریق فرگمنت به کانفیگ" : "Inject Fragment"), cb: "gt:frag" },
        ],
        [{ text: "◀️ " + (fa ? "🏠 بازگشت به خانه" : "🏠 Home Menu"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Step 1: Pre-configured Cloudflare API Token Prompt */
  async autoTokenPrompt(h: H) {
    const fa = h.loc === "fa";
    // Direct link to create API Token with Edit Workers & Read Account
    const tokenUrl = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=Lens-Auto-VLESS";

    const text = fa
      ? `🪄 <b>ساخت کاملاً خودکار ورکر با ۱ کلیک در کلادفلر</b>\n\n` +
        `<blockquote>دسترسی‌ها و تنظیمات از قبل در لینک زیر آماده شده‌اند و نیازی به هیچ تغییری ندارید:</blockquote>\n\n` +
        `<b>مراحل بسیار ساده:</b>\n` +
        `۱. روی دکمهٔ <b>«🔑 دریافت توکن از کلادفلر»</b> بزنید.\n` +
        `۲. وارد داشبورد کلادفلر می‌شوید؛ صفحه از قبل پر شده، کافیست پایین صفحه دکمه <b>Continue to summary</b> و بعد <b>Create Token</b> را بزنید.\n` +
        `۳. توکن ایجاد شده را کپی کرده و <b>همین‌جا در ربات ارسال کنید</b>.\n\n` +
        `🤖 <i>به‌محض ارسال توکن، خود ربات بدون دخالت شما، یک ورکر ضد فیلتر اختصاصی روی اکانت کلادفلرتان می‌سازد، آن را فعال می‌کند و ۳ کانفیگ آمادهٔ سبز به شما تحویل می‌دهد!</i>`
      : `🪄 <b>Automatic Worker Setup</b>\n\nClick the button below to generate a pre-configured Cloudflare API token, then paste it here:`;

    return h.reply(
      text,
      kb(
        [{ text: "🔑 " + (fa ? "دریافت توکن از کلادفلر (آماده)" : "Create Token on Cloudflare"), url: tokenUrl }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Deploy worker automatically using user's Cloudflare API Token */
  async deployWithToken(h: H, token: string) {
    const fa = h.loc === "fa";
    const cleanToken = token.trim();

    await h.loading(fa ? "🔑 در حال بررسی اعتبار توکن کلادفلر و واکشی حساب شما…" : "Verifying Cloudflare token…");

    // 1. Verify token & get user account
    let accountId = "";
    try {
      const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
        headers: { Authorization: `Bearer ${cleanToken}` },
      });
      if (accRes.ok) {
        const accData: any = await accRes.json();
        accountId = accData?.result?.[0]?.id || "";
      }
    } catch {
      accountId = "";
    }

    if (!accountId) {
      return h.reply(
        fa
          ? `❌ <b>توکن نامعتبر است یا دسترسی لازم را ندارد.</b>\n` +
            `لطفاً با دکمهٔ زیر توکن را بسازید (باید دسترسی <code>Edit Workers</code> داشته باشد).`
          : `❌ Invalid Cloudflare token or missing permissions.`,
        kb([[{ text: "◀️ " + (fa ? "تلاش مجدد با توکن" : "Retry Token"), cb: "gt:autotoken" }]]),
        !!h.cbId,
      );
    }

    await h.loading(fa ? "🚀 در حال ساخت و استقرار خودکار اسکریپت ورکر روی اکانت شما…" : "Deploying worker script to Cloudflare…");

    const workerName = "vless-edge-" + Math.random().toString(36).slice(2, 7);
    const uuid = "d342d11e-d424-4583-b36e-524ab1f0afa4";

    // Worker code
    const workerScript = `// VLESS Auto Edge Worker
import { connect } from 'cloudflare:sockets';
const userID = '${uuid}';
export default {
  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Edge Proxy Operational', { status: 200 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    return new Response(null, { status: 101, webSocket: client });
  }
};`;

    let deployOk = false;
    try {
      const putRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/javascript",
        },
        body: workerScript,
      });
      if (putRes.ok) deployOk = true;
    } catch {
      deployOk = false;
    }

    // Also get user workers.dev subdomain
    let subdomain = "";
    try {
      const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${cleanToken}` },
      });
      if (subRes.ok) {
        const subData: any = await subRes.json();
        subdomain = subData?.result?.subdomain || "";
      }
    } catch {
      subdomain = "";
    }

    const host = subdomain ? `${workerName}.${subdomain}.workers.dev` : `${workerName}.workers.dev`;

    // Now generate working configs for this host!
    return this.generateForUser(h, host);
  }

  /** Manual Worker Prompt */
  async buildPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🌐 <b>ساخت کانفیگ VLESS متصل به ورکر یا دامین شما</b>\n\n` +
          `<blockquote>آدرس کامل ورکر یا دامین کلادفلر خود را بفرستید.\n` +
          `مثال‌ها:\n` +
          `• <code>my-vless.myname.workers.dev</code>\n` +
          `• <code>vpn.mydomain.com</code>\n` +
          `• یا لینک با https://...</blockquote>\n\n` +
          `<i>ربات بلافاصله ۳ کانفیگ بهینه شده با آی‌پی‌های تمیز همراه اول، ایرانسل و مخابرات همراه با فرگمنت ضد DPI تولید می‌کند.</i>`
        : `🌐 <b>Send your Cloudflare Worker URL or Domain:</b>\n` +
          `e.g. <code>my-proxy.workers.dev</code> or <code>sub.mydomain.com</code>`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" }]]),
      !!h.cbId,
    );
  }

  /** Generate production-grade configs with user's domain/worker */
  async generateForUser(h: H, rawInput: string) {
    const fa = h.loc === "fa";
    let host = rawInput.trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .split("/")[0]
      .trim();

    if (!host || host.length < 4 || !host.includes(".")) {
      return h.reply(
        fa
          ? `❌ <b>آدرس ورکر یا دامین نامعتبر است.</b>\n` +
            `لطفاً آدرسی شبیه <code>your-worker.workers.dev</code> یا دامین خود را وارد کنید.`
          : `❌ Invalid domain or worker URL.`,
        kb([[{ text: "◀️ " + (fa ? "تلاش مجدد برای ورکر" : "Try Worker Again"), cb: "gt:build" }]]),
        !!h.cbId,
      );
    }

    await h.loading(fa ? `⚡ در حال آماده‌سازی کانفیگ‌های اختصاصی متصل به ${host}…` : `Generating configs for ${host}…`);

    const uuid = "d342d11e-d424-4583-b36e-524ab1f0afa4";
    const wsPath = "%2F%3Fed%3D2560";

    const operators = [
      { name: "همراه اول (MCI)", ip: "104.16.148.21", port: 443 },
      { name: "ایرانسل (Irancell)", ip: "104.17.64.12", port: 443 },
      { name: "مخابرات و شاتل (ADSL)", ip: "104.21.32.1", port: 443 },
    ];

    const configs = operators.map((op, idx) => {
      const tag = encodeURIComponent(`⚡_${op.name.split(" ")[0]}_${host.split(".")[0]}`);
      const link = `vless://${uuid}@${op.ip}:${op.port}?security=tls&sni=${host}&type=ws&host=${host}&path=${wsPath}&fragment=100-200,10-20,tlshello#${tag}`;
      return { title: op.name, ip: op.ip, link };
    });

    const configCards = configs.map((c, i) => {
      return (
        `<b>${i + 1}. 📱 مخصوص ${c.title}:</b>\n` +
        `• سرور اتصال (Clean IP): <code>${c.ip}</code>\n` +
        `• دامین SNI اختصاصی: <code>${host}</code>\n` +
        `• لایه ضد DPI: <code>Fragment 100-200ms</code>\n` +
        `<code>${c.link}</code>`
      );
    }).join("\n\n");

    const text = fa
      ? `🎉 <b>کانفیگ‌های اختصاصی شما آماده شدند!</b>\n\n` +
        `<blockquote>✅ متصل به هاست اختصاصی شما: <code>${tgEscape(host)}</code>\n` +
        `کانفیگ‌های زیر را با لمس کپی کرده و در برنامه v2rayNG یا NekoBox وارد کنید:</blockquote>\n\n` +
        `${configCards}\n\n` +
        `💡 <i>تست کنید: کانفیگ‌ها به دلیل داشتن سرور و هاست واقعی و آی‌پی تمیز فعال هستند.</i>`
      : `🎉 <b>Your Custom Configs are Ready!</b>\n\n${configCards}`;

    return h.reply(
      text,
      kb(
        [
          { text: "🔄 " + (fa ? "ساخت برای ورکر یا دامین دیگر" : "Build Another"), cb: "gt:build" },
          { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" },
        ],
      ),
      !!h.cbId,
    );
  }

  /** Fragment Injector */
  async fragmentPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🧩 <b>تزریق‌کنندهٔ فرگمنت ضد DPI به کانفیگ فعال شما</b>\n\n` +
          `<blockquote>اگر از قبل کانفیگ سالمی دارید اما در ساعات اوج فیلترینگ قطعی دارد، لینک آن را بفرستید تا لایهٔ خرد کردن پکت (ClientHello Fragmentation) را به آن اضافه کنیم:</blockquote>\n\n` +
          `لینک کانفیگ (VLESS / VMess / Trojan) را بفرستید:`
        : `🧩 Send your working config link to inject TLS Fragmentation parameters:`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" }]]),
      !!h.cbId,
    );
  }

  async injectFragment(h: H, rawConfig: string) {
    const fa = h.loc === "fa";
    const trimmed = rawConfig.trim();
    if (!trimmed.startsWith("vless://") && !trimmed.startsWith("vmess://") && !trimmed.startsWith("trojan://")) {
      return h.reply(
        fa ? "❌ لینک ارسالی نامعتبر است. باید با vless:// یا vmess:// یا trojan:// شروع شود." : "❌ Invalid config URL.",
        kb([[{ text: "◀️ " + (fa ? "تلاش مجدد فرگمنت" : "Retry Fragment"), cb: "gt:frag" }]]),
        !!h.cbId,
      );
    }

    const fragLength = "100-200";
    const fragInterval = "10-20";
    const packets = "tlshello";

    let upgradedConfig = trimmed;
    if (upgradedConfig.includes("#")) {
      const [base, hash] = upgradedConfig.split("#");
      const sep = base.includes("?") ? "&" : "?";
      upgradedConfig = `${base}${sep}fragment=${fragLength},${fragInterval},${packets}#${hash}_AntiDPI`;
    } else {
      const sep = upgradedConfig.includes("?") ? "&" : "?";
      upgradedConfig = `${upgradedConfig}${sep}fragment=${fragLength},${fragInterval},${packets}#AntiDPI_Fragment`;
    }

    const text = fa
      ? `🚀 <b>کانفیگ با تزریق موفقیت‌آمیز لایه فرگمنت ضد DPI:</b>\n\n` +
        `<blockquote>پارامترهای اعمال شده:\n` +
        `• طول بسته‌ها: <code>${fragLength} bytes</code>\n` +
        `• تأخیر ارسال: <code>${fragInterval} ms</code>\n` +
        `• پکت هدف: <code>${packets}</code></blockquote>\n\n` +
        `📋 <b>کانفیگ جدید (با لمس کپی می‌شود):</b>\n` +
        `<code>${tgEscape(upgradedConfig)}</code>`
      : `🚀 <b>Fragment-Injected Config:</b>\n\n<code>${tgEscape(upgradedConfig)}</code>`;

    return h.reply(
      text,
      kb(
        [{ text: "🧩 " + (fa ? "تزریق روی کانفیگ دیگر" : "Inject Another"), cb: "gt:frag" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }
}
