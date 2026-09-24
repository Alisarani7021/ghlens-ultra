import type { Env } from "../env";

/**
 * Cached GitHub REST client.
 *  • ETag conditional requests → free 304s (huge quota saver on free tokens)
 *  • KV read-through cache with per-endpoint TTL
 *  • token rotation + GraphQL/REST fallback handled by callers
 *  • automatic pagination helper
 */
export class GithubRest {
  private static mem = new Map<string, { until: number; data: any }>();

  constructor(private env: Env, private token = env.GITHUB_TOKEN) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "GitHubLensUltra/1.0 (+cloudflare-workers)",
      "x-github-api-version": "2022-11-28",
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Uncached raw request with ETag-aware KV caching. */
  async get<T = any>(path: string, ttl = 300, init: RequestInit = {}): Promise<T> {
    const key = `gh:${path}`;
    const now = Date.now();
    const mem = GithubRest.mem.get(key);
    if (mem && mem.until > now) return mem.data as T;

    const cached = ttl > 0 ? await this.env.CACHE.get<{ etag: string; body: string }>(key, "json").catch(() => null) : null;

    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(cached?.etag ? { "if-none-match": cached.etag } : {}), ...(init.headers as any) },
    });

    if (res.status === 304 && cached) {
      const data = JSON.parse(cached.body);
      GithubRest.mem.set(key, { until: now + Math.min(ttl, 60) * 1000, data });
      return data as T;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new GithubError(res.status, body.slice(0, 400), path);
    }
    const data = await res.json();
    const etag = res.headers.get("etag");
    if (ttl > 0 && etag) {
      await this.env.CACHE.put(key, JSON.stringify({ etag, body: JSON.stringify(data) }), { expirationTtl: Math.max(ttl, 60) }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    GithubRest.mem.set(key, { until: now + Math.min(ttl, 60) * 1000, data });
    return data as T;
  }

  /**
   * Why did a repository read fail — a human sentence, not a status code.
   *
   * Used by the screens that would otherwise say «پیدا نشد» for four different
   * problems (renamed, private, network, quota). It probes the two things that
   * actually answer the question: whether GitHub serves the repo at all, and how
   * much quota is left on `this.token` (anonymous: 60/h shared by the deployment).
   */
  async rateWhy(full: string): Promise<string | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${full}`, { headers: this.headers() });
      if (res.ok) return null;
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      const mins = reset ? Math.max(0, Math.round((Number(reset) * 1000 - Date.now()) / 60000)) : null;
      const body = (await res.json().catch(() => null)) as any;
      if (res.status === 403 || remaining === "0") {
        return `GitHub quota ${this.token ? "" : "(anonymous, shared) "}exhausted${
          mins !== null ? ` — resets in ~${mins} min` : ""} · HTTP ${res.status}`;
      }
      if (res.status === 404) return body?.message ? `GitHub 404 — ${body.message}` : "GitHub 404";
      return `GitHub HTTP ${res.status}${body?.message ? ` — ${body.message}` : ""}`;
    } catch (e: any) {
      return `network: ${String(e?.message ?? e).slice(0, 120)}`;
    }
  }

  async post<T = any>(path: string, body: unknown) {
    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    const res = await fetch(url, { method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new GithubError(res.status, (await res.text()).slice(0, 400), path);
    return (await res.json()) as T;
  }

  repo(full: string, ttl = 300) {
    return this.get(`/repos/${full}`, ttl);
  }
  readme(full: string, ttl = 3600) {
    return this.get<{ content: string; encoding: string; name: string; path: string; html_url: string }>(`/repos/${full}/readme`, ttl);
  }
  languages(full: string, ttl = 86400) {
    return this.get<Record<string, number>>(`/repos/${full}/languages`, ttl);
  }
  releases(full: string, per_page = 10) {
    return this.get<any[]>(`/repos/${full}/releases?per_page=${per_page}`, 900);
  }
  branches(full: string, per_page = 30) {
    return this.get<any[]>(`/repos/${full}/branches?per_page=${per_page}`, 900);
  }
  commits(full: string, per_page = 20, sha?: string) {
    return this.get<any[]>(`/repos/${full}/commits?per_page=${per_page}${sha ? `&sha=${sha}` : ""}`, 300);
  }
  contributors(full: string, per_page = 30) {
    return this.get<any[]>(`/repos/${full}/contributors?per_page=${per_page}`, 3600);
  }
  issues(full: string, state: "open" | "closed" | "all" = "open", per_page = 20) {
    return this.get<any[]>(`/repos/${full}/issues?state=${state}&per_page=${per_page}&sort=updated`, 300);
  }
  pulls(full: string, state: "open" | "closed" | "all" = "open", per_page = 20) {
    return this.get<any[]>(`/repos/${full}/pulls?state=${state}&per_page=${per_page}&sort=updated`, 300);
  }
  topics(full: string) {
    return this.get<{ names: string[] }>(`/repos/${full}/topics`, 3600);
  }
  community(full: string) {
    return this.get(`/repos/${full}/community/profile`, 86400);
  }
  license(full: string) {
    return this.get(`/repos/${full}/license`, 86400);
  }
  contents(full: string, path = "", ttl = 1800) {
    return this.get<any[] | any>(`/repos/${full}/contents/${path}`, ttl);
  }
  fileRaw(full: string, path: string, ref = "HEAD") {
    return this.get<{ content: string; encoding: string }>(`/repos/${full}/contents/${path}?ref=${ref}`, 3600);
  }
  tags(full: string, per_page = 20) {
    return this.get<any[]>(`/repos/${full}/tags?per_page=${per_page}`, 900);
  }
  stargazers(full: string) {
    return this.get<any[]>(`/repos/${full}/stargazers?per_page=100`, 600);
  }
  codeFrequency(full: string) {
    return this.get<number[][]>(`/repos/${full}/stats/code_frequency`, 86400);
  }
  commitActivity(full: string) {
    return this.get<{ week: number; total: number; days: number[] }[]>(`/repos/${full}/stats/commit_activity`, 86400);
  }
  participation(full: string) {
    return this.get<{ all: number[] }>(`/repos/${full}/stats/participation`, 86400);
  }
  workflows(full: string) {
    return this.get<{ workflows: any[] }>(`/repos/${full}/actions/workflows`, 1800);
  }
  securityAdvisories(full: string) {
    return this.get<any[]>(`/repos/${full}/security-advisories`, 3600).catch(() => []);
  }
  dependents(full: string) {
    return this.get(`/repos/${full}/dependency-graph/compare/HEAD...HEAD`, 3600).catch(() => null);
  }
  /** SBOM from GitHub (SPDX) — full transitive dependency list. */
  sbom(full: string) {
    return this.get<{ sbom: { packages?: any[] } }>(`/repos/${full}/dependency-graph/sbom`, 3600).catch(() => null);
  }
  /** Search API wrappers */
  searchRepos(q: string, sort: "stars" | "forks" | "updated" | "help-wanted-issues" = "stars", order: "desc" | "asc" = "desc", per_page = 20, page = 1) {
    return this.get<{ total_count: number; items: any[] }>(
      `/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&per_page=${per_page}&page=${page}`,
      600,
    );
  }
  searchCode(q: string, per_page = 10) {
    return this.get<{ total_count: number; items: any[] }>(`/search/code?q=${encodeURIComponent(q)}&per_page=${per_page}`, 600);
  }
  searchIssues(q: string, sort: "created" | "updated" | "comments" = "updated", per_page = 20) {
    return this.get<{ total_count: number; items: any[] }>(`/search/issues?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${per_page}`, 600);
  }
  searchUsers(q: string, per_page = 10) {
    return this.get<{ total_count: number; items: any[] }>(`/search/users?q=${encodeURIComponent(q)}&per_page=${per_page}`, 900);
  }

  /** Follow Link headers across pages (cap configurable). */
  async paginate<T = any>(path: string, maxPages = 3, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.get<T[]>(`${path}${sep}per_page=${perPage}&page=${p}`, 600).catch(() => []);
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < perPage) break;
    }
    return out;
  }

  /** Rate-limit snapshot (shown in /admin and used for smart throttling). */
  async rateLimit() {
    return this.get<{ resources: Record<string, { limit: number; remaining: number; reset: number }> }>("/rate_limit", 30);
  }
}

export class GithubError extends Error {
  constructor(public status: number, public body: string, public path: string) {
    super(`GitHub ${status} on ${path}: ${body}`);
  }
}

/** Repository health score (0-100) — a Lens-original composite metric. */
export function healthScore(r: {
  stars?: number; forks?: number; open_issues?: number;
  pushed_at?: string | number; created_at?: string | number;
  license?: string | null; archived?: boolean;
  contributors?: number; commits_last_year?: number; releases_last_year?: number;
  has_readme?: boolean; has_ci?: boolean; description?: string | null;
  open_prs?: number;
}) {
  const now = Date.now();
  const push = r.pushed_at ? new Date(r.pushed_at).getTime() : 0;
  const daysSincePush = push ? (now - push) / 86400000 : 9999;
  const freshness = Math.max(0, 30 - Math.min(30, daysSincePush / 10));            // 0-30
  const community = Math.min(20, Math.log10((r.stars ?? 0) + 1) * 5 + (r.contributors ?? 0) / 25); // 0-20
  const maintenance = Math.min(20, ((r.commits_last_year ?? 0) / 100) * 8 + ((r.releases_last_year ?? 0) / 6) * 8); // 0-20
  const hygiene =
    (r.license ? 6 : 0) + (r.description ? 3 : 0) + (r.has_readme ? 4 : 0) + (r.has_ci ? 4 : 0);   // 0-17
  const issueRatio = r.open_issues && r.stars ? Math.min(1, r.open_issues / Math.max(20, r.stars)) : 0.2;
  const responsiveness = (1 - issueRatio) * 8;                                    // 0-8
  let score = freshness + community + maintenance + hygiene + responsiveness;
  if (r.archived) score = Math.min(score, 25);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Simple sparkline using block characters (works in every Telegram client). */
export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const blocks = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return values.map((v) => blocks[Math.round(((v - min) / span) * (blocks.length - 1))]).join("");
}

/** Horizontal bar chart, e.g. language distribution. */
export function bar(pct: number, width = 12, full = "█", empty = "░") {
  const f = Math.round((pct / 100) * width);
  return full.repeat(Math.max(0, f)) + empty.repeat(Math.max(0, width - f));
}
