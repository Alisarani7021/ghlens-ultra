import type { Workflow } from "./engine";

/**
 *  PLAYBOOKS — the workflows that ship with the platform.
 *
 *  These are not demos. Each one is the product of a specific failure that is
 *  painful to rediscover:
 *
 *   • every step that could publish is followed by a policy check, because
 *     "the model wrote something plausible" is not a reason to post it
 *   • every generator is asked for one thing at a time, because a single
 *     prompt that writes and judges produces neither well
 *   • the human gate sits *after* the post is rendered, so the owner approves
 *     what will actually be sent — not a summary of it
 *
 *  An owner can copy a playbook and edit it; that copy is an ordinary workflow
 *  with no special status, which is the point.
 */

type Dag = Workflow["dag"];

/** The system prompt every `ai` node in these playbooks inherits. */
export const EDITOR_SYSTEM =
  `You are the editor of a Persian-language open-source technology channel. ` +
  `You write for working developers, not for search engines. Rules you never break:\n` +
  `• Write in Persian. Keep technical names, versions, flags and commands in Latin script.\n` +
  `• Never invent a feature, number, benchmark or claim that is not in the input.\n` +
  `• No preamble ("در این پست…"), no closing pleasantries, no "به عنوان یک هوش مصنوعی".\n` +
  `• Output Telegram HTML only: <b>, <i>, <code>, <blockquote>. Never markdown, never tables, never <details>.\n` +
  `• Be concrete: what changed, who it affects, and whether the reader must act.`;

const releaseDag: Dag = {
  entry: "in",
  nodes: [
    { id: "in", kind: "trigger", next: ["edit"] },

    {
      id: "edit",
      kind: "ai",
      label: "بازنویسی چنج‌لاگ به فارسی",
      cfg: {
        out: "editorial",
        task: "compose",
        breadth: 2,
        max_tokens: 900,
        temperature: 0.35,
        system: EDITOR_SYSTEM,
        prompt:
          `A new release was published. Rewrite its changelog as a short channel note.\n\n` +
          `REPO: {{event.payload.repo}}\nVERSION: {{event.payload.tag}}\nNAME: {{event.payload.name}}\n\n` +
          `RAW CHANGELOG:\n{{event.payload.body}}\n\n` +
          `Output exactly this shape and nothing else:\n` +
          `<b>چه چیزی عوض شد</b>\n` +
          `• (3 تا 5 بولت، هر کدام یک تغییر مشخص — قابلیت تازه / رفع باگ / بهبود کارایی / نکتهٔ امنیتی)\n\n` +
          `<b>چرا مهم است</b>\n` +
          `(یک پاراگراف دو جمله‌ای خطاب به کسی که این ابزار را استفاده می‌کند)\n\n` +
          `<b>اقدام لازم</b>\n` +
          `(یک جمله: آپدیت کن یا نه — و اگر شکستن سازگاری هست صریح بگو)`,
      },
      next: ["card"],
    },

    {
      id: "card",
      kind: "compose.release",
      label: "ساخت کارت انتشار + دکمه‌های دانلود",
      cfg: { editorial_from: "editorial" },
      next: ["dedupe"],
    },

    {
      id: "dedupe",
      kind: "condition",
      label: "تکراری نباشد",
      cfg: { path: "event.payload.repo", op: "exists" },
      next: ["policy"],
    },

    {
      id: "policy",
      kind: "policy",
      label: "دروازهٔ سیاست",
      cfg: { destination: "channel", from: "post" },
      next: ["store"],
    },

    {
      id: "store",
      kind: "content",
      label: "ثبت در گراف محتوا",
      cfg: { kind: "post", from: "post", lang: "fa" },
      next: ["ask"],
    },

    {
      id: "ask",
      kind: "approval",
      label: "تأیید انسانی",
      cfg: { from: "post" },
      next: ["send", "tell"],
    },

    {
      id: "send",
      kind: "connector",
      label: "انتشار در کانال",
      cfg: { kind: "telegram", action: "publish" },
      next: ["done"],
    },

    {
      id: "tell",
      kind: "notify",
      label: "گزارش به مالک",
      cfg: { text: "✅ <b>منتشر شد</b>\n{{event.payload.repo}} @ <code>{{event.payload.tag}}</code>" },
      next: ["done"],
    },

    { id: "done", kind: "stop" },
  ],
};

const rssDigestDag: Dag = {
  entry: "in",
  nodes: [
    { id: "in", kind: "trigger", next: ["summarize"] },
    {
      id: "summarize",
      kind: "ai",
      label: "خلاصهٔ فارسی",
      cfg: {
        out: "editorial",
        task: "compose",
        breadth: 1,
        max_tokens: 600,
        system: EDITOR_SYSTEM,
        prompt:
          `Summarize this article for a developer audience in Persian.\n\nTITLE: {{event.payload.title}}\nURL: {{event.payload.link}}\n\nCONTENT:\n{{event.payload.summary}}\n\n` +
          `Output exactly:\n<b>{{event.payload.title}}</b>\n(یک پاراگراف سه‌جمله‌ای: موضوع، یافتهٔ اصلی، چرا به کار یک برنامه‌نویس می‌آید)`,
      },
      next: ["store"],
    },
    {
      id: "store",
      kind: "content",
      label: "ثبت محتوا",
      cfg: { kind: "summary", from: "editorial", lang: "fa" },
      next: ["done"],
    },
    { id: "done", kind: "stop" },
  ],
};

const watchdogDag: Dag = {
  entry: "in",
  nodes: [
    { id: "in", kind: "trigger", next: ["tell"] },
    {
      id: "tell",
      kind: "notify",
      label: "هشدار تغییر",
      cfg: {
        text: "📡 <b>تغییر شناسایی شد</b>\n\n<code>{{event.payload.url}}</code>\nمقدار جدید: <b>{{event.payload.value}}</b>",
      },
      next: ["done"],
    },
    { id: "done", kind: "stop" },
  ],
};

export interface Playbook {
  key: string;
  name: string;
  mission: string;
  on_event: string;
  dag: Dag;
  /** what the owner must wire up first, in their words */
  needs: string;
}

export const PLAYBOOKS: Playbook[] = [
  {
    key: "release-to-channel",
    name: "🚀 انتشار نسخهٔ جدید در کانال",
    mission:
      "هر بار نسخهٔ جدیدی از مخزن‌های من منتشر شد، چنج‌لاگ را فارسی و خوانا کن، " +
      "کارت انتشار با دکمه‌های دانلود بساز، به من نشان بده و بعد از تأیید در کانال منتشر کن.",
    on_event: "github.release.*",
    dag: releaseDag,
    needs: "کانکتور گیت‌هاب (لیست مخزن‌ها) + کانکتور تلگرام (کانال)",
  },
  {
    key: "rss-digest",
    name: "📰 خلاصهٔ خودکار فیدها",
    mission: "هر آیتم تازهٔ فیدهای RSS من را بخوان، فارسی خلاصه کن و در صف تأیید بگذار.",
    on_event: "rss.item.new",
    dag: rssDigestDag,
    needs: "کانکتور RSS (آدرس فید)",
  },
  {
    key: "watchdog",
    name: "📡 دیده‌بان تغییر",
    mission: "هر وقت مقدار یک API یا صفحهٔ وب عوض شد، فوراً به من خبر بده.",
    on_event: "http.value.changed",
    dag: watchdogDag,
    needs: "کانکتور HTTP (آدرس + مسیر مقدار)",
  },
];

export const playbook = (key: string): Playbook | null => PLAYBOOKS.find((p) => p.key === key) ?? null;
