import type { Env } from "../env";
import type {
  CallbackQuery, InlineKeyboardMarkup, InlineQueryResult, SendMessageOpts, TgOk, Update,
} from "./types";

/**
 * Telegram Bot API client.
 *  • automatic 429 / 5xx retry with backoff (respects retry_after)
 *  • chunking of long messages (Telegram hard limit 4096 chars)
 *  • "message is not modified" is swallowed (silent edit)
 *  • optional daily API-call meter via Analytics Engine
 */
export class Telegram {
  constructor(private readonly env: Env) {}

  private url(method: string) {
    return `https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`;
  }

  async call<T = any>(
    method: string,
    payload: Record<string, unknown> = {},
    opts: { formData?: FormData; retries?: number } = {},
  ): Promise<TgOk<T>> {
    const retries = opts.retries ?? 2;
    let lastErr: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const init: RequestInit = opts.formData
          ? { method: "POST", body: opts.formData }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            };
        const res = await fetch(this.url(method), init);
        this.env.ANALYTICS?.writeDataPoint({ blobs: ["tg_api", method], doubles: [1] });
        const json = (await res.json()) as TgOk<T>;
        if (json.ok) return json;

        // Silent-no-op cases: not an error for us.
        if (/message is not modified/i.test(json.description ?? "")) return json;
        if (json.error_code === 429 || json.error_code >= 500) {
          const wait = (json.parameters?.retry_after ?? 1) * 1000 + 250;
          await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
          lastErr = json;
          continue;
        }
        return json;
      } catch (e: any) {
        lastErr = { ok: false, error_code: 0, description: String(e?.message ?? e) };
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return lastErr as TgOk<T>;
  }

  // ── high level helpers ──────────────────────────────────────────────────
  sendMessage(chat_id: number | string, text: string, opts: SendMessageOpts = {}) {
    return this.call<{ message_id: number }>("sendMessage", { chat_id, text, ...opts });
  }

  /** Sends text, auto-splitting at 4096 chars on paragraph boundaries. */
  async sendLong(chat_id: number | string, text: string, opts: SendMessageOpts = {}) {
    const MAX = 4000;
    if (text.length <= MAX) return this.sendMessage(chat_id, text, opts);
    const chunks = splitSmart(text, MAX);
    let last: TgOk<any> = { ok: false, error_code: 0, description: "empty" };
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.sendMessage(chat_id, chunks[i] + (isLast ? "" : `\n\n<i>…${i + 2}/${chunks.length}</i>`), {
        ...opts,
        reply_markup: isLast ? opts.reply_markup : undefined,
      });
    }
    return last;
  }

  editMessageText(chat_id: number | string, message_id: number, text: string, opts: SendMessageOpts = {}) {
    return this.call("editMessageText", { chat_id, message_id, text, ...opts });
  }

  editMessageReplyMarkup(chat_id: number | string, message_id: number, reply_markup: InlineKeyboardMarkup) {
    return this.call("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
  }

  answerCallbackQuery(id: string, text?: string, show_alert = false) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text, show_alert, cache_time: 0 });
  }

  answerInlineQuery(id: string, results: InlineQueryResult[], cache_time = 30, next_offset = "") {
    return this.call("answerInlineQuery", { inline_query_id: id, results, cache_time, is_personal: true, next_offset });
  }

  async sendChatAction(chat_id: number, action = "typing") {
    return this.call("sendChatAction", { chat_id, action });
  }

  deleteMessage(chat_id: number, message_id: number) {
    return this.call("deleteMessage", { chat_id, message_id });
  }

  /**
   * Rich messages (Bot API 10.3): headings, tables, collapsible blocks, pull
   * quotes, footnotes. The caller passes the HTML body; `rich_message_extras`
   * is a local convention carrying `is_rtl` so the layout follows the language.
   */
  sendRichMessage(chat_id: number | string, html: string, opts: SendMessageOpts & { rich_message_extras?: { is_rtl?: boolean } } = {}) {
    const { rich_message_extras, ...rest } = opts as any;
    return this.call<{ message_id: number }>("sendRichMessage", {
      chat_id,
      rich_message: { html, ...(rich_message_extras ?? {}) },
      ...rest,
    });
  }

  /** Edit an existing message into a rich one. */
  editRichMessage(chat_id: number | string, message_id: number, html: string, opts: SendMessageOpts & { rich_message_extras?: { is_rtl?: boolean } } = {}) {
    const { rich_message_extras, ...rest } = opts as any;
    return this.call("editMessageText", {
      chat_id, message_id,
      rich_message: { html, ...(rich_message_extras ?? {}) },
      ...rest,
    });
  }

  setMyCommands(commands: { command: string; description: string }[], scope?: Record<string, unknown>, language_code?: string) {
    return this.call("setMyCommands", { commands, scope, language_code });
  }

  setWebhook(url: string, secret_token: string, drop_pending = true) {
    return this.call("setWebhook", {
      url, secret_token, drop_pending_updates: drop_pending, max_connections: 40,
      allowed_updates: ["message", "callback_query", "inline_query", "channel_post", "my_chat_member", "chosen_inline_result", "pre_checkout_query"],
    });
  }

  async sendDocument(chat_id: number, filename: string, data: Blob | ArrayBuffer | Uint8Array | ReadableStream, caption?: string, opts: SendMessageOpts = {}) {
    const fd = new FormData();
    fd.append("chat_id", String(chat_id));
    if (caption) fd.append("caption", caption.slice(0, 1024));
    if (opts.parse_mode) fd.append("parse_mode", opts.parse_mode);
    if (opts.reply_markup) fd.append("reply_markup", JSON.stringify(opts.reply_markup));
    fd.append("document", new Blob([data as any]), filename);
    return this.call<{ message_id: number }>("sendDocument", {}, { formData: fd, retries: 1 });
  }

  /**
   * Send a photo by bytes, or by a `file_id` we already uploaded once.
   *
   * A `file_id` is the cheap path: Telegram keeps the image, we keep 40 bytes of
   * string, and the welcome banner costs no upload on every /start. Passing a
   * string therefore goes through the JSON method instead of a multipart form.
   */
  sendPhoto(chat_id: number, photo: string | Blob | ArrayBuffer | Uint8Array, caption?: string, opts: SendMessageOpts = {}) {
    if (typeof photo === "string") {
      return this.call<{ message_id: number }>("sendPhoto", {
        chat_id, photo, ...(caption ? { caption } : {}), ...opts,
      });
    }
    const fd = new FormData();
    fd.append("chat_id", String(chat_id));
    if (caption) fd.append("caption", caption.slice(0, 1024));
    if (opts.parse_mode) fd.append("parse_mode", opts.parse_mode);
    if (opts.reply_markup) fd.append("reply_markup", JSON.stringify(opts.reply_markup));
    fd.append("photo", new Blob([photo as any]), "card.png");
    return this.call<{ message_id: number }>("sendPhoto", {}, { formData: fd, retries: 1 });
  }

}

/** Split text preferring paragraph → line → space boundaries. */
export function splitSmart(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export const cb = (q: CallbackQuery) => String(q.data ?? "");

/** Short, URL-safe callback data encoder: ns:action:arg1,arg2 … (≤64 bytes). */
export function cbd(ns: string, action: string, ...args: (string | number)[]) {
  const s = `${ns}:${action}:${args.map((a) => String(a).replace(/[:,]/g, "_")).join(",")}`;
  return s.length > 64 ? s.slice(0, 64) : s;
}
export function cbParse(data: string): { ns: string; action: string; args: string[] } {
  const [ns = "", action = "", rest = ""] = data.split(":");
  return { ns, action, args: rest ? rest.split(",") : [] };
}
