-- ═══════════════════════════════════════════════════════════════════════════
--  GitHub Lens Ultra — D1 schema
--  Run:  npm run db:init        (remote)
--        npm run db:init:local  (local dev)
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,           -- telegram user id
  username       TEXT,
  first_name     TEXT,
  locale         TEXT NOT NULL DEFAULT 'fa',
  github_login   TEXT,                          -- linked GitHub account
  github_token_enc TEXT,                        -- AES-GCM ciphertext of the user's PAT (never plaintext)
  github_token_at  INTEGER,                     -- when it was linked
  plan           TEXT NOT NULL DEFAULT 'free',  -- free | pro | sponsor | admin
  xp             INTEGER NOT NULL DEFAULT 0,
  level          INTEGER NOT NULL DEFAULT 1,
  badges         TEXT NOT NULL DEFAULT '[]',    -- JSON array
  interests      TEXT NOT NULL DEFAULT '[]',    -- JSON array of topics/langs
  skills         TEXT NOT NULL DEFAULT '[]',    -- languages the user knows
  daily_queries  INTEGER NOT NULL DEFAULT 0,
  daily_reset_at INTEGER NOT NULL DEFAULT 0,
  banned         INTEGER NOT NULL DEFAULT 0,
  referral_by    INTEGER,
  referral_code  TEXT UNIQUE,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_locale    ON users(locale);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);

-- ── per-user daily counters (digest-independent analytics) ─────────────────
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  user_id  INTEGER,
  kind     TEXT NOT NULL,     -- command | callback | tool | ai | download …
  name     TEXT,
  meta     TEXT                -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts);

-- ── repositories (materialised metadata + snapshots) ───────────────────────
CREATE TABLE IF NOT EXISTS repos (
  full_name       TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  homepage        TEXT,
  topics          TEXT DEFAULT '[]',             -- JSON
  language        TEXT,
  languages       TEXT DEFAULT '{}',             -- JSON {lang: bytes}
  stars           INTEGER DEFAULT 0,
  forks           INTEGER DEFAULT 0,
  watchers        INTEGER DEFAULT 0,
  open_issues     INTEGER DEFAULT 0,
  size_kb         INTEGER DEFAULT 0,
  license         TEXT,
  archived        INTEGER DEFAULT 0,
  is_fork         INTEGER DEFAULT 0,
  default_branch  TEXT,
  pushed_at       INTEGER,
  created_at      INTEGER,
  health_score    REAL,
  velocity        REAL,                          -- stars / day (recent)
  ai_summary_fa   TEXT,                          -- cached Persian AI summary
  ai_summary_en   TEXT,
  readme_fa       TEXT,                          -- cached translated README (long)
  indexed_at      INTEGER,                       -- last vector index push
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_repos_stars    ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_language ON repos(language, stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_pushed   ON repos(pushed_at DESC);

-- ── star / growth snapshots: powers velocity, charts, leaderboards ─────────
CREATE TABLE IF NOT EXISTS repo_snapshots (
  full_name  TEXT NOT NULL,
  day        TEXT NOT NULL,      -- YYYY-MM-DD
  stars      INTEGER NOT NULL,
  forks      INTEGER NOT NULL,
  issues     INTEGER NOT NULL,
  delta      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (full_name, day)
);
CREATE INDEX IF NOT EXISTS idx_snap_day ON repo_snapshots(day, delta DESC);

-- ── trending snapshots (daily / weekly / monthly boards) ───────────────────
CREATE TABLE IF NOT EXISTS trending (
  period     TEXT NOT NULL,      -- daily | weekly | monthly | all
  language   TEXT NOT NULL DEFAULT 'all',
  rank       INTEGER NOT NULL,
  full_name  TEXT NOT NULL,
  score      REAL NOT NULL,
  day        TEXT NOT NULL,
  payload    TEXT,               -- JSON (card-ready)
  PRIMARY KEY (period, language, day, rank)
);
CREATE INDEX IF NOT EXISTS idx_trending_lookup ON trending(period, language, day);

-- ── bookmarks / likes / subscriptions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL,
  full_name  TEXT NOT NULL,
  note       TEXT,
  tags       TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, full_name)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id    INTEGER NOT NULL,
  full_name  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (user_id, full_name)
);

-- subscribe to releases / commits / issues / security of a repo
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id     INTEGER NOT NULL,
  full_name   TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '["release"]',   -- JSON array
  muted_until INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, full_name)
);
CREATE INDEX IF NOT EXISTS idx_subs_repo ON subscriptions(full_name);

-- release/commit watermarks for instant webhook notifications
CREATE TABLE IF NOT EXISTS watch_state (
  full_name     TEXT PRIMARY KEY,
  last_release  TEXT,
  last_tag      TEXT,
  last_commit   TEXT,
  last_checked  INTEGER
);

-- ── AI conversation (chat-with-repo / general assistant) ───────────────────
CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  repo       TEXT,               -- context repo, if any
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role    TEXT NOT NULL,         -- user | assistant | system
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, ts);

-- ── downloads / packaging jobs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS downloads (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  full_name  TEXT NOT NULL,
  ref        TEXT,
  kind       TEXT NOT NULL,      -- tarball | zip | split | bundle | release-asset
  bytes      INTEGER DEFAULT 0,
  r2_key     TEXT,
  parts      TEXT DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'queued',  -- queued|running|ready|failed
  error      TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dl_user ON downloads(user_id, created_at DESC);

-- ── helper GitHub Actions jobs (heavy work offloaded to Actions) ───────────
CREATE TABLE IF NOT EXISTS action_jobs (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,      -- split-7z | pkg-convert | bundle | mirror
  payload    TEXT NOT NULL,      -- JSON
  run_id     INTEGER,
  status     TEXT DEFAULT 'dispatched',
  created_at INTEGER NOT NULL
);

-- ── "people who starred this also starred" co-star graph ───────────────────
CREATE TABLE IF NOT EXISTS co_star (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source, target)
);
CREATE INDEX IF NOT EXISTS idx_costar_src ON co_star(source, weight DESC);

-- ── security advisories seen per repo (dedupe for alerts) ──────────────────
CREATE TABLE IF NOT EXISTS advisories (
  id         TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  severity   TEXT,
  summary    TEXT,
  published  TEXT,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (id, full_name)
);

-- ── GitHub webhook deliveries (audit + replay) ─────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_log (
  delivery   TEXT PRIMARY KEY,
  event      TEXT,
  repo       TEXT,
  payload    TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_ts ON webhook_log(ts DESC);

-- ── feature flags / runtime config (hot-swap without redeploy) ─────────────
CREATE TABLE IF NOT EXISTS flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── leaderboards (weekly gamification) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard (
  week     TEXT NOT NULL,     -- YYYY-WW
  user_id  INTEGER NOT NULL,
  metric   TEXT NOT NULL,     -- queries | stars_found | contributions
  value    INTEGER NOT NULL,
  PRIMARY KEY (week, user_id, metric)
);

-- daily digest queue (built by cron, drained by workers)
CREATE TABLE IF NOT EXISTS digest_queue (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,   -- daily | weekly | release | security | podcast
  payload    TEXT NOT NULL,
  send_after INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_digest_due ON digest_queue(sent_at, send_after);

-- ── AI usage meter (cost control, per user/feature/day) ────────────────────
CREATE TABLE IF NOT EXISTS ai_usage (
  day       TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  feature   TEXT NOT NULL,
  tokens    INTEGER NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, feature)
);


-- ── donated AI keys (pooled OpenAI-compatible endpoints) ──────────────────
-- Anyone can donate a key; the pool answers with whichever key is healthy, so
-- several small free keys add up to one working AI backend. Only ciphertext is
-- stored, and a key that returns 401/402/403/quota is deleted immediately.
CREATE TABLE IF NOT EXISTS ai_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER,                 -- telegram id of the donor
  label        TEXT NOT NULL DEFAULT '',-- what the donor called it
  provider     TEXT NOT NULL,           -- openrouter | groq | openai | xai | gemini | custom | local
  base_url     TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  enc_key      TEXT NOT NULL,           -- AES-GCM ciphertext, purpose "ai-key"
  status       TEXT NOT NULL DEFAULT 'ok',   -- ok | warn | new
  ok_count     INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_ok_at   INTEGER,
  last_fail_at INTEGER,               -- when it last failed (429s retire, then retry)
  last_err     TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_keys_status ON ai_keys(status, last_ok_at);
