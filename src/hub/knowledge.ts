import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { hubId } from "./event";

/**
 *  KNOWLEDGE GRAPH + SEMANTIC SEARCH
 *
 *  The content graph (`content.ts`) answers "what came from what". This layer
 *  answers the two questions that one cannot:
 *
 *    1. **What is this about?** — entities extracted from every artefact, with
 *       the relations between them, so "everything we ever did about Bun" is a
 *       traversal rather than a keyword guess.
 *
 *    2. **Where did I see that thing?** — search that understands phrasing.
 *       «اون پست مربوط به آپدیت فلان پروژه که هفته پیش ساختیم» is not a
 *       substring of anything; it is a question about meaning, and it only
 *       works if the text was embedded when it was written.
 *
 *  Both live on the same substrate: every entity is a node, every mention is an
 *  edge, and embeddings are computed once at write time and never recomputed
 *  for a search.
 */

export type EntityKind = "repo" | "org" | "version" | "topic" | "file" | "language" | "person" | "url" | "term";

export interface Entity {
  id: string;
  owner_id: number | null;
  kind: EntityKind;
  /** canonical, lower-cased key — `oven-sh/bun`, not `Bun.js` */
  key: string;
  /** what a human calls it */
  label: string;
  mentions: number;
  first_seen: number;
  last_seen: number;
  meta?: Record<string, any>;
}

export interface Mention {
  content_id: string;
  entity_id: string;
  weight: number;
  created_at: number;
}

// ── extraction ─────────────────────────────────────────────────────────────

/**
 * Pull entities out of free text.
 *
 * Rule-based on purpose: an LLM could do this, but extraction runs on *every*
 * artefact including ones written when the AI quota is spent, and a rule that
 * costs nothing and can be unit-tested beats a model call that cannot be
 * audited. `aiEnrich()` below adds the entities rules cannot see.
 */
export function extractEntities(text: string, opts: { repo?: string; source?: string } = {}): Array<{ kind: EntityKind; key: string; label: string; weight: number }> {
  const out: Array<{ kind: EntityKind; key: string; label: string; weight: number }> = [];
  const seen = new Set<string>();
  const push = (kind: EntityKind, key: string, label: string, weight = 1) => {
    const k = `${kind}:${key.toLowerCase()}`;
    if (seen.has(k) || !key) return;
    seen.add(k);
    out.push({ kind, key: key.toLowerCase(), label, weight });
  };

  if (opts.repo) {
    push("repo", opts.repo, opts.repo, 3);
    const [owner] = opts.repo.split("/");
    if (owner) push("org", owner, owner, 2);
  }

  // URLs first, and then **removed from the text**.
  //
  // This is the order that matters: a naive `owner/repo` scan over
  // `https://github.com/oven-sh/bun/releases/tag/v1.2.0` matches
  // `github.com/oven-sh`, then `bun/releases`, then `releases/tag` — three
  // entities, none of them real. Handling URLs first and stripping them means
  // the repo is captured correctly and the graph stops filling with path
  // segments that look like repositories.
  let scrubbed = text;
  for (const m of text.matchAll(/https?:\/\/([^\s/>"'()\]]+)((?:\/[^\s"'()\]]*)?)/gi)) {
    const host = m[1].replace(/^www\./, "").toLowerCase();
    const path = m[2] ?? "";
    const gh = host === "github.com" ? path.match(/^\/([\w.-]+)\/([\w.-]+)/) : null;
    if (gh) {
      const full = `${gh[1]}/${gh[2]}`.replace(/\.git$/, "");
      push("repo", full, full, 3);
      push("org", gh[1], gh[1], 2);
    } else {
      push("url", host, host, 1);
    }
    scrubbed = scrubbed.replace(m[0], " ");
  }

  // owner/repo mentions in the remaining prose
  for (const m of scrubbed.matchAll(/\b([a-z0-9][\w.-]{0,38})\/([a-z0-9][\w.-]{0,38})\b/gi)) {
    const full = `${m[1]}/${m[2]}`;
    if (/^(https?|http|api|www|cdn|app|assets|github\.com)$/i.test(m[1])) continue;
    if (/\.(md|json|yml|yaml|js|ts|py|png|jpg|svg|css|html?)$/i.test(m[2])) continue;
    push("repo", full, full, 2);
    push("org", m[1], m[1], 1);
  }

  // versions: v1.2.3, 1.2.3, v2
  for (const m of scrubbed.matchAll(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/g)) push("version", m[0].toLowerCase(), m[0], 1);

  // languages / runtimes named in prose
  const LANGS = ["python", "javascript", "typescript", "rust", "go", "java", "kotlin", "swift", "ruby", "php", "c++", "c#", "elixir", "haskell", "zig", "dart", "scala", "lua", "sql", "bash", "shell", "html", "css", "wasm"];
  for (const lang of LANGS) {
    if (new RegExp(`\\b${lang.replace(/[+#]/g, "\\$&")}\\b`, "i").test(scrubbed)) push("language", lang, lang, 1);
  }

  // file paths — with their directories, so `src/app.ts` stays one entity
  for (const m of scrubbed.matchAll(/\b((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|json|ya?ml|toml|md|sql|sh|css|scss|vue|svelte))\b/gi)) {
    push("file", m[1].toLowerCase(), m[1], 1);
  }

  // versioned product names used as topics: "Bun", "Node.js", "Docker"
  for (const m of scrubbed.matchAll(/\b([A-Z][a-zA-Z0-9.]{2,20})\b/g)) {
    const w = m[1];
    if (/^(the|and|for|with|this|that|from|when|new|add|fix|update|چرا|این|برای)$/i.test(w)) continue;
    push("term", w.toLowerCase(), w, 1);
  }

  if (opts.source) push("topic", opts.source, opts.source, 1);
  return out.slice(0, 40);
}

/** Upsert entities and wire mentions. Cheap enough to run on every write. */
export async function indexEntities(
  env: Env,
  ownerId: number | null,
  contentId: string,
  text: string,
  opts: { repo?: string; source?: string } = {},
): Promise<number> {
  const found = extractEntities(text, opts);
  if (!found.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const e of found) {
    const id = `ent_${e.kind}_${(await shortHash(e.key))}`;
    await env.DB.prepare(
      `INSERT INTO hub_entities (id, owner_id, kind, key, label, mentions, first_seen, last_seen)
       VALUES (?,?,?,?,?,1,?,?)
       ON CONFLICT(id) DO UPDATE SET mentions = mentions + 1, last_seen = excluded.last_seen,
         label = excluded.label`,
    ).bind(id, ownerId, e.kind, e.key, e.label, now, now).run()
      .catch((err: any) => console.error("lens-swallowed", String(err?.message ?? err)));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO hub_mentions (content_id, entity_id, weight, created_at) VALUES (?,?,?,?)`,
    ).bind(contentId, id, e.weight, now).run()
      .catch((err: any) => console.error("lens-swallowed", String(err?.message ?? err)));
    n++;
  }
  return n;
}

async function shortHash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── traversal ──────────────────────────────────────────────────────────────

export async function entityByKey(env: Env, key: string, kind?: EntityKind): Promise<Entity | null> {
  const q = kind
    ? env.DB.prepare(`SELECT * FROM hub_entities WHERE key=? AND kind=? LIMIT 1`).bind(key.toLowerCase(), kind)
    : env.DB.prepare(`SELECT * FROM hub_entities WHERE key=? ORDER BY mentions DESC LIMIT 1`).bind(key.toLowerCase());
  const r = await q.first<any>().catch(() => null);
  return r ? { ...r, meta: safeJson(r.meta) } as Entity : null;
}

/** Everything the graph knows about a name — the "tell me about Bun" query. */
export async function about(env: Env, ownerId: number, key: string, limit = 8): Promise<{
  entity: Entity | null;
  content: Array<{ id: string; title: string | null; kind: string; state: string; weight: number }>;
  coOccurring: Array<{ key: string; label: string; kind: string; shared: number }>;
}> {
  const entity = await entityByKey(env, key);
  if (!entity) return { entity: null, content: [], coOccurring: [] };

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.kind, c.state, m.weight
       FROM hub_mentions m JOIN hub_content c ON c.id = m.content_id
      WHERE m.entity_id = ? AND (c.owner_id = ? OR c.owner_id IS NULL)
      ORDER BY c.updated_at DESC LIMIT ?`,
  ).bind(entity.id, ownerId, limit).all<any>().catch(() => ({ results: [] as any[] }));

  // Co-occurrence: entities that share content with this one, ranked by how
  // often. This is what turns a flat index into a graph worth traversing —
  // "Bun" shows up with "Zig", "Node.js", "bun build", and that is knowledge.
  const { results: co } = await env.DB.prepare(
    `SELECT e.key, e.label, e.kind, COUNT(*) AS shared
       FROM hub_mentions m1
       JOIN hub_mentions m2 ON m1.content_id = m2.content_id AND m2.entity_id != m1.entity_id
       JOIN hub_entities e ON e.id = m2.entity_id
      WHERE m1.entity_id = ?
      GROUP BY m2.entity_id ORDER BY shared DESC, e.mentions DESC LIMIT 10`,
  ).bind(entity.id).all<any>().catch(() => ({ results: [] as any[] }));

  return {
    entity,
    content: (results ?? []).map((r) => ({ id: r.id, title: r.title, kind: r.kind, state: r.state, weight: r.weight })),
    coOccurring: (co ?? []) as any[],
  };
}

export async function topEntities(env: Env, ownerId: number, limit = 12): Promise<Entity[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM hub_entities WHERE owner_id=? OR owner_id IS NULL ORDER BY mentions DESC, last_seen DESC LIMIT ?`,
  ).bind(ownerId, limit).all<any>().catch(() => ({ results: [] as any[] }));
  return (results ?? []).map((r) => ({ ...r, meta: safeJson(r.meta) })) as Entity[];
}

// ── semantic search ────────────────────────────────────────────────────────

/**
 * Embed and store a document.
 *
 * Embeddings are attempted once, at write time. When Workers AI is out of
 * quota or the Vectorize index is not bound, the row is still stored with
 * `embedding = NULL` — the lexical fallback keeps search working, and a later
 * pass can fill the gap. Losing the write because we could not embed would be
 * the worse trade.
 */
export async function embedDocument(
  env: Env,
  ai: AiBrain,
  doc: { id: string; owner_id?: number | null; text: string; title?: string; kind?: string; lang?: string; source_ref?: string },
): Promise<boolean> {
  const body = `${doc.title ?? ""}\n${doc.text ?? ""}`.trim().slice(0, 4000);
  if (!body) return false;
  let vector: number[] | null = null;
  try {
    vector = await embedText(env, ai, body);
  } catch (e: any) {
    console.error("hub-embed", String(e?.message ?? e));
  }

  // Bind values are listed in the *same order as the columns*, and the column
  // list is spelled out rather than spread from an array.
  //
  // An earlier version built a `base` array ending in the timestamp and then
  // appended the vector — so `created_at` landed in `embedding` and the vector
  // landed in `dim`. The INSERT still succeeded, which is exactly why this is
  // worth writing down: a wrong bind order is silent, and it took a semantic
  // search returning nothing to surface it.
  const res = await env.DB.prepare(
    `INSERT INTO hub_docs (id, owner_id, kind, title, body, lang, source_ref, embedding, dim, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body,
       embedding=excluded.embedding, dim=excluded.dim, source_ref=excluded.source_ref`,
  ).bind(
    doc.id,                                       // id
    doc.owner_id ?? null,                         // owner_id
    doc.kind ?? "post",                           // kind
    doc.title ?? null,                            // title
    body.slice(0, 2000),                          // body
    doc.lang ?? "fa",                             // lang
    doc.source_ref ?? null,                       // source_ref
    vector ? JSON.stringify(vector) : null,       // embedding
    vector ? vector.length : null,                // dim
    Date.now(),                                   // created_at
  ).run().catch((e: any) => {
    console.error("hub-doc-insert", String(e?.message ?? e));
    return null;
  });
  return !!res && !!vector;
}

/**
 * Embeddings via Workers AI, then the compat gateway as a fallback.
 *
 * Note what this does *not* require: a Vectorize index. Vectorize is a vector
 * *store*, and this build keeps its vectors in D1 as JSON and computes cosine
 * in the worker — which on an account without Vectorize means semantic search
 * works instead of silently degrading to lexical. The index binding is only a
 * hint that we may as well skip the round trip when it exists.
 */
export async function embedText(env: Env, ai: AiBrain, text: string): Promise<number[] | null> {
  const input = text.slice(0, 2000);
  // bge-m3 first (multilingual — matters here, the corpus is Persian);
  // bge-base is the long-standing fallback that older accounts still have.
  for (const model of ["@cf/baai/bge-m3", "@cf/baai/bge-base-en-v1.5"] as const) {
    try {
      const r: any = await env.AI.run(model as any, { text: [input] } as any);
      const v = r?.data?.[0] ?? r?.result?.data?.[0] ?? (Array.isArray(r) ? r[0] : null);
      if (Array.isArray(v) && v.length) return v as number[];
    } catch (e: any) {
      // A model that does not exist on this account is expected, not a fault.
      console.log("hub-embed-model", model, String(e?.message ?? e).slice(0, 120));
    }
  }
  if (env.OPENAI_COMPAT_BASE_URL && env.OPENAI_COMPAT_KEY) {
    const res = await fetch(`${env.OPENAI_COMPAT_BASE_URL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_COMPAT_KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input }),
    }).catch(() => null);
    const j: any = res ? await res.json().catch(() => null) : null;
    const v = j?.data?.[0]?.embedding;
    if (Array.isArray(v) && v.length) return v as number[];
  }
  void ai;
  return null;
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SearchHit {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  lang: string;
  source_ref: string | null;
  score: number;
  /** how the hit was found — so a lexical match is never mistaken for a semantic one */
  via: "semantic" | "lexical" | "entity";
  created_at: number;
}

/**
 * Search across everything the hub has produced.
 *
 * Three strategies, best available first, and the response always says which
 * one answered. That honesty matters: an owner told "semantic" will trust a
 * weird-looking result, and an owner told "lexical" will rephrase. Blurring the
 * two is how search stops being trustworthy.
 *
 *  1. **entity** — the query names something we extracted (`oven-sh/bun`), so
 *     the graph answers directly and co-occurrence fills the rest
 *  2. **semantic** — embed the query, cosine against stored vectors
 *  3. **lexical** — token overlap, which is also the safety net when the AI
 *     quota is spent or Vectorize is not bound
 */
export async function search(
  env: Env,
  ai: AiBrain,
  ownerId: number,
  query: string,
  opts: { limit?: number; kind?: string } = {},
): Promise<{ hits: SearchHit[]; via: SearchHit["via"]; entity?: Entity | null }> {
  const limit = Math.min(opts.limit ?? 8, 25);
  const q = query.trim();
  if (!q) return { hits: [], via: "lexical" };

  // 1. entity path
  const nameMatch = q.match(/\b([a-z0-9][\w.-]{0,38}\/[a-z0-9][\w.-]{0,38})\b/i) ?? q.match(/\b([A-Za-z][\w.-]{2,20})\b/);
  if (nameMatch) {
    const ent = await entityByKey(env, nameMatch[1]);
    if (ent && ent.key.length > 2) {
      const a = await about(env, ownerId, ent.key, limit);
      if (a.content.length) {
        // Spread bind, but provably safe: the placeholder list and the value
        // list are generated from the same array in the same expression.
        const rows = await env.DB.prepare(
          `SELECT id, title, body, kind, lang, source_ref, created_at FROM hub_docs WHERE id IN (${a.content.map(() => "?").join(",")})`,
        ).bind(...a.content.map((c) => c.id)).all<any>().catch(() => ({ results: [] as any[] }));
        const hits: SearchHit[] = (rows.results ?? []).map((r: any, i: number) => ({
          id: r.id, title: r.title, body: r.body, kind: r.kind, lang: r.lang,
          source_ref: r.source_ref, score: 1 - i * 0.05, via: "entity" as const, created_at: r.created_at,
        }));
        if (hits.length) return { hits, via: "entity", entity: ent };
      }
    }
  }

  // 2. semantic path
  let vec: number[] | null = null;
  try { vec = await embedText(env, ai, q); } catch { /* fall through */ }
  if (vec) {
    const { results } = await env.DB.prepare(
      `SELECT id, title, body, kind, lang, source_ref, embedding, dim, created_at FROM hub_docs
        WHERE owner_id = ? AND embedding IS NOT NULL ${opts.kind ? "AND kind = ?" : ""}
        ORDER BY created_at DESC LIMIT 400`,
    ).bind(...(opts.kind ? [ownerId, opts.kind] : [ownerId])).all<any>().catch(() => ({ results: [] as any[] }));
    const scored: SearchHit[] = [];
    for (const r of results ?? []) {
      let stored: number[] | null = null;
      try { stored = JSON.parse(r.embedding); } catch { continue; }
      if (!stored) continue;
      const score = cosine(vec, stored);
      if (score > 0.25) {
        scored.push({
          id: r.id, title: r.title, body: r.body, kind: r.kind, lang: r.lang,
          source_ref: r.source_ref, score, via: "semantic", created_at: r.created_at,
        });
      }
    }
    if (scored.length) {
      scored.sort((a, b) => b.score - a.score);
      return { hits: scored.slice(0, limit), via: "semantic" };
    }
  }

  // 3. lexical fallback
  const { results } = await env.DB.prepare(
    `SELECT id, title, body, kind, lang, source_ref, created_at FROM hub_docs
      WHERE owner_id = ? ${opts.kind ? "AND kind = ?" : ""}
      ORDER BY created_at DESC LIMIT 400`,
  ).bind(...(opts.kind ? [ownerId, opts.kind] : [ownerId])).all<any>().catch(() => ({ results: [] as any[] }));
  const terms = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const hits: SearchHit[] = [];
  for (const r of results ?? []) {
    const hay = `${r.title ?? ""} ${r.body ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1 / terms.length;
    if (score > 0) hits.push({ ...r, body: r.body ?? "", score, via: "lexical", created_at: r.created_at });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), via: "lexical" };
}

function safeJson(s: any): any {
  if (typeof s !== "string") return s ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

/** Ids for the tables this layer owns — one place, so nothing drifts. */
export const knowledgeIds = { entity: (kind: string, hash: string) => `ent_${kind}_${hash}`, doc: () => hubId("doc") };
