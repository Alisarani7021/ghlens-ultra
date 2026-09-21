import type { Env } from "../env";
import { GithubRest } from "./rest";

/**
 * Security intelligence:
 *  • OSV.dev — real vulnerability lookup for any manifest (package-lock.json, requirements.txt, go.mod …)
 *  • GitHub advisories + secret-scanning style heuristics
 *  • dependency extraction from common manifest formats (no npm/pip needed, pure regex)
 */
export interface Vuln {
  id: string;
  summary: string;
  severity: "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";
  package: string;
  ecosystem: string;
  version?: string;
  fixed?: string;
  aliases?: string[];
  url?: string;
}

const EcoDetect: { file: RegExp; eco: string; parse: (s: string) => [string, string][] }[] = [
  {
    file: /package(-lock)?\.json$/,
    eco: "npm",
    parse: (s) => {
      try {
        const j = JSON.parse(s);
        const deps: [string, string][] = [];
        for (const [k, v] of Object.entries(j.dependencies ?? {})) deps.push([k, (v as any)?.version ?? "*"]);
        for (const [k, v] of Object.entries(j.packages ?? {})) {
          const name = k.replace(/^node_modules\//, "");
          if (name && !name.includes("node_modules/")) deps.push([name, (v as any)?.version ?? "*"]);
        }
        return deps;
      } catch { return []; }
    },
  },
  {
    file: /requirements.*\.txt$/,
    eco: "PyPI",
    parse: (s) => s.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
      .map((l) => { const m = l.match(/^([A-Za-z0-9_.\-\[\]]+)\s*(?:==|>=|~=|>|<)?\s*([\w.\-+]*)/); return m ? [m[1].replace(/\[.*\]/, ""), m[2] || "*"] as [string, string] : null; })
      .filter(Boolean) as [string, string][],
  },
  { file: /go\.mod$/, eco: "Go", parse: (s) => [...s.matchAll(/^\s*([\w.\-\/]+)\s+v?([\w.\-+]+)/gm)].map((m) => [m[1], m[2]] as [string, string]) },
  { file: /Cargo\.(toml|lock)$/, eco: "crates.io", parse: (s) => {
      const deps: [string, string][] = [];
      const re = /(?:^|\n)\s*(?:\[dependencies\]|\[packages\]|\[\[package\]\])/g;
      for (const m of s.matchAll(/^\s*name\s*=\s*"([^"]+)"\s*\n\s*version\s*=\s*"([^"]+)"/gm)) deps.push([m[1], m[2]]);
      for (const m of s.matchAll(/^\s*([A-Za-z0-9_\-]+)\s*=\s*"([^"]+)"/gm)) if (!re.test(m[1])) deps.push([m[1], m[2]]);
      return deps;
    } },
  { file: /pom\.xml$/, eco: "Maven", parse: (s) => [...s.matchAll(/<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>/g)].map((m) => [`${m[1]}`, m[2]] as [string, string]) },
  { file: /Gemfile\.lock$/, eco: "RubyGems", parse: (s) => [...s.matchAll(/^ {4}([\w\-]+) \(([\d.]+)\)/gm)].map((m) => [m[1], m[2]] as [string, string]) },
  { file: /composer\.(json|lock)$/, eco: "Packagist", parse: (s) => { try { const j = JSON.parse(s); return Object.entries(j.packages ?? j.require ?? {}).map(([k, v]) => [k, typeof v === "string" ? (v as string).replace(/[^\d.]/g, "") || "*" : (v as any)?.version ?? "*"] as [string, string]); } catch { return []; } } },
];

export class SecurityEngine {
  constructor(private env: Env, private gh: GithubRest) {}

  /** Collect manifest candidates from the repository root + common dirs. */
  async detectManifests(full: string) {
    const found: { path: string; eco: string }[] = [];
    const roots = ["", "backend", "frontend", "server", "app", "packages", "src", "client", "api", "web"];
    for (const dir of roots) {
      const listing = await this.gh.contents(full, dir, 3600).catch(() => null);
      if (!Array.isArray(listing)) continue;
      for (const f of listing) {
        if (f.type !== "file") continue;
        const hit = EcoDetect.find((d) => d.file.test(f.name));
        if (hit) found.push({ path: f.path, eco: hit.eco });
      }
      if (found.length >= 6) break;
    }
    return found;
  }

  parseManifest(path: string, content: string): { eco: string; deps: [string, string][] } {
    const d = EcoDetect.find((x) => x.file.test(path));
    if (!d) return { eco: "unknown", deps: [] };
    return { eco: d.eco, deps: d.parse(content).slice(0, 400) };
  }

  /** Query OSV for a batch of packages (max 1000 per request). */
  async osvBatch(ecosystem: string, pkgs: [string, string][]): Promise<Vuln[]> {
    if (!pkgs.length) return [];
    const key = `osv:${ecosystem}:${pkgs.map((p) => p.join("@")).join(",").slice(0, 150)}`;
    const cached = await this.env.CACHE.get<Vuln[]>(key, "json").catch(() => null);
    if (cached) return cached;

    const queries = pkgs.slice(0, 500).map(([name, version]) => ({
      package: { name, ecosystem },
      ...(version && version !== "*" && /^[\d.]+/.test(version) ? { version: version.replace(/^[\^~>=<]+/, "") } : {}),
    }));
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries }),
    }).catch(() => null);
    if (!res?.ok) return [];
    const data: any = await res.json();

    // hydrate detailed records (cap to 20 to stay inside subrequest budget)
    const ids: { pkg: string; id: string }[] = [];
    (data.results ?? []).forEach((r: any, i: number) => {
      for (const v of r.vulns ?? []) ids.push({ pkg: pkgs[i]?.[0] ?? "?", id: v.id });
    });
    const uniq = [...new Map(ids.map((x) => [x.id + x.pkg, x])).values()].slice(0, 20);
    const details = await Promise.all(
      uniq.map(async ({ pkg, id }) => {
        const v: any = await fetch(`https://api.osv.dev/v1/vulns/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!v) return null;
        const sev = mapSeverity(v);
        const fixed = v.affected?.[0]?.ranges?.[0]?.events?.find((e: any) => e.fixed)?.fixed;
        return {
          id,
          summary: v.summary ?? v.details?.slice(0, 140) ?? "—",
          severity: sev,
          package: pkg,
          ecosystem,
          fixed,
          aliases: v.aliases ?? [],
          url: `https://osv.dev/vulnerability/${id}`,
        } as Vuln;
      }),
    );
    const out = details.filter(Boolean) as Vuln[];
    await this.env.CACHE.put(key, JSON.stringify(out), { expirationTtl: 21600 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return out;
  }

  /** Full scan of a repo: manifests → OSV → ranked findings. */
  async scanRepo(full: string, opts: { maxManifests?: number } = {}) {
    const manifests = (await this.detectManifests(full)).slice(0, opts.maxManifests ?? 2);
    const all: Vuln[] = [];
    const summary: { path: string; eco: string; deps: number }[] = [];
    for (const m of manifests) {
      const raw = await this.gh.fileRaw(full, m.path).catch(() => null);
      if (!raw?.content) continue;
      const content = atob(raw.content.replace(/\n/g, "")).slice(0, 400_000);
      const { eco, deps } = this.parseManifest(m.path, content);
      summary.push({ path: m.path, eco, deps: deps.length });
      const vulns = await this.osvBatch(eco, deps);
      all.push(...vulns);
    }
    const order = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, UNKNOWN: 4 } as const;
    all.sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5));
    const counts = all.reduce((acc, v) => ((acc[v.severity] = (acc[v.severity] ?? 0) + 1), acc), {} as Record<string, number>);
    return { manifests: summary, vulns: all, counts };
  }

  /** Heuristic secret-scan of a few high-risk files (no external service needed). */
  async secretHeuristics(full: string) {
    const patterns: { name: string; re: RegExp }[] = [
      { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
      { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
      { name: "Slack Token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
      { name: "Google API Key", re: /AIza[0-9A-Za-z\-_]{35}/ },
      { name: "Private Key Block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
      { name: "Stripe Live Key", re: /sk_live_[0-9a-zA-Z]{24,}/ },
      { name: "Telegram Bot Token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
      { name: "Generic Password", re: /(pass(word|wd)?|secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
    ];
    const targets = [".env", ".env.example", "config.js", "config.json", "settings.py", "docker-compose.yml", ".npmrc"];
    const hits: { file: string; kind: string }[] = [];
    for (const t of targets) {
      const raw = await this.gh.fileRaw(full, t).catch(() => null);
      if (!raw?.content) continue;
      const content = atob(raw.content.replace(/\n/g, "")).slice(0, 200_000);
      for (const p of patterns) if (p.re.test(content)) hits.push({ file: t, kind: p.name });
    }
    return hits;
  }
}

function mapSeverity(v: any): Vuln["severity"] {
  const s = (v.severity ?? []).map((x: any) => x.score).find(Boolean);
  if (typeof s === "string" && s.startsWith("CVSS")) {
    const score = Number(s.split(":")[1]);
    if (score >= 9) return "CRITICAL";
    if (score >= 7) return "HIGH";
    if (score >= 4) return "MODERATE";
    return "LOW";
  }
  const db = v.database_specific?.severity ?? v.ecosystem_specific?.severity;
  if (typeof db === "string") {
    const u = db.toUpperCase();
    if (u.includes("CRIT")) return "CRITICAL";
    if (u.includes("HIGH")) return "HIGH";
    if (u.includes("MED")) return "MODERATE";
    if (u.includes("LOW")) return "LOW";
  }
  return "UNKNOWN";
}
