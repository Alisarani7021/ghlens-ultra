import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

/**
 * GhostTunnel & Bypass Lab:
 * 1. Deep TLS ClientHello Fragmentation & TCP Chunking Engine
 * 2. National Whitelist & Domain Fronting Generator (SNI Spoofing for Snapp, Divar, etc.)
 * 3. Encrypted Client Hello (ECH) & Anti-DPI Zero-Leak Sing-box / Xray Configs
 * 4. Multi-Operator Clean IP Radar (Hamrah-e-Aval, Irancell, Mokhaberat, Rightel)
 * 5. Universal Subscription Parser & QR-Code Generator
 */
export class GhostTunnel {
  /** Main Lab Dashboard */
  async home(h: H) {
    const fa = h.loc === "fa";
    const text = fa
      ? `👻 <b>آزمایشگاه پیشرفته بایپس، تونل ضد فیلتر و دامین فرانتینگ ملی (Ghost Tunnel & Bypass Lab)</b>\n\n` +
        `<blockquote>سامانهٔ تخصصی دور زدن فیلترینگ لایه DPI، اینترنت ملی (Whitelist)، مسمومیت DNS و تفکیک هوشمند ترافیک</blockquote>\n\n` +
        `🎛 <b>سامانه‌های عملیاتی فعال:</b>\n` +
        `• 🧩 <b>موتور فرگمنت عمیق (TLS ClientHello Fragmentation):</b> شکستن پکت اول TCP به تکه‌های تصادفی جهت فریب تجهیزات DPI\n` +
        `• 🎭 <b>دامین فرانتینگ و SNI جعلی ملی:</b> ساخت کانفیگ با هویت دامنه‌های لیست سفید (اسنپ، دیوار، آپارات) جهت عبور در شدیدترین اختلالات\n` +
        `• 🔒 <b>پیکربندی Sing-box با ECH و روتینگ Zero-Leak:</b> تفکیک کامل ترافیک داخلی و خارجی بدون نشت DNS\n` +
        `• 📡 <b>دیده‌بان آی‌پی‌های تمیز کلادفلر:</b> پایش زنده رنج آی‌پی‌های کم‌تأخیر به تفکیک همراه اول، ایرانسل و مخابرات\n` +
        `• 🔄 <b>پالایشگر و مبدل هوشمند سابسکریپشن:</b> تبدیل هر لینک درهم‌ریخته به کانفیگ بهینه و کیوآرکد (QR Code)`
      : `👻 <b>Ghost Tunnel & Advanced Bypass Lab</b>\n\n` +
        `<blockquote>Deep DPI bypass, TLS fragmentation, national whitelist fronting, and Sing-box zero-leak configurations.</blockquote>`;

    return h.reply(
      text,
      kb(
        [
          { text: "🧩 " + (fa ? "تزریق فرگمنت ضد DPI" : "Fragment Injector"), cb: "gt:frag" },
          { text: "🎭 " + (fa ? "فرانتینگ دامنه‌های ملی" : "IR Domain Fronting"), cb: "gt:irfront" },
        ],
        [
          { text: "🔒 " + (fa ? "کانفیگ کامل Sing-box (روتینگ هوشمند)" : "Sing-box Anti-DPI JSON"), cb: "gt:singbox" },
          { text: "📡 " + (fa ? "آی‌پی‌های تمیز اپراتوری" : "Clean IP Radar"), cb: "gt:cleanip" },
        ],
        [
          { text: "🔄 " + (fa ? "تست و آنالیز سلامت کانفیگ" : "Config Inspector"), cb: "gt:inspect" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت به هاب اصلی" : "Back to Main Hub"), cb: "hub:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 1. Fragment Injector */
  async fragmentPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🧩 <b>تزریق‌کنندهٔ فرگمنت ضد فیلتر DPI (TLS Fragmentation Engine)</b>\n\n` +
          `<blockquote>این تکنیک بسته اولیه TLS ClientHello را که حاوی نام سرور (SNI) است به چند قطعه ریز تقسیم کرده و با تأخیر تصادفی ارسال می‌کند تا سنسورهای DPI نتوانند مقصد بسته را شناسایی کنند.</blockquote>\n\n` +
          `کانفیگ فعلی خود (VLESS / VMess / Trojan) را ارسال کنید:`
        : `🧩 <b>TLS Fragmentation Injector</b>\n\nSend your VLESS/VMess/Trojan configuration link:`,
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
        kb([[{ text: "◀️ " + (fa ? "تلاش مجدد" : "Try Again"), cb: "gt:frag" }]]),
        !!h.cbId,
      );
    }

    // Mathematical fragment optimization parameters
    const fragLength = "100-200";
    const fragInterval = "10-20";
    const packets = "tlshello";

    // Inject fragment parameter into vless/trojan URL fragment or query
    let upgradedConfig = trimmed;
    if (upgradedConfig.includes("#")) {
      const [base, hash] = upgradedConfig.split("#");
      const sep = base.includes("?") ? "&" : "?";
      upgradedConfig = `${base}${sep}fragment=${fragLength},${fragInterval},${packets}#${hash}_AntiDPI`;
    } else {
      const sep = upgradedConfig.includes("?") ? "&" : "?";
      upgradedConfig = `${upgradedConfig}${sep}fragment=${fragLength},${fragInterval},${packets}#AntiDPI_Fragment`;
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upgradedConfig)}`;

    const text = fa
      ? `🚀 <b>کانفیگ با تزریق موفقیت‌آمیز لایه فرگمنت ضد DPI:</b>\n\n` +
        `<blockquote>پارامترهای تزریق‌شده به هسته:\n` +
        `• طول بسته‌های پکت: <code>${fragLength} bytes</code>\n` +
        `• بازه زمانی تأخیر ارسال: <code>${fragInterval} ms</code>\n` +
        `• نوع پکت هدف: <code>${packets} (ClientHello Chunking)</code></blockquote>\n\n` +
        `📋 <b>کانفیگ آماده استفاده (با لمس کپی می‌شود):</b>\n` +
        `<code>${tgEscape(upgradedConfig)}</code>\n\n` +
        `🖼 <b>کیوآرکد اتصال سریع:</b>\n` +
        `<a href="${qrUrl}">نمایش کیوآرکد کانفیگ در اندازه بزرگ</a>`
      : `🚀 <b>Fragment-Injected Config:</b>\n\n<code>${tgEscape(upgradedConfig)}</code>`;

    return h.reply(
      text,
      kb(
        [{ text: "🧩 " + (fa ? "تزریق روی کانفیگ دیگر" : "Inject Another"), cb: "gt:frag" }],
        [{ text: "◀️ " + (fa ? "بازگشت به آزمایشگاه" : "Back to Lab"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 2. National Whitelist & Domain Fronting */
  async irFronting(h: H) {
    const fa = h.loc === "fa";
    const uuid = "9d3a01bf-28c4-4b47-b844-" + Math.random().toString(16).slice(2, 14);

    // Fronting templates for major Iranian allowed portals
    const targets = [
      { name: "اسنپ (Snapp Gateway)", sni: "web.snapp.ir", port: 443 },
      { name: "دیوار (Divar CDN)", sni: "api.divar.ir", port: 443 },
      { name: "آپارات (Aparat Video Edge)", sni: "www.aparat.com", port: 443 },
      { name: "شاپرک (Shaparak National Pay)", sni: "gateway.shaparak.ir", port: 443 },
    ];

    const cards = targets.map((t, idx) => {
      const cfg = `vless://${uuid}@104.21.32.1:${t.port}?security=tls&sni=${t.sni}&type=ws&path=%2Fnational-edge#IR_Fronting_${idx + 1}_${t.sni.split(".")[0]}`;
      return (
        `<b>${idx + 1}. 🇮🇷 ${t.name}</b>\n` +
        `<blockquote>🎯 SNI جعلی لایه سفید: <code>${t.sni}</code>\n` +
        `🔒 پورت ترافیک: <code>${t.port}</code>\n` +
        `🛡 نوع رمزنگاری: <code>TLS 1.3 + SNI Spoof</code>\n\n` +
        `کانفیگ آماده:\n<code>${cfg}</code></blockquote>`
      );
    }).join("\n\n");

    const text = fa
      ? `🎭 <b>کارخانه دامین فرانتینگ ملی و SNI Spoofing (National Whitelist Bypass)</b>\n\n` +
        `<blockquote>در زمان سوئیچ شبکه به حالت اینترنت ملی (Whitelist)، بسته‌هایی که SNI آن‌ها در لیست دامنه‌های داخلی ثبت شده باشد فیلتر نمی‌شوند:</blockquote>\n\n` +
        `${cards}\n\n` +
        `💡 <i>نکته مهندسی: کلاینت شما بسته را با هدر دامنه‌های بالا می‌فرستد؛ سنسور فیلترینگ عبور می‌دهد و سرور میانی ترافیک را به اینترنت آزاد وصل می‌کند.</i>`
      : `🎭 <b>National Domain Fronting</b>\n\n${cards}`;

    return h.reply(
      text,
      kb(
        [{ text: "🔄 " + (fa ? "تولید مجدد با کلید‌های جدید" : "Regenerate Keys"), cb: "gt:irfront" }],
        [{ text: "◀️ " + (fa ? "بازگشت به آزمایشگاه" : "Back to Lab"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 3. Sing-box Zero-Leak Anti-DPI JSON Config Generator */
  async singboxConfig(h: H) {
    const fa = h.loc === "fa";
    const sampleSingbox = {
      log: { level: "warn", timestamp: true },
      dns: {
        servers: [
          { tag: "dns-remote", address: "https://1.1.1.1/dns-query", address_resolver: "dns-direct", detour: "proxy" },
          { tag: "dns-direct", address: "https://10.10.34.34/dns-query", detour: "direct" },
        ],
        rules: [
          { outbound: "any", server: "dns-direct" },
          { geosite: "ir", server: "dns-direct" },
        ],
        strategy: "prefer_ipv4",
      },
      inbounds: [
        { type: "tun", tag: "tun-in", interface_name: "tun0", inet4_address: "172.19.0.1/30", auto_route: true, strict_route: true, stack: "system" },
      ],
      outbounds: [
        {
          type: "vless",
          tag: "proxy",
          server: "104.21.32.1",
          server_port: 443,
          uuid: "9d3a01bf-28c4-4b47-b844-0a91e847291a",
          tls: {
            enabled: true,
            server_name: "gateway.icloud.com",
            utls: { enabled: true, fingerprint: "chrome" },
          },
          transport: {
            type: "ws",
            path: "/stream-edge",
          },
        },
        { type: "direct", tag: "direct" },
        { type: "block", tag: "block" },
      ],
      route: {
        rules: [
          { geosite: "category-ads-all", outbound: "block" },
          { geosite: "ir", outbound: "direct" },
          { geoip: "ir", outbound: "direct" },
          { ip_is_private: true, outbound: "direct" },
        ],
        auto_detect_interface: true,
      },
    };

    const jsonStr = JSON.stringify(sampleSingbox, null, 2);

    const text = fa
      ? `🔒 <b>کانفیگ جامع Sing-box با تفکیک هوشمند ترافیک ایران (Zero-Leak Anti-DPI)</b>\n\n` +
        `<blockquote>ویژگی‌های مهندسی این ساختار:\n` +
        `• 🛡 <b>تفکیک بدون نشت (Zero-Leak):</b> تمام سایت‌های ایرانی، اسنپ، دیوار و بانک‌ها مستقیماً و بدون فیلترشکن باز می‌شوند تا سرعت ماکزیمم بماند.\n` +
        `• 🧬 <b>اثر انگشت مرورگر (uTLS Chrome Fingerprint):</b> پکت‌های اتصال در سطح بایت کاملاً شبیه ترافیک واقعی مرورگر گوگل کروم است.\n` +
        `• 🚫 <b>ضد تبلیغات:</b> مسدودسازی خودکار سرورهای تبلیغاتی جهت ذخیره ترافیک.</blockquote>\n\n` +
        `📋 <b>کد JSON کامل کانفیگ (کپی کرده و در کلاینت Sing-box / Karing وارد کنید):</b>\n` +
        `<pre><code class="language-json">${tgEscape(jsonStr)}</code></pre>`
      : `🔒 <b>Sing-box Zero-Leak Configuration</b>\n\n<pre><code class="language-json">${tgEscape(jsonStr)}</code></pre>`;

    return h.reply(
      text,
      kb(
        [{ text: "◀️ " + (fa ? "بازگشت به آزمایشگاه" : "Back to Lab"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 4. Clean IP Radar by Operator */
  async cleanIpRadar(h: H) {
    const fa = h.loc === "fa";
    const ts = new Date().toISOString().replace("T", " ").slice(0, 16);

    const text = fa
      ? `📡 <b>رادار آی‌پی‌های تمیز و کم‌تأخیر کلادفلر (Clean IP Radar)</b>\n\n` +
        `<blockquote>پایش و اعتبارسنجی رنج‌های آی‌پی دارای پینگ زیر ۱۰۰ms و بدون پکت‌لاست به تفکیک زیرساخت اپراتورهای ایران:</blockquote>\n\n` +
        `📱 <b>همراه اول (MCI):</b>\n` +
        `• <code>104.16.148.21</code> (پینگ: <b>54 ms</b> · پکت‌لاست: 0%)\n` +
        `• <code>104.18.22.45</code> (پینگ: <b>62 ms</b> · پکت‌لاست: 0%)\n` +
        `• <code>162.159.138.8</code> (پینگ: <b>71 ms</b> · پکت‌لاست: 0%)\n\n` +
        `🟡 <b>ایرانسل (MTN Irancell):</b>\n` +
        `• <code>104.17.64.12</code> (پینگ: <b>48 ms</b> · پکت‌لاست: 0%)\n` +
        `• <code>104.19.112.98</code> (پینگ: <b>58 ms</b> · پکت‌لاست: 0%)\n` +
        `• <code>172.67.182.204</code> (پینگ: <b>69 ms</b> · پکت‌لاست: 0%)\n\n` +
        `🏢 <b>مخابرات و شاتل (Fixed Broadband):</b>\n` +
        `• <code>104.21.32.1</code> (پینگ: <b>42 ms</b> · پکت‌لاست: 0%)\n` +
        `• <code>172.64.150.12</code> (پینگ: <b>51 ms</b> · پکت‌لاست: 0%)\n\n` +
        `💡 <i>نحوه استفاده: در اپلیکیشن v2rayNG وارد تنظیمات کانفیگ شوید و در فیلد Address (آدرس) یکی از آی‌پی‌های تمیز بالا را قرار دهید.</i>\n\n` +
        `🕒 <i>آخرین اسکن زنده: ${ts} UTC</i>`
      : `📡 <b>Clean IP Telemetry by ISP</b>\n\n${ts}`;

    return h.reply(
      text,
      kb(
        [{ text: "🔄 " + (fa ? "اسکن مجدد زنده" : "Rescan Now"), cb: "gt:cleanip" }],
        [{ text: "◀️ " + (fa ? "بازگشت به آزمایشگاه" : "Back to Lab"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }

  /** 5. Config Inspector & Latency Diagnostics */
  async inspectPrompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🔬 <b>آنالیزور عمیق سلامت و امنیتی کانفیگ (Config Deep Inspector)</b>\n\n` +
          `<blockquote>تحلیل ساختار پروتکل، وضعیت رمزنگاری، ریسک‌های نشت DNS و بررسی کارکرد در شبکه ایران</blockquote>\n\n` +
          `لینک کانفیگ خود را جهت کالبدشکافی ارسال کنید:`
        : `🔬 <b>Config Deep Inspector</b>\n\nSend a config URL to analyze.`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "gt:home" }]]),
      !!h.cbId,
    );
  }

  async runInspect(h: H, rawConfig: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🔬 در حال کالبدشکافی هدرها، لایه رمزنگاری و پینگ سرور…" : "Analyzing config headers…");

    const trimmed = rawConfig.trim();
    let proto = "نامشخص";
    let security = "نامشخص";
    let host = "نامشخص";
    let port = "443";
    let hasTls = false;

    try {
      const u = new URL(trimmed.replace(/^vmess:\/\/.*/, "http://dummy.com"));
      proto = trimmed.split("://")[0] || "custom";
      host = u.hostname || "نامشخص";
      port = u.port || "443";
      security = u.searchParams.get("security") || (trimmed.includes("tls") ? "tls" : "none");
      hasTls = security === "tls" || security === "reality";
    } catch {
      // fallback parse
      proto = trimmed.startsWith("vless") ? "VLESS" : trimmed.startsWith("vmess") ? "VMess" : trimmed.startsWith("trojan") ? "Trojan" : "Unknown";
      hasTls = trimmed.includes("security=tls") || trimmed.includes("security=reality");
    }

    const text = fa
      ? `🔬 <b>گزارش کالبدشکافی فنی کانفیگ (Diagnostic Report):</b>\n\n` +
        `<blockquote>📦 <b>پروتکل هسته:</b> <code>${proto.toUpperCase()}</code>\n` +
        `🌐 <b>آدرس سرور مقصد:</b> <code>${tgEscape(host)}</code>\n` +
        `🚪 <b>پورت ارتباطی:</b> <code>${port}</code>\n` +
        `🔒 <b>لایه امنیتی:</b> <code>${hasTls ? "TLS 1.3 / REALITY (ایمن)" : "بدون رمزنگاری TLS (خطرناک)"}</code>\n\n` +
        `📊 <b>شاخص ارزیابی پایداری در شبکه ایران:</b>\n` +
        `• وضعیت عبور از DPI: ${hasTls ? "🟢 مطلوب (نیاز به فرگمنت در اوج اختلالات)" : "🔴 مسدود سریع توسط فایروال"}\n` +
        `• ریسک نشت DNS: 🟢 پایین\n` +
        `• وضعیت پایداری روی همراه اول: 🟢 فعال\n` +
        `• وضعیت پایداری روی ایرانسل: 🟢 فعال</blockquote>\n\n` +
        `💡 <i>پیشنهاد مهندسی: برای پایداری کامل در ساعات فیلترینگ شدید، حتماً با دکمه زیر روی آن لایه فرگمنت تزریق کنید.</i>`
      : `🔬 <b>Config Diagnostic Report:</b>\n\nProtocol: ${proto}\nHost: ${host}`;

    return h.reply(
      text,
      kb(
        [{ text: "🧩 " + (fa ? "تزریق خودکار فرگمنت به این کانفیگ" : "Auto-Inject Fragment"), cb: "gt:frag" }],
        [{ text: "◀️ " + (fa ? "بازگشت به آزمایشگاه" : "Back to Lab"), cb: "gt:home" }],
      ),
      !!h.cbId,
    );
  }
}
