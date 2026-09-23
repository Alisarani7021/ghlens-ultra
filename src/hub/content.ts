import type { Env } from "../env";
import { digest, hubId } from "./event";

/**
 *  CONTENT GRAPH + CONTENT DNA
 *
 *  A post is not a string that gets sent. It is a node with parents, children
 *  and a genetic make-up — and everything that produced it is recorded:
 *
 *      SOURCE (github.release)
 *         │ derived_from
 *         ▼
 *       POST ──derived_from──▶ IMAGE PROMPT
 *         │ translated
 *         ▼
 *       POST(ru) / POST(zh)
 *
 *  Two payoffs nobody gets for free:
 *
 *   1. **Staleness propagates.** When the upstream source changes, every
 *      descendant is marked `stale` in one hop — so a post built on a release
 *      that was later yanked does not sit there looking true.
 *
 *   2. **Performance attaches to DNA.** Views and forwards land back on the
 *      originating source, so after a month the platform can answer "which
 *      topics actually landed?" from its own history instead of vibes.
 */

export type ContentKind = "source" | "post" | "summary" | "prompt" | "thread" | "translate";
export type ContentState = "draft" | "review" | "approved" | "published" | "stale" | "blocked";
export type EdgeRel = "derived_from" | "translated" | "variant" | "extracted";

export interface ContentDNA {
  topic?: string;
  lang?: string;
  tone?: string;
  /** rough length in characters, kept for the "did it land?" analysis */
  length?: number;
  source?: string;
  entities?: string[];
  keywords?: string[];
  media?: string[];
  audience?: string;
  format?: string;
  confidence?: number;
  created_by?: string;
  models?: string[];
  performance?: { views?: number; forwards?: number; at?: number };
  /** anything the caller wants to remember about how this was made */
  extra?: Record<string, any>;
}

export interface ContentRow {
  id: string;
  owner_id?: number | null;
  kind: ContentKind;
  title?: string | null;
  body?: string | null;
  lang: string;
  source_ref?: string | null;
  dna: ContentDNA;
  state: ContentState;
  confidence: number;
  version: number;
  channel?: string | null;
  msg_id?: number | null;
  created_at: number;
  updated_at: number;
}

export async function createContent(
  env: Env,
  c: {
    owner_id?: number;
    kind: ContentKind;
    title?: string;
    body?: string;
    lang?: string;
    source_ref?: string;
    dna?: ContentDNA;
    state?: ContentState;
    confidence?: number;
  },
): Promise<string> {
  const id = hubId("cnt");
  const now = Date.now();
  const dna: ContentDNA = { ...c.dna, length: (c.body ?? "").length, confidence: c.confidence ?? c.dna?.confidence ?? 0 };
  await env.DB.prepare(
    `INSERT INTO hub_content (id, owner_id, kind, title, body, lang, source_ref, dna, state, confidence, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  )
    .bind(
      id, c.owner_id ?? null, c.kind, c.title ?? null, c.body ?? null,
      c.lang ?? "fa", c.source_ref ?? null, JSON.stringify(dna),
      c.state ?? "draft", c.confidence ?? 0, now, now,
    )
    .run()
    .catch((e: any) => console.error("hub-content-insert", String(e?.message ?? e)));
  return id;
}

export async function link(env: Env, child: string, parent: string, rel: EdgeRel) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO hub_edges (from_id, to_id, rel, created_at) VALUES (?,?,?,?)`,
  )
    .bind(child, parent, rel, Date.now())
    .run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export function rowToContent(r: any): ContentRow {
  let dna: ContentDNA = {};
  try { dna = JSON.parse(r.dna ?? "{}"); } catch { /* keep {} */ }
  return {
    id: r.id, owner_id: r.owner_id, kind: r.kind, title: r.title, body: r.body,
    lang: r.lang, source_ref: r.source_ref, dna, state: r.state,
    confidence: r.confidence ?? 0, version: r.version ?? 1,
    channel: r.channel, msg_id: r.msg_id, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function getContent(env: Env, id: string): Promise<ContentRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM hub_content WHERE id=?`).bind(id).first<any>().catch(() => null);
  return r ? rowToContent(r) : null;
}

/**
 * Find already-written content for the same source — the cheap half of
 * deduplication. Exact, not semantic: if we have literally covered
 * `owner/repo@v2.5.5`, we do not cover it twice.
 */
export async function findBySource(env: Env, ownerId: number, sourceRef: string): Promise<ContentRow | null> {
  const r = await env.DB.prepare(
    `SELECT * FROM hub_content WHERE owner_id=? AND source_ref=? AND state != 'blocked' ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(ownerId, sourceRef)
    .first<any>()
    .catch(() => null);
  return r ? rowToContent(r) : null;
}

/**
 * Near-duplicate detection for text that has no stable source id (an article,
 * a pasted changelog). Shingles the text into overlapping 3-word tokens and
 * compares the sets — Jaccard, not cosine, because we want it explainable:
 * "similarity 0.82, 9 of 11 shingles shared".
 */
export function similarity(a: string, b: string): number {
  const shingles = (s: string): Set<string> => {
    const words = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    const set = new Set<string>();
    for (let i = 0; i + 2 < words.length; i++) set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    if (!set.size) set.add(words.join(" "));
    return set;
  };
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const s of A) if (B.has(s)) shared++;
  return shared / (A.size + B.size - shared);
}

export async function fingerprint(text: string): Promise<string> {
  return (await digest(text.trim().toLowerCase().replace(/\s+/g, " "))).slice(0, 24);
}

/** Which content rows are near-identical to this text, newest first. */
export async function findSimilar(env: Env, ownerId: number, text: string, threshold = 0.6): Promise<Array<ContentRow & { score: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM hub_content WHERE owner_id=? AND kind IN ('post','summary') AND state!='blocked' ORDER BY updated_at DESC LIMIT 40`,
  )
    .bind(ownerId)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  const out: Array<ContentRow & { score: number }> = [];
  for (const r of results ?? []) {
    const row = rowToContent(r);
    const score = similarity(text, `${row.title ?? ""} ${row.body ?? ""}`);
    if (score >= threshold) out.push({ ...row, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── graph traversal ────────────────────────────────────────────────────────

export async function childrenOf(env: Env, id: string): Promise<Array<{ id: string; rel: EdgeRel }>> {
  const { results } = await env.DB.prepare(`SELECT from_id, rel FROM hub_edges WHERE to_id=?`).bind(id).all<any>().catch(() => ({ results: [] as any[] }));
  return (results ?? []).map((r) => ({ id: r.from_id, rel: r.rel as EdgeRel }));
}

export async function parentsOf(env: Env, id: string): Promise<Array<{ id: string; rel: EdgeRel }>> {
  const { results } = await env.DB.prepare(`SELECT to_id, rel FROM hub_edges WHERE from_id=?`).bind(id).all<any>().catch(() => ({ results: [] as any[] }));
  return (results ?? []).map((r) => ({ id: r.to_id, rel: r.rel as EdgeRel }));
}

/**
 * Everything downstream of a node, breadth-first, with depth.
 *
 * `SELECT ... WHERE to_id IN (…)` would be one query, but D1 binds are
 * positional and the frontier changes size every hop — a loop of small queries
 * is both clearer and never hits a variable limit.
 */
export async function descendants(env: Env, root: string, maxDepth = 4): Promise<Array<{ id: string; rel: EdgeRel; depth: number }>> {
  const seen = new Set<string>([root]);
  let frontier = [{ id: root, depth: 0 }];
  const out: Array<{ id: string; rel: EdgeRel; depth: number }> = [];
  while (frontier.length && frontier[0].depth < maxDepth) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const node of frontier) {
      for (const child of await childrenOf(env, node.id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push({ id: child.id, rel: child.rel, depth: node.depth + 1 });
        next.push({ id: child.id, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The source changed → everything built from it is now suspect.
 *
 * This is the single most valuable thing the graph buys: a release gets
 * amended, a feed item gets corrected, and instead of silently leaving stale
 * posts in a channel we mark the whole subtree and tell the owner.
 */
export async function markStale(env: Env, root: string): Promise<{ count: number; ids: string[] }> {
  const kids = await descendants(env, root);
  const ids = kids.map((k) => k.id).filter(Boolean);
  if (!ids.length) return { count: 0, ids: [] };
  // One statement per id keeps this safe against D1's bind limits and lets a
  // partial failure still make progress.
  for (const id of ids) {
    await env.DB.prepare(`UPDATE hub_content SET state='stale', updated_at=? WHERE id=? AND state IN ('draft','review','approved','published')`)
      .bind(Date.now(), id)
      .run()
      .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
  return { count: ids.length, ids };
}

export async function setState(env: Env, id: string, state: ContentState) {
  await env.DB.prepare(`UPDATE hub_content SET state=?, updated_at=? WHERE id=?`)
    .bind(state, Date.now(), id)
    .run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export async function markPublished(env: Env, id: string, channel: string, msgId: number) {
  await env.DB.prepare(`UPDATE hub_content SET state='published', channel=?, msg_id=?, updated_at=? WHERE id=?`)
    .bind(channel, msgId, Date.now(), id)
    .run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export async function attachPerformance(env: Env, id: string, views: number, forwards: number) {
  const row = await getContent(env, id);
  if (!row) return;
  const dna = { ...row.dna, performance: { views, forwards, at: Date.now() } };
  await env.DB.prepare(`UPDATE hub_content SET dna=?, updated_at=? WHERE id=?`)
    .bind(JSON.stringify(dna), Date.now(), id)
    .run()
    .catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
}

export async function queueForReview(env: Env, ownerId: number, limit = 8): Promise<ContentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM hub_content WHERE owner_id=? AND state IN ('draft','review','stale') ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(ownerId, limit)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  return (results ?? []).map(rowToContent);
}

export async function recentContent(env: Env, ownerId: number, limit = 12): Promise<ContentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM hub_content WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(ownerId, limit)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  return (results ?? []).map(rowToContent);
}

/** DNA → a one-line label used in the graph view and in the audit trail. */
export function dnaLine(dna: ContentDNA): string {
  const bits = [
    dna.topic ? `#${dna.topic}` : "",
    dna.lang ? `🌐 ${dna.lang}` : "",
    dna.models?.length ? `🤖 ${dna.models.join("+")}` : "",
    typeof dna.confidence === "number" ? `📊 ${(dna.confidence * 100).toFixed(0)}%` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}
