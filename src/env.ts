/**
 * Cloudflare bindings + runtime configuration for GitHub Lens Ultra.
 */
export interface Env {
  // ── secrets ──────────────────────────────────────────────────────────────
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  /** Secret token compared against the X-Telegram-Bot-Api-Secret-Token header. */
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DOWNLOAD_SIGNING_KEY: string;
  HELPER_REPO_TOKEN?: string;
  /** Optional OpenAI-compatible gateway (Workers AI gateway, OpenRouter, …) */
  OPENAI_COMPAT_BASE_URL?: string;
  OPENAI_COMPAT_KEY?: string;

  // ── bindings ─────────────────────────────────────────────────────────────
  AI: Ai;
  DB: D1Database;
  CACHE: KVNamespace;
  STATE: KVNamespace;
  /** Optional: when the account has R2 enabled, archives + audio live here. */
  FILES?: R2Bucket;
  JOBS: Queue<Job>;
  SESSION: DurableObjectNamespace;
  /** Optional: enable Analytics Engine in the dashboard to bind this. */
  ANALYTICS?: AnalyticsEngineDataset;
  /** Optional: semantic index. Absent → search degrades to lexical-only. */
  INDEX?: VectorizeIndex;
  BROWSER?: Fetcher;

  // ── vars ─────────────────────────────────────────────────────────────────
  DEFAULT_LOCALE: string;
  WORKER_URL: string;
  ADMIN_IDS: string;
  HELPER_REPO: string;
  MAX_TG_UPLOAD_MB: string;
  FREE_TIER_DAILY_QUERIES: string;
}

/** Queue payloads — one union per heavy job type. */
export type Job =
  | { type: "index_repo"; full_name: string; force?: boolean }
  | { type: "refresh_meta"; full_name: string }
  | { type: "download"; download_id: string }
  | { type: "broadcast"; from: number; text: string; button?: { text: string; url: string } }
  | { type: "notify_subscribers"; full_name: string; event: string; payload: unknown }
  | { type: "podcast"; scope: "daily" | "weekly"; day: string }
  | { type: "snapshot"; day: string }
  | { type: "scan_security"; full_name: string; manifest?: string }
  | { type: "action_job"; job_id: string }
  | { type: "digest"; kind: "daily" | "weekly"; user_id?: number };

export type Ctx = {
  waitUntil: (p: Promise<unknown>) => void;
  requestId: string;
};

export const bool = (v: string | undefined | null, def = false) =>
  v === undefined || v === null ? def : /^(1|true|yes|on)$/i.test(v);

export const num = (v: string | undefined | null, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const isAdmin = (env: Env, id: number) =>
  (env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(String(id));
