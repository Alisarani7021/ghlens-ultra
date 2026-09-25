import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

/**
 *  THE CHANNEL GATE
 *
 *  Every glass key under a channel post is a t.me deep link, and a thumb
 *  resting on a phone screen fires those by accident. The owner asked for a
 *  yes/no step before anything heavy runs: describe what will open, and wait
 *  for the tap that means it.
 */

export interface DeepLinkDesc {
  full: string;
  title: string;
  icon: string;
}

/** What a deep link will open, in one line — pure, so it is testable. */
export function describeDeepLink(arg: string): DeepLinkDesc | null {
  const deep = arg.match(/^([sdtc])_(.+)$/);
  if (deep) {
    // the separator is the first underscore — owners never carry one
    const map: Record<string, [string, string]> = {
      s: ["🔎 کاوش عمیق ۱۲ تبی", "🔎"],
      d: ["📥 دانلود سورس", "📥"],
      t: ["🌍 ترجمهٔ فارسی README", "🌍"],
      c: ["🧠 تحلیل هوش مصنوعی", "🧠"],
    };
    const [title, icon] = map[deep[1]] ?? ["…", "•"];
    return { full: deep[2].replace("_", "/"), title, icon };
  }
  if (arg.startsWith("arch_")) {
    return { full: arg.slice(5).replace("_", "/"), title: "🏛 معماری پروژه", icon: "🏛" };
  }
  if (arg.startsWith("repo_")) {
    return { full: arg.slice(5).replace("_", "/"), title: "📦 کارت تصویری مخزن", icon: "📦" };
  }
  return null;
}

export interface DeepLinkGate {
  text: string;
  kb: ReturnType<typeof kb>;
}

/** The gate screen for a channel deep link — or null when it is not one. */
export function deepLinkGate(arg: string, fa: boolean): DeepLinkGate | null {
  const d = describeDeepLink(arg);
  if (!d) return null;
  return {
    text: fa
      ? `👋 <b>از پست کانال اینجا رسیدی!</b>\n\n` +
        `${d.icon} ${d.title}\nبرای مخزن: <b>${tgEscape(d.full)}</b>\n\n` +
        `همین حالا برات بازش کنم؟`
      : `👋 <b>You arrived from a channel post.</b>\n\n` +
        `${d.icon} ${d.title}\nfor <b>${tgEscape(d.full)}</b>\n\n` +
        `Open it for you now?`,
    kb: kb(
      [{ text: fa ? "✅ بله، باز کن" : "✅ Yes, open it", cb: "dl:yes" }],
      [{ text: fa ? "❌ نه، ممنون" : "❌ Not now", cb: "dl:no" }],
    ),
  };
}
