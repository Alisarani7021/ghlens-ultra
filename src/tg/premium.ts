/**
 * The premium-emoji layer: one table, one choke point, zero manual tags.
 *
 * Telegram renders a "premium" emoji when a message carries a `custom_emoji`
 * entity. In HTML that is `<tg-emoji emoji-id="…">🔮</tg-emoji>` — the emoji
 * inside the tag is the fallback shown wherever the custom one cannot appear
 * (system notifications, forwards by non-premium users), so wrapping is
 * lossless by construction.
 *
 * Three things make this whole-bot without anyone sending tags one by one:
 *
 *  1. The ids come from Telegram itself — the built-in animated-emoji sticker
 *     set, fetched once per week and cached in KV. Bots with a premium owner
 *     are allowed to use them in the messages they send.
 *  2. Every incoming custom-emoji entity teaches the table its pair — a
 *     premium user pastes one message full of their favourite pack and the
 *     bot learns the whole pack at once.
 *  3. `call()` wraps the text of every outgoing message — screens, captions,
 *     rich documents — and if Telegram ever refuses (no permission, an odd
 *     context), the original text is retried immediately: the reader always
 *     gets the message, premium or not.
 */

/** base emoji → custom_emoji_id */
export type PremiumMap = Record<string, string>;

const KV_MAP_KEY = "emoji:premium:map";
const KV_OFF_KEY = "emoji:premium:off";
const OFF_TTL = 3600; // re-test after an hour — the owner may activate premium
const MAP_TTL = 7 * 86400;

/** Candidate sets, in order — Telegram's built-in animated emoji first. */
const CANDIDATE_SETS = ["AnimatedEmoji", "EmojiAnimations"];

/* isolate-level state */
let cached: PremiumMap | null = null;
let loading: Promise<PremiumMap | null> | null = null;
let offUntil = 0;     // Telegram refused custom emoji — stand down
let emptyUntil = 0;   // no table anywhere — stop asking for a while

const emojiKeyRe = /[\\^$.*+?()[\]{}|]/g;
const escapeRe = (s: string) => s.replace(emojiKeyRe, "\\$&");

function matcherFor(m: PremiumMap): RegExp | null {
  const keys = Object.keys(m).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  // longest first so ZWJ sequences and skin tones win over their prefixes
  return new RegExp(keys.map(escapeRe).join("|"), "gu");
}

/**
 * The same emoji is written two ways across every codebase: with and without
 * the emoji variation selector (⚡ / ⚡️). A pair learned for one spelling must
 * dress the other too, or half the screens stay plain. Both spellings are
 * registered for every pair; multi-emoji sequences keep their shape.
 */
export function expandVariants(m: PremiumMap): PremiumMap {
  const out: PremiumMap = { ...m };
  for (const k of Object.keys(m)) {
    const bare = k.replace(/\uFE0F/g, "");
    if (bare && !(bare in out)) out[bare] = m[k];
    if (!k.includes("\uFE0F")) {
      const dressed = k.replace(/(\p{Extended_Pictographic})/gu, "$1\uFE0F");
      if (dressed !== k && !(dressed in out)) out[dressed] = m[k];
    }
  }
  return out;
}

/** Pairs from a getStickerSet-style stickers array. */
export function buildMapFromStickers(stickers: any[]): PremiumMap {
  const out: PremiumMap = {};
  for (const s of stickers ?? []) {
    if (s?.emoji && s?.custom_emoji_id) out[s.emoji] = String(s.custom_emoji_id);
  }
  return out;
}

/**
 * Pairs from an incoming message: the entity says the id, the text under
 * (offset, length) says which emoji it stands for. That is the whole lesson.
 */
export function harvestEntities(text: string, entities: any[]): PremiumMap {
  const out: PremiumMap = {};
  for (const e of entities ?? []) {
    if (e?.type !== "custom_emoji" || !e.custom_emoji_id) continue;
    const base = String(text ?? "").slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? 0)).trim();
    if (base) out[base] = String(e.custom_emoji_id);
  }
  return out;
}

/**
 * Wrap every mapped emoji in tg-emoji tags. Code and pre blocks keep their
 * literals (a custom emoji inside a code fence would lie about the bytes),
 * and tag interiors are never touched.
 */
export function premiumizeHtml(html: string, m: PremiumMap): string {
  const emo = matcherFor(m);
  if (!emo) return html;
  const wrapText = (t: string) => t.replace(emo, (e) => `<tg-emoji emoji-id="${m[e]}">${e}</tg-emoji>`);
  const tag = /<[^>]*>/g;
  let out = "", last = 0, protect = 0, hit: RegExpExecArray | null;
  while ((hit = tag.exec(html))) {
    const before = html.slice(last, hit.index);
    out += protect ? before : wrapText(before);
    out += hit[0];
    const t = hit[0].toLowerCase();
    if (t.startsWith("<code") || t.startsWith("<pre") || t.startsWith("<tg-emoji")) protect++;
    else if (t.startsWith("</code") || t.startsWith("</pre") || t.startsWith("</tg-emoji")) protect = Math.max(0, protect - 1);
    last = tag.lastIndex;
  }
  out += protect ? html.slice(last) : wrapText(html.slice(last));
  return out;
}

/** The reverse — the fallback path sends exactly what the feature wrote. */
export function stripPremium(html: string): string {
  return String(html ?? "").replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1");
}

/* ── the loading side ───────────────────────────────────────────────────── */

async function readMapFromKv(env: any): Promise<PremiumMap | null> {
  const raw = await env?.CACHE?.get(KV_MAP_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && Object.keys(m).length ? m : null;
  } catch {
    return null;
  }
}

async function saveMapToKv(env: any, m: PremiumMap): Promise<PremiumMap> {
  const merged = { ...(await readMapFromKv(env).catch(() => null) ?? {}), ...m };
  await env?.CACHE?.put(KV_MAP_KEY, JSON.stringify(merged), { expirationTtl: MAP_TTL }).catch(() => null);
  return merged;
}

async function fetchBuiltInSet(env: any): Promise<PremiumMap | null> {
  for (const name of CANDIDATE_SETS) {
    const res: any = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getStickerSet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => r.json()).catch(() => null);
    const m = res?.ok ? buildMapFromStickers(res.result?.stickers) : null;
    if (m && Object.keys(m).length) return m;
  }
  return null;
}

/**
 * The map for this isolate — or null when premium is unavailable. Served from
 * memory once loaded; the first call per isolate pays one KV read (and once
 * per week, one Bot API call). An absent table is also cached, briefly, so a
 * bot without any pairs does not re-ask on every message.
 */
export async function getPremiumMap(env: any): Promise<PremiumMap | null> {
  if (Date.now() < offUntil || Date.now() < emptyUntil) return null;
  if (cached && Object.keys(cached).length) return cached;
  if (!loading) {
    loading = (async () => {
      const off = await env?.CACHE?.get(KV_OFF_KEY).catch(() => null);
      if (off && Date.now() < Number(off)) { offUntil = Number(off); return null; }
      let m = await readMapFromKv(env).catch(() => null);
      if (!m || !Object.keys(m).length) m = await fetchBuiltInSet(env).catch(() => null);
      if (m && Object.keys(m).length) {
        cached = expandVariants(m);
        await saveMapToKv(env, m).catch(() => null);   // KV keeps the raw pairs
        return cached;
      }
      emptyUntil = Date.now() + 600_000;
      return null;
    })().finally(() => { loading = null; }).catch(() => null);
  }
  return loading;
}

/** A premium emoji was refused — stand down for an hour, everywhere. */
export async function notePremiumRejection(env: any): Promise<void> {
  cached = null;
  offUntil = Date.now() + OFF_TTL * 1000;
  await env?.CACHE?.put(KV_OFF_KEY, String(offUntil), { expirationTtl: OFF_TTL }).catch(() => null);
}

/** Learn from a message that carried custom emojis. */
export async function noteIncomingCustomEmoji(env: any, text: string, entities: any[]): Promise<void> {
  const learned = harvestEntities(text, entities);
  if (!Object.keys(learned).length) return;
  // harvesting also proves custom emojis live in this chat — clear any stale
  // stand-down or negative cache, the pairs are real regardless of permission
  offUntil = 0;
  emptyUntil = 0;
  await env?.CACHE?.delete(KV_OFF_KEY).catch(() => null);
  const merged = await saveMapToKv(env, learned).catch(() => null as PremiumMap | null);
  if (merged) cached = expandVariants(merged);
}
