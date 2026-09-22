import type { Env } from "../env";
import { extractKeywords } from "../search/keywords";
import type { AiBrain } from "./brain";
import { hash } from "./brain";

/**
 * Vector intelligence layer.
 *  • index repositories as rich multi-field documents (desc + topics + langs + readme digest)
 *  • hybrid retrieval: semantic (Vectorize) + lexical (GitHub search) fused with RRF
 *  • RAG chat-with-repo: chunked README + docs → top-k → grounded answer with citations
 *  • incremental re-index (only when the repo changed — uses repos.indexed_at)
 */
export interface RepoDoc {
  id: string;                 // full_name
  text: string;               // embedded document
  metadata: {
    full_name: string; stars: number; language: string; topics: string;
    health: number; pushed_at: number; license: string; source: "repo" | "readme" | "issue";
  };
}

export class VectorIndex {
  constructor(private env: Env, private ai: AiBrain) {}

  async upsertRepos(docs: RepoDoc[], namespace?: string) {
    if (!docs.length) return 0;
    if (!this.env.INDEX) {
      // No Vectorize on this account: mark the rows so we don't retry forever.
      await this.env.DB.batch(
        docs.map((d) => this.env.DB.prepare(`UPDATE repos SET indexed_at=? WHERE full_name=?`).bind(Date.now(), d.metadata.full_name)),
      ).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      return 0;
    }
    const vectors = await this.ai.embed(docs.map((d) => d.text));
    const payload = docs.map((d, i) => ({
      id: d.id,
      values: vectors[i] ?? new Array(1024).fill(0),
      metadata: d.metadata as any,
      ...(namespace ? { namespace } : {}),
    }));
    for (let i = 0; i < payload.length; i += 100) {
      await this.env.INDEX.upsert(payload.slice(i, i + 100) as any);
    }
    await this.env.DB.batch(
      docs.map((d) => this.env.DB.prepare(`UPDATE repos SET indexed_at=? WHERE full_name=?`).bind(Date.now(), d.metadata.full_name)),
    ).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    return docs.length;
  }

  /** Semantic search with optional metadata filter (language/stars/recency). */
  async search(query: string, opts: { topK?: number; language?: string; minStars?: number; maxAgeDays?: number } = {}) {
    if (!this.env.INDEX) return [];   // lexical-only mode
    const qv = await this.ai.embedOne(query);
    const filter: Record<string, any> = {};
    if (opts.language) filter.language = { $eq: opts.language };
    if (opts.minStars) filter.stars = { $gte: opts.minStars };
    if (opts.maxAgeDays) filter.pushed_at = { $gte: Date.now() - opts.maxAgeDays * 86400000 };
    const res = await this.env.INDEX.query(qv, {
      topK: opts.topK ?? 12,
      returnMetadata: "all",
      ...(Object.keys(filter).length ? { filter } : {}),
    } as any);
    return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score, meta: m.metadata as any }));
  }

  /** RRF fusion of semantic + lexical result sets (the honest way to do hybrid search). */
  static fuse<T extends { id: string }>(a: T[], b: T[], k = 60): T[] {
    const scores = new Map<string, number>();
    const byId = new Map<string, T>();
    a.forEach((x, i) => { scores.set(x.id, (scores.get(x.id) ?? 0) + 1 / (k + i + 1)); byId.set(x.id, x); });
    b.forEach((x, i) => { scores.set(x.id, (scores.get(x.id) ?? 0) + 1 / (k + i + 1)); if (!byId.has(x.id)) byId.set(x.id, x); });
    return [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => byId.get(id)!).filter(Boolean);
  }

  /** Build the embedded document for a repo (deterministic → good cache hits). */
  static docFromMeta(meta: any, readmeDigest = ""): RepoDoc {
    const langs = (meta.languages ?? []).map((l: any) => l.name).join(", ");
    const text = [
      `repository: ${meta.full_name}`,
      `description: ${meta.description ?? ""}`,
      `language: ${meta.language ?? ""} (${langs})`,
      `topics: ${(meta.topics ?? []).join(", ")}`,
      `license: ${meta.license ?? "none"} stars: ${meta.stars} health: ${meta.health}`,
      readmeDigest ? `readme: ${readmeDigest}` : "",
    ].filter(Boolean).join("\n");
    return {
      id: meta.full_name,
      text,
      metadata: {
        full_name: meta.full_name,
        stars: meta.stars ?? 0,
        language: meta.language ?? "",
        topics: (meta.topics ?? []).slice(0, 12).join(","),
        health: meta.health ?? 0,
        pushed_at: meta.pushed_at ? Date.parse(meta.pushed_at) : 0,
        license: meta.license ?? "",
        source: "repo",
      },
    };
  }
}

/**
 * RAG — "chat with a repository".
 * The repo's README + docs are chunked, embedded on demand (cached in KV by content hash)
 * and fused with the user's question to produce a grounded answer.
 */
export class RepoRag {
  constructor(private env: Env, private ai: AiBrain) {}

  static chunk(text: string, size = 1200, overlap = 150): string[] {
    const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
    const chunks: string[] = [];
    let i = 0;
    while (i < clean.length) {
      let end = Math.min(clean.length, i + size);
      const para = clean.lastIndexOf("\n\n", end);
      if (para > i + size * 0.5) end = para;
      chunks.push(clean.slice(i, end));
      if (end >= clean.length) break;
      i = end - overlap;
    }
    return chunks.slice(0, 60);
  }

  /** Cosine similarity — good enough for ≤ a few hundred chunks in one Worker call. */
  private static cos(a: number[], b: number[]) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  /**
   * No-embedding retrieval: rank chunks by term overlap.
   *
   * Embeddings need Workers AI. When that is unavailable (spent neurons, no
   * gateway, embeddings not bound) the old code returned an empty answer and
   * the user saw "پیدا نشد" for a question the README answers verbatim. This
   * path always returns the most relevant passages.
   */
  static lexicalRank(chunks: string[], question: string, topK = 4): { text: string; score: number }[] {
    const terms = extractKeywords(question, 10);
    const raw = question
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2);
    const needles = [...new Set([...terms, ...raw])];
    const scored = chunks.map((text) => {
      const hay = text.toLowerCase();
      let score = 0;
      for (const t of needles) {
        if (!t) continue;
        const hits = hay.split(t).length - 1;
        if (hits) score += hits * (t.length > 4 ? 2 : 1);
      }
      // a heading match is a strong signal
      for (const line of text.split("\n").slice(0, 6)) {
        if (line.startsWith("#") && needles.some((t) => line.toLowerCase().includes(t))) score += 3;
      }
      return { text, score };
    });
    return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Headings a README almost always has, used when term matching finds nothing. */
  private static keySections(chunks: string[]): { text: string; score: number }[] {
    const WANT = ["install", "getting started", "quick start", "quickstart", "usage", "setup",
      "configuration", "options", "api", "example", "features", "requirement", "license", "faq"];
    const picked: { text: string; score: number }[] = [];
    const seen = new Set<string>();
    for (const want of WANT) {
      const hit = chunks.find((c) => {
        const head = c.split("\n").slice(0, 8).join(" ").toLowerCase();
        return head.includes(want) && !seen.has(c);
      });
      if (hit) { seen.add(hit); picked.push({ text: hit, score: 1 }); }
      if (picked.length >= 3) break;
    }
    // the first chunk always carries the project's own summary
    const first = chunks[0];
    if (first && !seen.has(first)) picked.unshift({ text: first, score: 2 });
    return picked.slice(0, 4);
  }

  /** Extractive answer: the passages that matched, quoted, with their headings. */
  async askExtractive(full: string, question: string, readmeText: string) {
    const chunks = RepoRag.chunk(readmeText).slice(0, 60);
    // terms first; if the README is English and the question Persian, the
    // keyword layer usually maps them, but a nil result must still be useful
    const hits = RepoRag.lexicalRank(chunks, question, 4).length
      ? RepoRag.lexicalRank(chunks, question, 4)
      : RepoRag.keySections(chunks);
    return {
      answer: hits.map((h, i) => `[[${i + 1}]] ${h.text.trim()}`).join("\n\n---\n\n"),
      sources: hits.map((h, i) => ({ n: i + 1, excerpt: h.text.slice(0, 160).replace(/\s+/g, " "), score: Math.round(h.score * 10) / 10 })),
    };
  }

  async ask(full: string, question: string, readmeText: string, locale = "fa") {
    const key = `rag:${full}:${hash(readmeText.slice(0, 6000))}`;
    let chunks: { text: string; vec: number[] }[] | null = (await this.env.CACHE.get<{ text: string; vec: number[] }[]>(key, "json").catch(() => null)) ?? null;
    if (!chunks) {
      const parts = RepoRag.chunk(readmeText).slice(0, 24);
      const vecs = await this.ai.embed(parts).catch(() => [] as number[][]);
      if (!vecs.length || !vecs[0]?.length) return { ...(await this.askExtractive(full, question, readmeText)), mode: "extractive" as const };
      chunks = parts.map((text, i) => ({ text, vec: vecs[i] ?? [] }));
      await this.env.CACHE.put(key, JSON.stringify(chunks), { expirationTtl: 604800 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    }
    const qv = await this.ai.embedOne(question).catch(() => [] as number[]);
    if (!qv.length) return { ...(await this.askExtractive(full, question, readmeText)), mode: "extractive" as const };
    const top = chunks
      .map((c) => ({ ...c, score: RepoRag.cos(qv, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const context = top.map((c, i) => `[[${i + 1}]] ${c.text}`).join("\n\n---\n\n");
    const answer = await this.ai.chat(
      `You are answering questions about the GitHub repository "${full}".\n` +
        `Use ONLY the context below. If the answer is not there, say so explicitly and suggest what to check.\n` +
        `Answer in ${locale === "fa" ? "Persian" : "English"}, use markdown-ish formatting, cite sources like [1], [2].\n\n` +
        `CONTEXT:\n${context.slice(0, 14000)}\n\nQUESTION: ${question}`,
      { tier: "smart", max_tokens: 1200, temperature: 0.25 },
    );
    // the model can still come back empty (spent neurons mid-request) — then the
    // passages themselves are the answer, not an apology
    if (!answer) return { ...(await this.askExtractive(full, question, readmeText)), mode: "extractive" as const };
    return { answer, sources: top.map((t, i) => ({ n: i + 1, excerpt: t.text.slice(0, 160).replace(/\s+/g, " "), score: Math.round(t.score * 100) / 100 })), mode: "ai" as const };
  }
}
