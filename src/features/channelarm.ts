import type { Env } from "../env";
import { botUsername } from "../env";
import type { Telegram } from "../tg/api";

/**
 * Glass keys under every GitHub link posted in a channel.
 *
 * The owner posts a project link — any `github.com/owner/repo` in a channel
 * the bot administrates — and the post itself grows a small glass keyboard:
 * architecture, analysis, translation, the repo card. Each button is a deep
 * link, so every reader of the channel lands in the bot on that exact screen,
 * no login, no setup.
 *
 * Consent is membership: the bot only touches a channel it was made an admin
 * of, and only posts that carry no keyboard of their own (the hub's published
 * posts already have buttons — those are never clobbered). A post is armed by
 * editing it in place — same text, same entities, plus markup — and when the
 * edit is refused (a channel without edit rights) an action bar message goes
 * under it instead, so the keys exist either way.
 */

/** The first `github.com/owner/repo` in a text, or null. */
export function repoFromText(text: string): string | null {
  const m = String(text ?? "").match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return null;
  const full = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return /^[\w.-]+\/[\w.-]+$/.test(full) ? full : null;
}

/**
 * The glass keyboard: four deep links — architecture, AI analysis, README
 * translation, the repo card. URL buttons, so any channel reader can press
 * them; the bot opens on the exact screen.
 */
export function channelRepoKb(full: string, botUser: string): { inline_keyboard: any[][] } {
  const arg = full.replace("/", "_");
  const link = (q: string) => `https://t.me/${botUser}?start=${q}`;
  return {
    inline_keyboard: [
      [
        { text: "🏛 معماری", url: link(`arch_${arg}`) },
        { text: "🧠 تحلیل", url: link(`c_${arg}`) },
      ],
      [
        { text: "🌍 ترجمه", url: link(`t_${arg}`) },
        { text: "📦 کارت", url: link(`repo_${arg}`) },
      ],
    ],
  };
}

/** Arm one channel post, or leave it alone. */
export async function armChannelPost(post: any, env: Env, tg: Telegram): Promise<void> {
  const text = String(post?.text ?? post?.caption ?? "");
  if (!text) return;
  // already carries a keyboard (the hub's own publishes, other bots) — not ours to touch
  if (post?.reply_markup?.inline_keyboard?.length) return;
  const full = repoFromText(text);
  if (!full) return;

  const chatId = post.chat.id;
  const mid = post.message_id;
  const kb = channelRepoKb(full, botUsername(env)) as any;

  /* Edit in place: the post keeps its text (and entities, hashtags, previews
     untouched), only the glass keys are added under it. */
  const media = !!(post.photo || post.video || post.document || post.animation || post.audio);
  const res: any = media
    ? await tg.call("editMessageCaption", {
        chat_id: chatId, message_id: mid,
        caption: post.caption ?? "",
        ...(post.caption_entities ? { caption_entities: post.caption_entities } : {}),
        reply_markup: kb,
      })
    : await tg.call("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: post.text ?? "",
        ...(post.entities ? { entities: post.entities } : {}),
        reply_markup: kb,
      });

  if (res?.ok || /not modified/i.test(String(res?.description ?? ""))) return;

  /* No edit rights (or a post type that cannot be edited) — the keys still
     deserve to exist: a small action bar under the post. */
  await tg.sendMessage(chatId, `🔭 <b>${full}</b>`, { parse_mode: "HTML", reply_markup: kb } as any).catch(() => null);
}
