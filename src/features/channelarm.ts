import type { Env } from "../env";
import { botUsername } from "../env";
import { Store } from "../core/db";
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
  /* Coloured, the way the owner's favourite store bot paints its rows:
     the left column rides the accent colour, the right goes green then red. */
  return {
    inline_keyboard: [
      [
        { text: "🏛 معماری", url: link(`arch_${arg}`), style: "primary" },
        { text: "🧠 تحلیل", url: link(`c_${arg}`), style: "success" },
      ],
      [
        { text: "🌍 ترجمه", url: link(`t_${arg}`), style: "primary" },
        { text: "📦 کارت", url: link(`repo_${arg}`), style: "danger" },
      ],
    ],
  };
}

/** Arm one channel post, or leave it alone. Every outcome is written to the
 *  events table (kind `channelarm`), so a post that did not grow keys can be
 *  diagnosed from the data instead of a screenshot. */
export async function armChannelPost(post: any, env: Env, tg: Telegram): Promise<void> {
  const text = String(post?.text ?? post?.caption ?? "");
  if (!text) return;
  const log = (name: string, meta?: any) =>
    new Store(env).event(Number(post?.chat?.id ?? 0) || null, "channelarm", name, meta).catch(() => null);
  // already carries a keyboard (the hub's own publishes, other bots) — not ours to touch
  if (post?.reply_markup?.inline_keyboard?.length) { await log("skip:markup", { mid: post.message_id }); return; }
  // the hub's own publish, keyboard not visible in the update — still not ours to touch
  if (String(post?.from?.username ?? "").toLowerCase() === botUsername(env).toLowerCase()) {
    await log("skip:self", { mid: post.message_id });
    return;
  }
  const full = repoFromText(text);
  if (!full) { await log("skip:nolink", { mid: post.message_id }); return; }

  const chatId = post.chat.id;
  const mid = post.message_id;
  const kb = channelRepoKb(full, botUsername(env)) as any;

  /* Markup-only first: the post stays EXACTLY as its author made it — a rich
     document stays rich (a text edit would flatten it), media keeps its
     caption — only the glass keys appear under it. */
  const mk: any = await tg.call("editMessageReplyMarkup", {
    chat_id: chatId, message_id: mid, reply_markup: kb,
  });
  if (mk?.ok) { await log("edit:ok", { mid, full, way: "markup" }); return; }
  if (/not modified/i.test(String(mk?.description ?? ""))) { await log("edit:same", { mid, full }); return; }

  /* Fallback for post types the markup edit refuses: rewrite text/caption
     verbatim with the keys. Rich documents that land here lose their document
     shape — which is why the markup path above comes first. */
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

  if (res?.ok) { await log("edit:ok", { mid, full, way: media ? "caption" : "text" }); return; }
  if (/not modified/i.test(String(res?.description ?? ""))) { await log("edit:same", { mid, full }); return; }

  /* No edit rights (or a post type that cannot be edited) — the keys still
     deserve to exist: a small action bar under the post. */
  const bar = await tg.sendMessage(chatId, `🔭 <b>${full}</b>`, { parse_mode: "HTML", reply_markup: kb } as any).catch((e: any) => ({ ok: false, description: String(e?.message ?? e) }));
  await log((bar as any)?.ok ? "bar:ok" : "bar:fail", {
    mid, full,
    edit_error: String(res?.description ?? "").slice(0, 120),
    bar_error: String((bar as any)?.description ?? "").slice(0, 120),
  });
}
