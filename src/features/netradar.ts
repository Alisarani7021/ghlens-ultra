import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

export interface ProxyProject {
  name: string;
  repo: string;
  category: "client" | "core" | "tool" | "config";
  descFa: string;
  descEn: string;
}

export const PROXY_PROJECTS: ProxyProject[] = [
  { name: "v2rayNG", repo: "2dust/v2rayNG", category: "client", descFa: "کلاینت اندروید V2Ray/Xray", descEn: "Android V2Ray client" },
  { name: "NekoBox", repo: "MatsuriDayo/NekoBoxForAndroid", category: "client", descFa: "کلاینت چندپروتکله اندروید", descEn: "Universal proxy client for Android" },
  { name: "Hiddify", repo: "hiddify/hiddify-app", category: "client", descFa: "کلاینت چندسکویی Sing-box", descEn: "Multi-platform proxy client" },
  { name: "Sing-box", repo: "SagerNet/sing-box", category: "core", descFa: "هسته مدرن و سبک شبکه و پروکسی", descEn: "Universal proxy platform" },
  { name: "Xray-core", repo: "XTLS/Xray-core", category: "core", descFa: "هسته Xray و VLESS Reality", descEn: "Xray core with XTLS & Reality" },
  { name: "Mihomo (Clash.Meta)", repo: "MetaCubeX/mihomo", category: "core", descFa: "هسته محبوب کلاش متا", descEn: "Clash.Meta core" },
  { name: "Karing", repo: "KaringX/karing", category: "client", descFa: "کلاینت ساده و شیک کلاش و سینگ‌باکس", descEn: "Clash & Sing-box client" },
  { name: "WARP Scripts", repo: "P3TERX/warp.sh", category: "tool", descFa: "اسکریپت نصب و پیکربندی Cloudflare WARP", descEn: "Cloudflare WARP install script" },
];

export class NetRadar {
  async home(h: H) {
    const fa = h.loc === "fa";
    const body = fa
      ? `📡 <b>رادار اینترنت آزاد و ابزارهای شبکه</b>\n\n` +
        `مرجع آخرین نسخه‌ها، دانلود مستقیم بدون نیاز به فیلترشکن، هسته‌ها و کلاینت‌های محبوب ضدسانسور.\n\n` +
        `یکی از ابزارهای زیر را انتخاب کن تا آخرین فایل نصبی (APK/Zip) را مستقیماً داخل تلگرام دریافت کنی:`
      : `📡 <b>Censorship-Buster & Network Radar</b>\n\n` +
        `Direct downloads for anti-censorship clients, cores, and tools without needing a proxy.`;

    const rows = PROXY_PROJECTS.map((p) => [
      { text: `🚀 ${p.name} — ${fa ? p.descFa : p.descEn}`, cb: `nr:app:${p.repo}` },
    ]);

    return h.reply(
      body,
      kb(
        ...rows,
        [
          { text: "⚡ " + (fa ? "کانفیگ‌ها و سابسکریپشن‌های آزاد" : "Free community configs"), cb: "nr:subs" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "m:home" }],
      ),
      !!h.cbId,
    );
  }

  async app(h: H, repo: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🔎 در حال دریافت آخرین ریلیز و فایل‌های نصبی…" : "Fetching latest release assets…");
    const gh = new GithubRest(h.env);
    const releases = await gh.releases(repo, 3).catch(() => []);
    if (!releases.length) {
      return h.reply(
        fa ? "❌ نسخه‌ای برای این مخزن یافت نشد." : "No releases found.",
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "nr:home" }]]),
        true,
      );
    }

    const rel = releases[0];
    const assets = (rel.assets ?? []).filter((a: any) => a.size < 49 * 1024 * 1024); // Telegram 49MB limit
    const apkAssets = assets.filter((a: any) => a.name.endsWith(".apk"));
    const otherAssets = assets.filter((a: any) => !a.name.endsWith(".apk")).slice(0, 4);

    const assetBtns = [...apkAssets, ...otherAssets].slice(0, 6).map((a: any) => [
      { text: `📥 ${a.name} (${(a.size / 1048576).toFixed(1)} MB)`, cb: `nr:dl:${repo}:${a.id}` },
    ]);

    const info =
      `📦 <b>${tgEscape(repo)}</b>\n` +
      `🏷 ${fa ? "نسخه" : "Version"}: <b>${tgEscape(rel.tag_name || rel.name)}</b>\n` +
      `🕒 ${fa ? "تاریخ انتشار" : "Published"}: <code>${(rel.published_at ?? "").slice(0, 10)}</code>\n\n` +
      `<i>${fa ? "روی هر فایل کلیک کنی، مستقیماً داخل تلگرام آپلود و فرستاده می‌شود (بدون فیلترشکن)." : "Click to download directly in Telegram."}</i>`;

    return h.reply(
      info,
      kb(
        ...assetBtns,
        [
          { text: "🛰 " + (fa ? "کاوش مخزن" : "Scout repo"), cb: `s:go:${repo}` },
          { text: "◀️ " + (fa ? "بازگشت به رادار" : "Back to radar"), cb: "nr:home" },
        ],
      ),
      true,
    );
  }

  async downloadAsset(h: H, repo: string, assetId: number) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "⏳ در حال دانلود از سرور گیت‌هاب و آپلود در تلگرام…" : "Downloading asset and uploading to Telegram…");
    const gh = new GithubRest(h.env);
    const releases = await gh.releases(repo, 3).catch(() => []);
    let targetAsset: any = null;
    for (const r of releases) {
      targetAsset = (r.assets ?? []).find((a: any) => a.id === assetId);
      if (targetAsset) break;
    }

    if (!targetAsset) {
      return h.toast(fa ? "فایل پیدا نشد." : "Asset not found", true);
    }

    if (targetAsset.size > 49 * 1024 * 1024) {
      return h.reply(
        (fa ? `⚠️ حجم فایل (${(targetAsset.size / 1048576).toFixed(1)} MB) بیش از سقف آپلود ربات تلگرام است.\nلینک مستقیم دانلود:\n` : "File too large for Telegram upload. Direct link:\n") +
        `<a href="${targetAsset.browser_download_url}">${targetAsset.name}</a>`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `nr:app:${repo}` }]]),
        true,
      );
    }

    try {
      const resp = await fetch(targetAsset.browser_download_url, {
        headers: { "User-Agent": "GitHubLensBot/1.0" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      await h.tg.sendDocument(h.chatId, targetAsset.name, buf, `🚀 <b>${targetAsset.name}</b>\n📦 ${repo}\n<i>دانلود مستقیم از GitHub Lens</i>`);
      await h.toast(fa ? "✅ فایل ارسال شد" : "Sent");
    } catch (e: any) {
      return h.reply(
        (fa ? "❌ خطا در دریافت فایل. از لینک مستقیم استفاده کن:\n" : "Download failed. Direct link:\n") +
        `<a href="${targetAsset.browser_download_url}">${targetAsset.name}</a>`,
        kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `nr:app:${repo}` }]]),
        true,
      );
    }
  }

  async freeSubs(h: H) {
    const fa = h.loc === "fa";
    const text = fa
      ? `⚡ <b>مخازن سابسکریپشن و کانفیگ‌های آزاد</b>\n\n` +
        `این مخازن گیت‌هاب کانفیگ‌های عمومی و رایگان را به صورت خودکار به‌روزرسانی می‌کنند:\n\n` +
        `• <b>Free-V2Ray-Config:</b>\n<code>https://raw.githubusercontent.com/yebekhe/TVC/main/subscriptions/xray/base64/mix</code>\n\n` +
        `• <b>v2ray-collector:</b>\n<code>https://raw.githubusercontent.com/MortezaBashsiz/CF-Clean-IP/main/README.md</code>\n\n` +
        `<i>می‌توانی آدرس هر لینک را کپی و در کلاینت خود ایمپورت کنی.</i>`
      : `⚡ <b>Free Community Configs & Subscriptions</b>\n\nPublicly maintained anti-censorship subscriptions.`;

    return h.reply(
      text,
      kb(
        [
          { text: "🛰 " + (fa ? "مشاهده مخزن yebekhe" : "yebekhe/TVC"), cb: "s:go:yebekhe/TVC" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "nr:home" }],
      ),
      true,
    );
  }
}
