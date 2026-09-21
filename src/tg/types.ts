/** Minimal, complete-enough Telegram Bot API types. */

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: User;
  language?: string;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  from?: User;
  chat: Chat;
  date: number;
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  caption_entities?: MessageEntity[];
  reply_to_message?: Message;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; title?: string };
  web_app_data?: { data: string; button_text: string };
  new_chat_members?: User[];
  left_chat_member?: User;
  pinned_message?: Message;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
  game_short_name?: string;
}

export interface InlineQuery {
  id: string;
  from: User;
  query: string;
  offset: string;
  chat_type?: string;
}

export interface ChosenInlineResult {
  result_id: string;
  from: User;
  query: string;
}

export interface PreCheckoutQuery { id: string; from: User; currency: string; total_amount: number; invoice_payload: string }

export type Update = {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  callback_query?: CallbackQuery;
  inline_query?: InlineQuery;
  chosen_inline_result?: ChosenInlineResult;
  pre_checkout_query?: PreCheckoutQuery;
  my_chat_member?: { chat: Chat; from: User; new_chat_member: { status: string; user: User } };
  poll_answer?: unknown;
};

/** Result of a Bot API call. */
export type TgOk<T> = { ok: true; result: T } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  copy_text?: { text: string };
  pay?: boolean;
}
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };
export type ReplyKeyboardMarkup = {
  keyboard: { text: string; web_app?: { url: string } }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
};

export interface InlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  thumbnail_url?: string;
  input_message_content: { message_text: string; parse_mode?: string; disable_web_page_preview?: boolean };
  reply_markup?: InlineKeyboardMarkup;
}
export interface InlineQueryResultPhoto {
  type: "photo";
  id: string;
  photo_url: string;
  thumbnail_url: string;
  title?: string;
  description?: string;
  caption?: string;
  parse_mode?: string;
  reply_markup?: InlineKeyboardMarkup;
}
export type InlineQueryResult = InlineQueryResultArticle | InlineQueryResultPhoto;

export interface SendMessageOpts {
  parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  protect_content?: boolean;
  link_preview_options?: { is_disabled?: boolean; url?: string; prefer_large_media?: boolean; show_above_text?: boolean };
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | { remove_keyboard: true };
  message_thread_id?: number;
  reply_to_message_id?: number;
  allow_sending_without_reply?: boolean;
}

export const tgEscape = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const tgEscapeAttr = (s: string) => tgEscape(s).replace(/"/g, "&quot;");

export const code = (s: string) => `<code>${tgEscape(s)}</code>`;
export const b = (s: string) => `<b>${tgEscape(s)}</b>`;
export const i = (s: string) => `<i>${tgEscape(s)}</i>`;
export const link = (text: string, url: string) => `<a href="${tgEscapeAttr(url)}">${tgEscape(text)}</a>`;
export const pre = (lang: string, s: string) =>
  `<pre><code class="language-${tgEscapeAttr(lang)}">${tgEscape(s)}</code></pre>`;
