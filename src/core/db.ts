import type { Env } from "../env";
import type { User } from "../tg/types";
import { GithubRest, healthScore } from "../github/rest";
import type { RepoMeta } from "../github/graphql";

/** Data-access layer: users, repos, favourites, subscriptions, gamification, analytics. */
export class Store {
  constructor(private env: Env) {}

  // ── users ───────────────────────────────────────────────────────────────
  async upsertUser(u: User, locale?: string) {
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO users (id, username, first_name, locale, referral_code, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name,
         last_seen_at=excluded.last_seen_at, locale=COALESCE(NULLIF(excluded.locale, ''), users.locale)`,
    ).bind(u.id, u.username ?? null, u.first_name ?? null, (locale ?? u.language_code?.slice(0, 2) ?? this.env.DEFAULT_LOCALE), randCode(u.id), now, now)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  user(id: number) {
    return this.env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first<UserRow>().catch(() => null);
  }

  async setLocale(id: number, locale: string) {
    await this.env.DB.prepare(`UPDATE users SET locale=? WHERE id=?`).bind(locale, id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  async setInterests(id: number, interests: string[]) {
    await this.env.DB.prepare(`UPDATE users SET interests=? WHERE id=?`).bind(JSON.stringify(interests.slice(0, 30)), id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  async setPlan(id: number, plan: string) {
    await this.env.DB.prepare(`UPDATE users SET plan=? WHERE id=?`).bind(plan, id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  /** Simple XP + level curve (level n needs 120n XP). Badges are earned, not bought. */
  async addXp(id: number, xp: number, reason?: string) {
    const u = await this.user(id);
    if (!u) return null;
    const total = (u.xp ?? 0) + xp;
    let level = 1;
    while (total >= 120 * level * (level + 1) / 2) level++;
    const badges: string[] = JSON.parse(u.badges ?? "[]");
    const earned: string[] = [];
    const maybe = (cond: boolean, badge: string) => { if (cond && !badges.includes(badge)) { badges.push(badge); earned.push(badge); } };
    maybe(level >= 5, "🥉 کاوشگر");
    maybe(level >= 10, "🥈 شکارچی ستاره");
    maybe(level >= 20, "🥇 استاد گیتهاب");
    maybe(level >= 35, "💎 اسطوره");
    await this.env.DB.prepare(`UPDATE users SET xp=?, level=?, badges=? WHERE id=?`)
      .bind(total, level, JSON.stringify(badges), id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    if (reason) await this.event(id, "xp", reason, { xp });
    return { xp: total, level, earned };
  }

  /** Free-tier daily quota gate. Returns remaining or -1 for unlimited. */
  async quota(id: number, cost = 1) {
    const u = await this.user(id);
    if (!u) return { ok: true, remaining: -1 };
    if (u.plan !== "free") return { ok: true, remaining: -1 };
    const today = new Date().toISOString().slice(0, 10);
    const resetAt = Date.parse(today);
    let used = u.daily_queries ?? 0;
    if ((u.daily_reset_at ?? 0) < resetAt) {
      used = 0;
      await this.env.DB.prepare(`UPDATE users SET daily_queries=0, daily_reset_at=? WHERE id=?`).bind(resetAt, id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    const limit = Number(this.env.FREE_TIER_DAILY_QUERIES || 120);
    if (used + cost > limit) return { ok: false, remaining: 0, limit };
    await this.env.DB.prepare(`UPDATE users SET daily_queries=daily_queries+? WHERE id=?`).bind(cost, id).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return { ok: true, remaining: limit - used - cost, limit };
  }

  // ── analytics ───────────────────────────────────────────────────────────
  async event(userId: number | null, kind: string, name?: string, meta?: unknown) {
    const ts = Date.now();
    await this.env.DB.prepare(`INSERT INTO events (ts, user_id, kind, name, meta) VALUES (?,?,?,?,?)`)
      .bind(ts, userId, kind, name ?? null, meta ? JSON.stringify(meta) : null).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    this.env.ANALYTICS?.writeDataPoint({
      blobs: [kind, name ?? "", String(userId ?? 0)],
      doubles: [1],
      indexes: [String(userId ?? 0)],
    });
  }

  // ── repos (materialised metadata) ───────────────────────────────────────
  async saveRepo(meta: RepoMeta, extra: Partial<RepoRow> = {}) {
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO repos (full_name, owner, name, description, homepage, topics, language, languages, stars, forks,
         watchers, open_issues, size_kb, license, archived, is_fork, default_branch, pushed_at, created_at,
         health_score, velocity, ai_summary_fa, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(full_name) DO UPDATE SET
         description=excluded.description, topics=excluded.topics, stars=excluded.stars, forks=excluded.forks,
         watchers=excluded.watchers, open_issues=excluded.open_issues, language=excluded.language,
         languages=excluded.languages, license=excluded.license, archived=excluded.archived,
         pushed_at=excluded.pushed_at, health_score=excluded.health_score, velocity=excluded.velocity,
         ai_summary_fa=COALESCE(excluded.ai_summary_fa, repos.ai_summary_fa), updated_at=excluded.updated_at`,
    ).bind(
      meta.full_name, meta.owner, meta.name, meta.description ?? null, meta.homepage ?? null,
      JSON.stringify(meta.topics ?? []), meta.language, JSON.stringify(meta.languages ?? []),
      meta.stars, meta.forks, meta.watchers, meta.issues, meta.size_kb, meta.license,
      meta.archived ? 1 : 0, 0, meta.default_branch,
      meta.pushed_at ? Date.parse(meta.pushed_at) : null, meta.created_at ? Date.parse(meta.created_at) : null,
      meta.health, meta.stars_per_day, extra.ai_summary_fa ?? null, now,
    ).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  repo(full: string) {
    return this.env.DB.prepare(`SELECT * FROM repos WHERE full_name=?`).bind(full).first<RepoRow>().catch(() => null);
  }

  /** Fresh-or-fetch: DB row younger than `ttlSec` wins, otherwise hit GitHub. */
  async repoFresh(full: string, ttlSec = 1800) {
    const row = await this.repo(full);
    if (row && row.updated_at && Date.now() - row.updated_at < ttlSec * 1000) return row;
    const gh = new GithubRest(this.env);
    const m = await gh.repo(full, 300).catch(() => null);
    if (!m) return row;
    await this.saveRepo({
      full_name: m.full_name, owner: m.owner.login, name: m.name, description: m.description,
      homepage: m.homepage, topics: m.topics ?? [], language: m.language, languages: [],
      stars: m.stargazers_count, forks: m.forks_count, watchers: m.watchers_count, issues: m.open_issues_count,
      prs: 0, license: m.license?.spdx_id ?? null, archived: m.archived, pushed_at: m.pushed_at,
      created_at: m.created_at, default_branch: m.default_branch, size_kb: m.size,
      health: healthScore({ stars: m.stargazers_count, forks: m.forks_count, open_issues: m.open_issues_count, pushed_at: m.pushed_at, created_at: m.created_at, license: m.license?.spdx_id, archived: m.archived, description: m.description, has_readme: true }),
      community_health: 0, has_ci: false, releases: 0, good_first: 0, help_wanted: 0, contributors: 0,
      stars_per_day: 0, redFlags: [], raw: m,
    });
    // GitHub redirects renamed repositories (facebook/react → react/react) and
    // the row is stored under the canonical name, so look that up too.
    const byRequested = await this.repo(full);
    if (byRequested) return byRequested;
    return await this.repo(m.full_name);
  }

  // ── favourites / likes / subscriptions ──────────────────────────────────
  async fav(userId: number, full: string, note?: string) {
    await this.env.DB.prepare(
      `INSERT INTO favorites (user_id, full_name, note, created_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, full_name) DO UPDATE SET note=COALESCE(excluded.note, favorites.note)`,
    ).bind(userId, full, note ?? null, Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  async unfav(userId: number, full: string) {
    await this.env.DB.prepare(`DELETE FROM favorites WHERE user_id=? AND full_name=?`).bind(userId, full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  async isFav(userId: number, full: string) {
    return !!(await this.env.DB.prepare(`SELECT 1 FROM favorites WHERE user_id=? AND full_name=?`).bind(userId, full).first().catch(() => null));
  }
  favs(userId: number, limit = 50) {
    return this.env.DB.prepare(`SELECT full_name, note, created_at FROM favorites WHERE user_id=? ORDER BY created_at DESC LIMIT ?`)
      .bind(userId, limit).all<{ full_name: string; note: string | null; created_at: number }>().catch(() => ({ results: [] }));
  }

  async like(userId: number, full: string, on: boolean) {
    if (on) await this.env.DB.prepare(`INSERT OR REPLACE INTO likes (user_id, full_name, ts) VALUES (?,?,?)`).bind(userId, full, Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    else await this.env.DB.prepare(`DELETE FROM likes WHERE user_id=? AND full_name=?`).bind(userId, full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  async likeCount(full: string) {
    const r = await this.env.DB.prepare(`SELECT COUNT(*) AS c FROM likes WHERE full_name=?`).bind(full).first<{ c: number }>().catch(() => null);
    return r?.c ?? 0;
  }

  async subscribe(userId: number, full: string, events: string[]) {
    await this.env.DB.prepare(
      `INSERT INTO subscriptions (user_id, full_name, events, created_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, full_name) DO UPDATE SET events=excluded.events`,
    ).bind(userId, full, JSON.stringify(events), Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  async unsubscribe(userId: number, full: string) {
    await this.env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=? AND full_name=?`).bind(userId, full).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  subsOf(userId: number) {
    return this.env.DB.prepare(`SELECT full_name, events, muted_until FROM subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 60`)
      .bind(userId).all<{ full_name: string; events: string; muted_until: number }>().catch(() => ({ results: [] }));
  }
  watchersOf(full: string) {
    return this.env.DB.prepare(`SELECT user_id, events, muted_until FROM subscriptions WHERE full_name=?`)
      .bind(full).all<{ user_id: number; events: string; muted_until: number }>().catch(() => ({ results: [] }));
  }

  // ── chats (AI assistant) ────────────────────────────────────────────────
  async ensureChat(id: string, userId: number, repo?: string) {
    await this.env.DB.prepare(`INSERT OR IGNORE INTO chats (id, user_id, repo, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .bind(id, userId, repo ?? null, Date.now(), Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  async addMessage(chatId: string, role: "user" | "assistant" | "system", content: string) {
    await this.env.DB.prepare(`INSERT INTO messages (chat_id, role, content, ts) VALUES (?,?,?,?)`)
      .bind(chatId, role, content, Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.env.DB.prepare(`UPDATE chats SET updated_at=? WHERE id=?`).bind(Date.now(), chatId).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  history(chatId: string, limit = 12) {
    return this.env.DB.prepare(`SELECT role, content FROM messages WHERE chat_id=? ORDER BY ts DESC LIMIT ?`)
      .bind(chatId, limit).all<{ role: string; content: string }>().catch(() => ({ results: [] }));
  }

  /** Growth leaders: biggest star delta in the window (from our own snapshots). */
  async growthLeaders(days = 7, limit = 15) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { results } = await this.env.DB.prepare(
      `SELECT a.full_name, (a.stars - b.stars) AS gained, a.stars AS now
       FROM repo_snapshots a JOIN repo_snapshots b ON a.full_name = b.full_name
       WHERE a.day = (SELECT MAX(day) FROM repo_snapshots)
         AND b.day <= ?
       GROUP BY a.full_name
       ORDER BY gained DESC LIMIT ?`,
    ).bind(since, limit).all<{ full_name: string; gained: number; now: number }>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }

  // ── trending board reads ────────────────────────────────────────────────
  async board(period: string, language = "all", limit = 10) {
    const { results } = await this.env.DB.prepare(
      `SELECT payload FROM trending WHERE period=? AND language=? AND day=(SELECT MAX(day) FROM trending WHERE period=? AND language=?) ORDER BY rank LIMIT ?`,
    ).bind(period, language, period, language, limit).all<{ payload: string }>().catch(() => ({ results: [] as any[] }));
    return (results ?? []).map((r) => { try { return JSON.parse(r.payload); } catch { return null; } }).filter(Boolean);
  }

  // ── leaderboard ─────────────────────────────────────────────────────────
  static week(d = new Date()) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const start = new Date(Date.UTC(y, 0, 1));
    const wk = Math.ceil(((t.getTime() - start.getTime()) / 86400000 + 1) / 7);
    return `${y}-W${String(wk).padStart(2, "0")}`;
  }

  async bumpLeaderboard(userId: number, metric: string, value = 1) {
    await this.env.DB.prepare(
      `INSERT INTO leaderboard (week, user_id, metric, value) VALUES (?,?,?,?)
       ON CONFLICT(week, user_id, metric) DO UPDATE SET value = value + excluded.value`,
    ).bind(Store.week(), userId, metric, value).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  async leaderboard(metric = "queries", limit = 10) {
    const { results } = await this.env.DB.prepare(
      `SELECT l.user_id, l.value, u.first_name, u.username, u.level FROM leaderboard l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.week=? AND l.metric=? ORDER BY l.value DESC LIMIT ?`,
    ).bind(Store.week(), metric, limit).all<any>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }

  // ── co-star graph (recommendation engine) ───────────────────────────────
  async recordCoStars(seed: string, others: string[]) {
    if (!others.length) return;
    await this.env.DB.batch(
      others.slice(0, 18).map((o) =>
        this.env.DB.prepare(`INSERT INTO co_star (source, target, weight) VALUES (?,?,1) ON CONFLICT(source, target) DO UPDATE SET weight = weight + 1`)
          .bind(seed, o),
      ),
    ).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  async similar(full: string, limit = 8) {
    const { results } = await this.env.DB.prepare(
      `SELECT target AS full_name, weight FROM co_star WHERE source=? ORDER BY weight DESC LIMIT ?`,
    ).bind(full, limit).all<any>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }

  // ── digest queue ────────────────────────────────────────────────────────
  async enqueueDigest(userId: number, kind: string, payload: unknown, sendAfter = Date.now()) {
    await this.env.DB.prepare(`INSERT OR REPLACE INTO digest_queue (id, user_id, kind, payload, send_after) VALUES (?,?,?,?,?)`)
      .bind(`${kind}:${userId}:${new Date().toISOString().slice(0, 10)}`, userId, kind, JSON.stringify(payload), sendAfter).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
}

export interface UserRow {
  id: number; username: string | null; first_name: string | null; locale: string;
  github_login: string | null; plan: string; xp: number; level: number;
  /** AES-GCM ciphertext + timestamp of the user's linked GitHub token (never plaintext). */
  github_token_enc: string | null; github_token_at: number | null;
  badges: string; interests: string; skills: string;
  daily_queries: number; daily_reset_at: number; banned: number;
  referral_by: number | null; referral_code: string | null;
  created_at: number; last_seen_at: number;
}

export interface RepoRow {
  full_name: string; owner: string; name: string; description: string | null; homepage: string | null;
  topics: string; language: string | null; languages: string; stars: number; forks: number; watchers: number;
  open_issues: number; size_kb: number; license: string | null; archived: number; is_fork: number;
  default_branch: string; pushed_at: number | null; created_at: number | null; health_score: number | null;
  velocity: number | null; ai_summary_fa: string | null; ai_summary_en: string | null; readme_fa: string | null;
  indexed_at: number | null; updated_at: number;
}

function randCode(seed: number) {
  return (seed.toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 10);
}
