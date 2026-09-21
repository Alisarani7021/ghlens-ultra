import type { Env } from "../env";

/**
 * GraphQL client + the flagship "deep scout" query.
 * One single round-trip returns every tab of the repo dossier:
 * meta, languages, topics, releases, branches, PRs, issues, commits,
 * contributors, community profile, security advisories, workflows, funding.
 */
export class GithubGraphQL {
  private static mem = new Map<string, { until: number; data: any }>();

  constructor(private env: Env, private token = env.GITHUB_TOKEN) {}

  async query<T = any>(query: string, variables: Record<string, unknown> = {}, cacheKey?: string, ttl = 300): Promise<T> {
    const key = cacheKey ? `ghq:${cacheKey}` : null;
    if (key) {
      const mem = GithubGraphQL.mem.get(key);
      if (mem && mem.until > Date.now()) return mem.data as T;
      const kv = await this.env.CACHE.get<T>(key, "json").catch(() => null);
      if (kv) {
        GithubGraphQL.mem.set(key, { until: Date.now() + 30000, data: kv });
        return kv;
      }
    }
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "GitHubLensUltra/1.0",
      },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await res.json();
    if (json.errors?.length && !json.data) {
      throw new Error(`GraphQL: ${json.errors.map((e: any) => e.message).join("; ").slice(0, 300)}`);
    }
    const data = json.data as T;
    if (key) {
      GithubGraphQL.mem.set(key, { until: Date.now() + 60000, data });
      await this.env.CACHE.put(key, JSON.stringify(data), { expirationTtl: Math.max(ttl, 120) }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    return data;
  }

  /** ── The deep scout query (12 specialist tabs in one request) ───────────── */
  deepScout(owner: string, name: string) {
    return this.query<ScoutResult>(
      SCOUT_QUERY,
      { owner, name },
      `scout:${owner}/${name}`,
      600,
    );
  }

  /** Batch metadata for up to 100 repos in a single GraphQL call (cards/lists). */
  batchRepos(fulls: string[]) {
    const unique = [...new Set(fulls)].slice(0, 40);
    const parts = unique
      .map((f, i) => {
        const [o, n] = f.split("/");
        return `r${i}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { ...Card }`;
      })
      .join("\n");
    const q = `query { ${parts} }\n${CARD_FRAGMENT}`;
    return this.query<Record<string, any>>(q, {}, `batch:${unique.join("|").slice(0, 180)}`, 300);
  }

  viewer() {
    return this.query(`query { viewer { login name avatarUrl followers { totalCount } repositories(first:1){ totalCount } } }`, {}, "viewer", 3600);
  }
}

const CARD_FRAGMENT = `
fragment Card on Repository {
  nameWithOwner description homepageUrl url
  stargazerCount forkCount watcherCount
  isArchived isFork isTemplate
  diskUsage pushedAt createdAt updatedAt
  primaryLanguage { name color }
  licenseInfo { spdxId name }
  repositoryTopics(first: 12) { nodes { topic { name } } }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
  releases(first: 1) { totalCount nodes { tagName name publishedAt isPrerelease } }
  defaultBranchRef { name target { ... on Commit { committedDate history(first: 0) { totalCount } } } }
}`;

const SCOUT_QUERY = `
query Scout($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ...Card
    shortDescriptionHTML(limit: 240)
    descriptionHTML
    homepageUrl
    mirrorUrl
    openGraphImageUrl
    usesCustomOpenGraphImage
    isInOrganization
    hasIssuesEnabled
    hasDiscussionsEnabled
    hasWikiEnabled
    hasProjectsEnabled
    hasVulnerabilityAlertsEnabled
    securityPolicyUrl
    codeOfConduct { name url }
    fundingLinks { platform url }
    stargazers { totalCount }
    forkCount
    licenseInfo { spdxId name url }
    languages(first: 12, orderBy: {field: SIZE, direction: DESC}) {
      totalSize edges { size node { name color } }
    }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    defaultBranchRef {
      name
      target { ... on Commit { committedDate oid checkSuites(first: 1) { totalCount } } }
    }
    releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      nodes { name tagName isPrerelease isDraft publishedAt url description tagCommit { committedDate } releaseAssets(first: 6){ totalCount nodes { name size downloadCount } } }
    }
    tags: refs(refPrefix: "refs/tags/", first: 10, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      totalCount nodes { name target { ... on Commit { committedDate } } }
    }
    branches: refs(refPrefix: "refs/heads/", first: 20, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      totalCount nodes { name target { ... on Commit { committedDate author { name user { login avatarUrl } } } } }
    }
    pullRequests(first: 12, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { number title url isDraft createdAt updatedAt additions deletions changedFiles author { login avatarUrl } comments { totalCount } reviewDecision mergeable }
    }
    closedPRs: pullRequests(states: MERGED) { totalCount }
    allPRs: pullRequests { totalCount }
    issues(first: 12, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { number title url createdAt updatedAt comments { totalCount } author { login } labels(first: 5) { nodes { name color } } }
    }
    closedIssues: issues(states: CLOSED) { totalCount }
    goodFirstIssues: issues(states: OPEN, labels: ["good first issue"], first: 10) { totalCount nodes { number title url } }
    helpWanted: issues(states: OPEN, labels: ["help wanted"], first: 10) { totalCount nodes { number title url } }
    commitHistory: defaultBranchRef { target { ... on Commit { history(first: 25) { totalCount nodes { oid messageHeadline committedDate author { name user { login avatarUrl } } additions deletions url } } } } }
    contributors: mentionableUsers(first: 1) { totalCount }
    contributorList: defaultBranchRef { target { ... on Commit { history(first: 100) { nodes { author { name user { login avatarUrl } } } } } } }
    communityProfile: communityProfile {
      healthPercentage
      hasReadme hasLicense hasContributing hasCodeOfConduct hasIssueTemplate hasPullRequestTemplate hasDescription
      updatedAt
    }
    securityAdvisories: vulnerabilityAlerts(first: 10) {
      totalCount
      nodes { createdAt dismissedAt securityAdvisory { ghsaId severity summary publishedAt identifiers { type value } } vulnerableManifestPath }
    }
    workflows: object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name type } }
    }
    rootFiles: object(expression: "HEAD:") {
      ... on Tree { entries { name type } }
    }
    openGraphImageUrl
    watchers { totalCount }
  }
}
${CARD_FRAGMENT}
`;

export interface ScoutResult {
  repository: any;
}

export interface RepoMeta {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  watchers: number;
  issues: number;
  prs: number;
  language: string | null;
  languages: { name: string; color: string; bytes: number }[];
  topics: string[];
  license: string | null;
  archived: boolean;
  pushed_at: string | null;
  created_at: string | null;
  default_branch: string;
  size_kb: number;
  homepage: string | null;
  health: number;
  community_health: number;
  has_ci: boolean;
  releases: number;
  good_first: number;
  help_wanted: number;
  contributors: number;
  stars_per_day: number;
  redFlags: string[];
  raw: any;
}

/** Normalise a GraphQL scout payload into the flat RepoMeta used by the UI + DB. */
export function toRepoMeta(scout: any): RepoMeta {
  const r = scout?.repository ?? {};
  const langEdges = r.languages?.edges ?? [];
  const totalBytes = r.languages?.totalSize || langEdges.reduce((s: number, e: any) => s + (e.size ?? 0), 0) || 1;
  const created = r.createdAt ? new Date(r.createdAt).getTime() : Date.now();
  const days = Math.max(1, (Date.now() - created) / 86400000);
  const stars = r.stargazerCount ?? r.stargazers?.totalCount ?? 0;

  const redFlags: string[] = [];
  if (r.isArchived) redFlags.push("archived");
  if (!r.licenseInfo?.spdxId) redFlags.push("no-license");
  if (r.isFork) redFlags.push("fork");
  if (!r.hasVulnerabilityAlertsEnabled) redFlags.push("no-dependabot");
  const pushed = r.pushedAt ? new Date(r.pushedAt).getTime() : 0;
  if (pushed && Date.now() - pushed > 365 * 86400000) redFlags.push("stale");
  if (stars > 1000 && (r.communityProfile?.healthPercentage ?? 0) < 40) redFlags.push("low-community-health");

  const score = healthScore({
    stars,
    forks: r.forkCount ?? 0,
    open_issues: r.issues?.totalCount ?? 0,
    open_prs: r.pullRequests?.totalCount ?? 0,
    pushed_at: r.pushedAt,
    created_at: r.createdAt,
    license: r.licenseInfo?.spdxId,
    archived: r.isArchived,
    contributors: r.contributorList?.target?.history?.nodes
      ? new Set(r.contributorList.target.history.nodes.map((n: any) => n?.author?.user?.login ?? n?.author?.name)).size
      : 0,
    commits_last_year: Math.min(400, r.commitHistory?.target?.history?.totalCount ?? 0),
    releases_last_year: r.releases?.nodes?.filter((x: any) => x.publishedAt && Date.now() - new Date(x.publishedAt).getTime() < 365 * 86400000).length ?? 0,
    has_readme: !!r.communityProfile?.hasReadme,
    has_ci: (r.workflows?.entries?.length ?? 0) > 0,
    description: r.description,
  });

  const contribs = r.contributorList?.target?.history?.nodes
    ? new Set(r.contributorList.target.history.nodes.map((n: any) => n?.author?.user?.login ?? n?.author?.name)).size
    : 0;

  return {
    full_name: r.nameWithOwner ?? "",
    owner: (r.nameWithOwner ?? "/").split("/")[0] ?? "",
    name: r.name ?? "",
    description: r.description ?? null,
    stars,
    forks: r.forkCount ?? 0,
    watchers: r.watcherCount ?? r.watchers?.totalCount ?? 0,
    issues: r.issues?.totalCount ?? 0,
    prs: r.pullRequests?.totalCount ?? 0,
    language: r.primaryLanguage?.name ?? null,
    languages: langEdges.map((e: any) => ({ name: e.node?.name, color: e.node?.color, bytes: e.size ?? 0 })),
    topics: (r.repositoryTopics?.nodes ?? []).map((n: any) => n.topic?.name).filter(Boolean),
    license: r.licenseInfo?.spdxId ?? null,
    archived: !!r.isArchived,
    pushed_at: r.pushedAt ?? null,
    created_at: r.createdAt ?? null,
    default_branch: r.defaultBranchRef?.name ?? "main",
    size_kb: r.diskUsage ?? 0,
    homepage: r.homepageUrl ?? null,
    health: score,
    community_health: r.communityProfile?.healthPercentage ?? 0,
    has_ci: (r.workflows?.entries?.length ?? 0) > 0,
    releases: r.releases?.totalCount ?? 0,
    good_first: r.goodFirstIssues?.totalCount ?? 0,
    help_wanted: r.helpWanted?.totalCount ?? 0,
    contributors: contribs,
    stars_per_day: Math.round((stars / days) * 100) / 100,
    redFlags,
    raw: r,
  };
}

// local import to avoid circular deps at module top-level
import { healthScore } from "./rest";
