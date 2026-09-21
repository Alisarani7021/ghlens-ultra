import type { Env } from "../env";
import type { Store, UserRow } from "./db";
import type { Telegram } from "../tg/api";
import type { AiBrain } from "../ai/brain";
import type { RepoCard } from "../features/cards";
import type { InlineKeyboardMarkup, Message, User } from "../tg/types";
import type { Loc } from "../tg/keyboards";
import type { GithubRest } from "../github/rest";

/** Everything a feature handler needs — one object, no hidden globals. */
export interface H {
  env: Env;
  store: Store;
  tg: Telegram;
  ai: AiBrain;
  card: RepoCard;
  u: User;
  user: UserRow | null;
  loc: Loc;
  chatId: number;
  msgId?: number;
  cbId?: string;
  args: string[];
  text: string;
  msg?: Message;
  /** Edits the current message if we're in a callback, otherwise sends. */
  reply(body: string, keyboard?: InlineKeyboardMarkup, edit?: boolean): Promise<void>;
  toast(text: string, alert?: boolean): Promise<void>;
  loading(label?: string): Promise<void>;
  /** Session DO for wizards + hot cache. */
  session: UserSessionStub;
  /** Cached GitHub REST client (per-request instance). */
  gh(): GithubRest;
}

export interface UserSessionStub {
  get(k: string): Promise<any>;
  set(k: string, v: unknown): Promise<void>;
  clear(keys?: string[]): Promise<void>;
  cardType(t?: "auto" | "full" | "compact"): Promise<any>;
  rememberCard(full: string, text: string): Promise<string>;
  lastCard(full: string): Promise<{ full: string; text: string; at: number } | null>;
  acquire(tag: string): Promise<boolean>;
  release(): Promise<void>;
  bump(c: string, by?: number): Promise<number>;
}

export type Handler = (h: H) => Promise<void> | void;

/** Per-locale progress labels (spinner replacement — Telegram has no spinners). */
export const LOADING: Record<string, string[]> = {
  fa: ["در حال جست‌وجو…", "دارم مخازن را می‌کاوم…", "در حال تحلیل…", "چند لحظه صبر کن…"],
  en: ["Searching…", "Scanning repositories…", "Analyzing…", "One moment…"],
  ar: ["جارٍ البحث…", "أفحص المستودعات…", "جارٍ التحليل…"],
  ru: ["Поиск…", "Сканирую репозитории…", "Анализ…"],
  zh: ["搜索中…", "正在扫描仓库…", "分析中…"],
};
export const loadingText = (loc: string) => (LOADING[loc] ?? LOADING.en)[Math.floor(Math.random() * 4)];
