import type { AiBrain, Tier } from "../ai/brain";

/**
 *  AI MESH
 *
 *      request → Task Analyzer → which models suit this? → parallel → Critic → Synthesis
 *
 *  The point is not "use more models". It is that different models fail in
 *  *different places*, so asking two of them and letting a third adjudicate
 *  produces something none of them would have produced alone — and, crucially,
 *  the disagreement itself is information: it marks the part of the answer
 *  that was actually hard.
 *
 *  Cost control is explicit. Breadth is a parameter, not a default: a routine
 *  translation runs one model, a mission the owner explicitly launched can run
 *  three. The Critic is always the cheapest tier that can compare two texts.
 */

/** What a model is good at. Kept next to the mesh so routing is data, not `if`s. */
export interface ModelCapability {
  tier: Tier;
  strengths: TaskKind[];
  /** relative cost weight — used to avoid 70B models on 3B work */
  cost: number;
}

export type TaskKind =
  | "translate"     // faithful, low creativity
  | "compose"       // editorial writing with a voice
  | "analyze"       // judgement over structured data
  | "code"          // code generation / repair
  | "compare"       // adjudicating two answers
  | "extract";      // strict JSON out of messy text

/**
 * The capability graph. Each tier in `AiBrain.FALLBACK` gets one row; routing
 * reads this table instead of hard-coding a model name anywhere else, so
 * swapping the underlying model is a one-line change here.
 */
export const MODEL_CAPS: ModelCapability[] = [
  { tier: "fast",  strengths: ["extract", "translate", "compare"], cost: 1 },
  { tier: "smart", strengths: ["compose", "analyze", "compare"],   cost: 3 },
  { tier: "code",  strengths: ["code", "analyze", "extract"],      cost: 3 },
];

/** Tier preference per task kind, cheapest-first so we never overspend by default. */
export function route(kind: TaskKind, breadth: number): Tier[] {
  const ordered = [...MODEL_CAPS]
    .sort((a, b) => {
      const as = a.strengths.includes(kind) ? 0 : 1;
      const bs = b.strengths.includes(kind) ? 0 : 1;
      if (as !== bs) return as - bs;
      return a.cost - b.cost;
    })
    .map((m) => m.tier);
  return ordered.slice(0, Math.max(1, Math.min(breadth, ordered.length)));
}

export interface MeshAttempt {
  tier: Tier;
  text: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface MeshResult {
  text: string;
  attempts: MeshAttempt[];
  /** the model that produced the text we kept */
  chosen: Tier | "synthesis" | "none";
  /** 0..1 — how much the models agreed; low means the task was genuinely ambiguous */
  agreement: number;
  critique?: string;
  /** what the critic thought was wrong with the losing answers */
  issues?: string[];
  ms: number;
}

export interface MeshOpts {
  kind: TaskKind;
  /** 1 = single model, 3 = full jury. Defaults to 1. */
  breadth?: number;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  /** run the Critic + Synthesis stages (skipped automatically when breadth === 1) */
  adjudicate?: boolean;
  feature?: string;
  userId?: number;
  cacheKey?: string;
}

/**
 * How much two answers agree.
 *
 * Word overlap is crude but *honest*: 1.0 means they literally say the same
 * things, and it never pretends to know more than it does. A false 0.9 would
 * be worse than a true 0.5.
 *
 * Two grounding decisions came from watching it fail on real output:
 *
 *  • **Short tokens count.** Dropping words of ≤2 characters — a sensible
 *    stop-word filter for prose — reduced two *identical* JSON answers
 *    (`{"a": 7, "b": 4}`) to zero overlap, because every token in them was
 *    short. Structure is signal, and JSON keys are structure. The filter is
 *    now "drop English stop-words by name", not "drop short words".
 *
 *  • **Very short answers compare as characters.** When both sides have fewer
 *    than four tokens there is nothing for a word metric to work with, so the
 *    comparison falls back to character trigrams — which is exactly right for
 *    a number, a version or a single identifier, the shapes models disagree
 *    about most.
 */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are", "you", "your",
  "but", "not", "have", "has", "had", "its", "it's", "as", "at", "by", "of", "on", "or", "in",
  "به", "از", "با", "که", "این", "آن", "را", "در", "است", "برای", "هم", "یا",
]);

function wordSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter((w) => w.length > 0 && !STOP.has(w)),
  );
}

function trigrams(s: string): Set<string> {
  // Strip whitespace and punctuation entirely: a trigram like "a b" or "ta "
  // is a word boundary, not content, and two unrelated sentences share plenty
  // of those — which is how a "completely different answers" pair scored 0.08.
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  if (!out.size && t) out.add(t);
  return out;
}

function jaccard(A: Set<string>, B: Set<string>): number {
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / Math.min(A.size, B.size);
}

export function agreement(a: string, b: string): number {
  const A = wordSet(a), B = wordSet(b);
  if (A.size >= 4 && B.size >= 4) return jaccard(A, B);
  // short answers: word overlap is meaningless, characters are not
  return jaccard(trigrams(a), trigrams(b));
}

const stripFence = (s: string) => s.replace(/^\s*```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();

export async function mesh(ai: AiBrain, prompt: string, opts: MeshOpts): Promise<MeshResult> {
  const started = Date.now();
  const breadth = Math.max(1, Math.min(opts.breadth ?? 1, 3));
  const tiers = route(opts.kind, breadth);

  const call = async (tier: Tier): Promise<MeshAttempt> => {
    const t0 = Date.now();
    try {
      const text = await ai.chat(prompt, {
        tier,
        system: opts.system,
        max_tokens: opts.max_tokens ?? 900,
        temperature: opts.temperature ?? 0.3,
        feature: opts.feature,
        userId: opts.userId,
        cacheKey: opts.cacheKey ? `${opts.cacheKey}:${tier}` : undefined,
      });
      const clean = stripFence(text ?? "");
      return { tier, text: clean, ms: Date.now() - t0, ok: clean.length > 0 };
    } catch (e: any) {
      return { tier, text: "", ms: Date.now() - t0, ok: false, error: String(e?.message ?? e).slice(0, 160) };
    }
  };

  const attempts = await Promise.all(tiers.map(call));
  const good = attempts.filter((a) => a.ok);

  // Nothing survived: report the failures rather than inventing an answer.
  if (!good.length) {
    return { text: "", attempts, chosen: "none", agreement: 0, ms: Date.now() - started };
  }
  if (good.length === 1 || !(opts.adjudicate ?? breadth > 1)) {
    const best = good[0];
    return { text: best.text, attempts, chosen: best.tier, agreement: 1, ms: Date.now() - started };
  }

  // ── Critic ──────────────────────────────────────────────────────────────
  const agreementScore = pairwiseAgreement(good.map((g) => g.text));
  const critiqueRaw = await ai.chat(
    `You are comparing ${good.length} candidate answers to the SAME task. Decide which is best and say why, briefly.\n\n` +
      good.map((g, i) => `--- CANDIDATE ${i + 1} (${g.tier}) ---\n${g.text.slice(0, 1800)}`).join("\n\n") +
      `\n\nReturn STRICT JSON only:\n` +
      `{"best": <1-based index or 0 if none is clearly better>,"issues":["short flaw in a losing answer", …],` +
      `"confidence": <0..1>,"merged_hint":"one sentence on what a merged answer should keep"}\n` +
      `Judge on: factual accuracy, faithfulness to the task, completeness, and whether it reads like a human wrote it.`,
    { tier: "fast", max_tokens: 400, temperature: 0.1, feature: `${opts.feature ?? "mesh"}:critic` },
  );

  const critic = safeJson<{ best?: number; issues?: string[]; confidence?: number; merged_hint?: string }>(critiqueRaw);
  const issues = Array.isArray(critic?.issues) ? critic!.issues!.slice(0, 5) : [];

  // ── Synthesis ───────────────────────────────────────────────────────────
  // A clear winner is used verbatim: rewriting a good answer risks making it
  // worse, and the models that produced it are not improved by paraphrasing.
  if (critic?.best && critic.best >= 1 && critic.best <= good.length) {
    const winner = good[critic.best - 1];
    return {
      text: winner.text, attempts, chosen: winner.tier,
      agreement: agreementScore, critique: critic.merged_hint,
      issues, ms: Date.now() - started,
    };
  }

  // No clear winner → merge. Only here do we spend a second generation.
  const merged = await ai.chat(
    `Merge these ${good.length} answers into ONE best answer, in the SAME language and format the task implies.\n` +
      `Keep every fact that appears in more than one answer. Drop anything only one answer claims unless it is clearly correct.\n` +
      `Do not mention that you are merging, do not add commentary — output the answer only.\n\n` +
      good.map((g, i) => `--- ${i + 1} ---\n${g.text.slice(0, 1800)}`).join("\n\n"),
    { tier: "smart", max_tokens: opts.max_tokens ?? 900, temperature: 0.25, feature: `${opts.feature ?? "mesh"}:synth` },
  );

  const text = stripFence(merged ?? "") || good[0].text;
  return {
    text, attempts,
    chosen: merged ? "synthesis" : good[0].tier,
    agreement: agreementScore,
    critique: critic?.merged_hint,
    issues,
    ms: Date.now() - started,
  };
}

function pairwiseAgreement(texts: string[]): number {
  if (texts.length < 2) return 1;
  let sum = 0, n = 0;
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) { sum += agreement(texts[i], texts[j]); n++; }
  return n ? sum / n : 1;
}

function safeJson<T>(raw: string): T | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/**
 * Confidence is a *signal*, deliberately composed from things we can measure
 * rather than asked of the model. A model's self-reported confidence is
 * famously uncalibrated; agreement between independent models is not.
 */
export function meshConfidence(r: MeshResult): number {
  if (r.chosen === "none") return 0;
  const base = r.attempts.filter((a) => a.ok).length >= 2 ? 0.5 + r.agreement * 0.45 : 0.6;
  const penalty = Math.min(0.2, (r.issues?.length ?? 0) * 0.05);
  return Math.max(0, Math.min(1, base - penalty));
}
