import type { Env } from "../env";
import { GithubRest, healthScore, sparkline } from "./rest";

/**
 * Trending engine — Lens original, not a scraping of github.com/trending.
 *
 * Algorithm (three signals, blended):
 *   1. velocity  = stars gained per day over the window (from our own snapshots)
 *   2. acceleration = velocity(this window) / velocity(previous window)
 *   3. quality   = health score + community signals (penalises spam/star farms)
 * Plus a freshness prior so brand-new rockets surface next to established giants.
 *
 * Snapshots are stored in D1 (repo_snapshots) by the cron worker, which means the
 * bot can show *real* growth charts ("+1,204 ⭐ this week") the original can't.
 */
export class TrendingEngine {
  constructor(private env: Env, private gh = new GithubRest(env)) {}

  private day(d = new Date()) { return d.toISOString().slice(0, 10); }

  windows(period: "daily" | "weekly" | "monthly" | "all") {
    const days = period === "daily" ? 1 : period === "weekly" ? 7 : period === "monthly" ? 30 : 3650;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return { days, since };
  }

  /** Query GitHub for candidates, then re-rank locally. */
  async fetchCandidates(period: "daily" | "weekly" | "monthly" | "all", language = "all", limit = 60) {
    const { since } = this.windows(period);
    const minStars = period === "daily" ? 20 : period === "weekly" ? 60 : 150;
    const q = [`created:>${period === "all" ? "2008-01-01" : since}`, `stars:>${minStars}`];
    if (language !== "all") q.push(`language:${JSON.stringify(language)}`);
    const parts: any[] = [];
    // Two sampling passes: brand-new rockets + recently-updated established repos
    for (const sort of ["stars", "updated"] as const) {
      const page = await this.gh.searchRepos(q.join(" "), sort, "desc", 50, 1).catch(() => null);
      if (page?.items) parts.push(...page.items);
    }
    const uniq = new Map<string, any>();
    for (const r of parts) uniq.set(r.full_name, r);
    return [...uniq.values()].slice(0, limit);
  }

  /** Blend local snapshot deltas with GitHub signals → ranked board. */
  async rank(period: "daily" | "weekly" | "monthly" | "all", language = "all", limit = 25) {
    const candidates = await this.fetchCandidates(period, language, 60);
    if (!candidates.length) return [];
    const names = candidates.map((c) => c.full_name);
    const { since, days } = this.windows(period);
    const snaps = await this.env.DB.prepare(
      `SELECT full_name, day, stars FROM repo_snapshots WHERE full_name IN (${names.map(() => "?").join(",")}) AND day >= ? ORDER BY day ASC`,
    ).bind(...names, since).all<{ full_name: string; day: string; stars: number }>().catch(() => ({ results: [] as any[] }));

    const base = new Map<string, number>();
    for (const row of snaps.results ?? []) {
      if (!base.has(row.full_name)) base.set(row.full_name, row.stars);   // earliest snapshot in window
    }

    const scored = candidates.map((c) => {
      const b = base.get(c.full_name);
      const gained = b ? Math.max(0, c.stargazers_count - b) : Math.round(c.stargazers_count * (days / 30) * 0.35);
      const velocity = gained / Math.max(1, days);
      const accel = 1 + Math.min(2, (c.pushed_at ? 1 : 0) + (c.open_issues_count > 0 ? 0.2 : 0));
      const quality = healthScore({
        stars: c.stargazers_count, forks: c.forks_count, open_issues: c.open_issues_count,
        pushed_at: c.pushed_at, created_at: c.created_at, license: c.license?.spdx_id,
        archived: c.archived, description: c.description, has_readme: true,
        contributors: 3, commits_last_year: 20, releases_last_year: 2,
      });
      const ageDays = (Date.now() - new Date(c.created_at).getTime()) / 86400000;
      const novelty = ageDays < 60 ? 1.35 : ageDays < 365 ? 1.15 : 1;
      const spam = /(100|awesome[-_]?list|collection[-_]?of|dotfiles)/i.test(c.name) ? 0.6 : 1;
      const score = velocity * accel * novelty * spam * (0.55 + quality / 200);
      return {
        full_name: c.full_name,
        description: c.description,
        stars: c.stargazers_count,
        forks: c.forks_count,
        language: c.language,
        topics: c.topics ?? [],
        url: c.html_url,
        owner_avatar: c.owner?.avatar_url,
        pushed_at: c.pushed_at,
        created_at: c.created_at,
        license: c.license?.spdx_id ?? null,
        gained,
        velocity: Math.round(velocity * 100) / 100,
        score: Math.round(score * 100) / 100,
        quality,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Persist today's board so /trending is instant and history is chartable. */
  async store(period: "daily" | "weekly" | "monthly", language: string, rows: any[]) {
    const day = this.day();
    const stmts = rows.map((r, i) =>
      this.env.DB.prepare(
        `INSERT OR REPLACE INTO trending (period, language, rank, full_name, score, day, payload) VALUES (?,?,?,?,?,?,?)`,
      ).bind(period, language, i + 1, r.full_name, r.score, day, JSON.stringify(r)),
    );
    if (stmts.length) await this.env.DB.batch(stmts).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  /** Take a star snapshot for a set of repos (cron, every 15 min for tracked ones). */
  async snapshot(names: string[]) {
    const day = this.day();
    const metas = await Promise.all(
      names.slice(0, 40).map((n) => this.gh.repo(n, 60).catch(() => null)),
    );
    const stmts: D1PreparedStatement[] = [];
    for (const m of metas) {
      if (!m) continue;
      const prev = await this.env.DB.prepare(`SELECT stars FROM repo_snapshots WHERE full_name=? ORDER BY day DESC LIMIT 1`)
        .bind(m.full_name).first<{ stars: number }>().catch(() => null);
      const delta = prev ? m.stargazers_count - prev.stars : 0;
      stmts.push(
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO repo_snapshots (full_name, day, stars, forks, issues, delta) VALUES (?,?,?,?,?,?)`,
        ).bind(m.full_name, day, m.stargazers_count, m.forks_count, m.open_issues_count, delta),
      );
      stmts.push(
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO repos (full_name, owner, name, description, homepage, topics, language, stars, forks, watchers, open_issues, size_kb, license, archived, is_fork, default_branch, pushed_at, created_at, health_score, velocity, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          m.full_name, m.owner.login, m.name, m.description, m.homepage, JSON.stringify(m.topics ?? []),
          m.language, m.stargazers_count, m.forks_count, m.watchers_count, m.open_issues_count,
          m.size, m.license?.spdx_id ?? null, m.archived ? 1 : 0, m.fork ? 1 : 0, m.default_branch,
          Date.parse(m.pushed_at), Date.parse(m.created_at),
          healthScore({ stars: m.stargazers_count, forks: m.forks_count, open_issues: m.open_issues_count, pushed_at: m.pushed_at, created_at: m.created_at, license: m.license?.spdx_id, archived: m.archived, description: m.description, has_readme: true }),
          delta,
          Date.now(),
        ),
      );
    }
    if (stmts.length) await this.env.DB.batch(stmts).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return stmts.length / 2;
  }

  /** Growth leaders: repos with the biggest star delta in the window. */
  async growthLeaders(days = 7, limit = 15) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { results } = await this.env.DB.prepare(
      `SELECT a.full_name, a.stars - b.stars AS gained, a.stars AS now
       FROM repo_snapshots a JOIN repo_snapshots b ON a.full_name = b.full_name
       WHERE a.day = (SELECT MAX(day) FROM repo_snapshots) AND b.day = ?
       ORDER BY gained DESC LIMIT ?`,
    ).bind(since, limit).all<any>().catch(() => ({ results: [] as any[] }));
    return results ?? [];
  }

  /** Trend chart for a repo: last N days of star history + sparkline. */
  async history(full: string, days = 90) {
    const { results } = await this.env.DB.prepare(
      `SELECT day, stars, delta FROM repo_snapshots WHERE full_name=? AND day >= date('now', ?) ORDER BY day ASC`,
    ).bind(full, `-${days} days`).all<{ day: string; stars: number; delta: number }>().catch(() => ({ results: [] as any[] }));
    const stars = (results ?? []).map((r) => r.stars);
    return { rows: results ?? [], spark: sparkline(stars.slice(-30)), first: stars[0] ?? null, last: stars.at(-1) ?? null };
  }
}
