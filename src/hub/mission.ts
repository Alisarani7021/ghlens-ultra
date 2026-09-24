import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { type Workflow, type WfNode, type NodeKind, saveWorkflow } from "./engine";
import { PLAYBOOKS, EDITOR_SYSTEM, type Playbook } from "./playbooks";
import { CONNECTORS } from "./connectors";
import { loadRepos } from "./wiring";

/**
 *  MISSION MODE
 *
 *      «هر روز اخبار مهم AI رو پیدا کن، تکراری‌ها رو حذف کن، فارسی کن و
 *       قبل از انتشار بهم نشون بده»
 *                              ↓
 *                    Mission Planner
 *                              ↓
 *                         Workflow DAG
 *
 *  The planner is the difference between a tool and an assistant: the owner
 *  states an outcome, and the system builds the machine that produces it.
 *
 *  Two things keep it honest:
 *
 *   1. **The model may only use nodes that exist.** Its output is validated
 *      against the real node kinds and the real connector list; an invented
 *      node is repaired or the mission is refused. A planner that can emit
 *      fantasy nodes is a demo, not a system.
 *
 *   2. **Every mission is saved as data, not code.** The generated DAG lands in
 *      `hub_workflows` and can be read, edited and replayed by its owner.
 */

export interface MissionPlan {
  name: string;
  on_event: string;
  nodes: WfNode[];
  entry: string;
  /** which connectors the plan needs, so we can tell the owner what to wire */
  requires: string[];
  /** where the plan came from — an AI draft or a matched playbook */
  source: "ai" | "playbook" | "repaired";
  notes: string;
}

const KINDS: NodeKind[] = [
  "trigger", "ai", "compose.release", "http", "transform", "condition",
  "policy", "content", "approval", "notify", "connector", "delay", "stop",
];

/** Event shapes the planner is allowed to react to. */
const TRIGGERS = [
  "github.release.*", "github.push.*", "github.issue.*",
  "rss.item.new", "http.value.changed", "http.response.received",
  "", "*",
];

export const NODE_DOC = `Available node kinds (use ONLY these):
- trigger: the entry point. cfg {}.
- ai: one model call. cfg { prompt, task: translate|compose|analyze|code|extract|compare, breadth: 1..3, system, out, max_tokens }
- compose.release: builds a formatted release post with download buttons. cfg { editorial_from }
- http: fetch a URL. cfg { url, method, out }
- transform: derive a value. cfg { op: length|upper|json|template, path, template, out }
- condition: branch on a value. cfg { path, op: exists|eq|neq|gt|lt|includes|match, value, else: [nodeIds] }
- policy: the policy engine gate. cfg { destination: channel|draft|none, from }
- content: records the artefact in the content graph. cfg { kind, from, lang }
- approval: stops and asks the human. cfg { from }
- notify: messages the owner. cfg { text }
- connector: call an outside service. cfg { kind: telegram|github|rss|http, action, text, from, channel }
- delay: cfg { ms }
- stop: ends the run.

Every node: { "id": "shortname", "kind": "...", "cfg": {...}, "next": ["otherId"] }
The FIRST node must be kind "trigger". Reference event data with {{event.payload.x}}.`;

/**
 * Build a mission. Tries the model first; falls back to a matching playbook so
 * the owner always gets something runnable instead of an error message.
 */
export async function planMission(
  env: Env,
  ai: AiBrain,
  ownerId: number,
  mission: string,
): Promise<MissionPlan> {
  const connectors = Object.entries(CONNECTORS)
    .map(([k, c]) => `- ${k}: emits [${c.emits.join(", ")}] actions [${c.actions.join(", ")}] — ${c.configHint}`)
    .join("\n");

  const raw = await ai.chat(
    `You compile a plain-language mission into a workflow DAG for an automation platform.\n\n` +
      `MISSION (may be Persian or English):\n"""${mission.slice(0, 1200)}"""\n\n` +
      `CONNECTORS:\n${connectors}\n\n` +
      NODE_DOC +
      `\n\nReturn STRICT JSON only, no prose, no markdown fence:\n` +
      `{"name":"نام کوتاه فارسی","on_event":"<one of: ${TRIGGERS.join(" | ")}>",` +
      `"requires":["connectorKind", ...],"notes":"یک جمله دربارهٔ آنچه ساخته شد",` +
      `"nodes":[{"id":"in","kind":"trigger","cfg":{},"next":["a"]}, ...]}\n\n` +
      `Rules:\n` +
      `• Keep it SHORT — 3 to 7 nodes. Do not build a cathedral for a small request.\n` +
      `• Anything that publishes outside must pass through a "policy" node, then an "approval" node.\n` +
      `• Use "content" before "approval" so the post exists in the graph.\n` +
      `• If the mission is a request to translate/summarise, use task "translate"/"compose" with breadth 1 to save quota.\n` +
      `• on_event must be "" when the mission is something the owner runs by hand.`,
    // `json: true` appends the "return ONLY valid JSON" instruction the model
    // actually obeys — without it a smart-tier model often wraps the DAG in a
    // sentence of explanation, and the planner falls back to a playbook even
    // though it had the right answer.
    { tier: "smart", max_tokens: 1600, temperature: 0.15, json: true, feature: "hub:mission", userId: ownerId },
  );

  /* What the sentence demands beats what the model returned: if the mission is
     event-shaped, the trigger is not optional. */
  const forced = triggerForMission(mission);
  const withTrigger = (p: MissionPlan): MissionPlan =>
    forced && p.on_event !== forced
      ? { ...p, on_event: forced, notes: `${p.notes} · محرک از خودِ جمله: ${forced}` }
      : p;

  const parsed = extractJson(raw);
  if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length) {
    const repaired = repairPlan(parsed);
    if (repaired) return withTrigger({ ...repaired, on_event: pickTrigger(repaired.on_event), source: repaired.repaired ? "repaired" : "ai" });
  }

  // ── fallback: match the mission against the shipped playbooks ────────────
  const pb = bestPlaybook(mission);
  if (pb) {
    return withTrigger({
      name: pb.name, on_event: pb.on_event, nodes: pb.dag.nodes, entry: pb.dag.entry,
      requires: [pb.needs], source: "playbook",
      notes: `برنامهٔ آماده «${pb.name}» انتخاب شد (برنامه‌ریز نتوانست DAG معتبر بسازد).`,
    });
  }
  return {
    name: "مأموریت دستی", on_event: "", nodes: [{ id: "in", kind: "trigger", next: ["done"] }, { id: "done", kind: "stop" }],
    entry: "in", requires: [], source: "playbook",
    notes: "نتوانستم از این جمله یک ورک‌فلو بسازم — با گزینه‌های آماده یا یک جملهٔ دقیق‌تر دوباره امتحان کن.",
  };
}

/** Score the mission text against each playbook's trigger words. */
export function bestPlaybook(mission: string): Playbook | null {
  const m = mission.toLowerCase();
  const score = (p: Playbook): number => {
    let s = 0;
    if (/ریلیز|release|نسخه|version|changelog|چنج/.test(m) && p.key === "release-to-channel") s += 3;
    if (/rss|فید|feed|خبر|news|مقاله|article/.test(m) && p.key === "rss-digest") s += 3;
    if (/مانیتور|monitor|تغییر|change|watch|پایش/.test(m) && p.key === "watchdog") s += 3;
    if (/کانال|channel|تلگرام|telegram|پست|post/.test(m) && p.key === "release-to-channel") s += 1;
    return s;
  };
  const ranked = PLAYBOOKS.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s);
  return ranked[0]?.s > 0 ? ranked[0].p : null;
}

function extractJson(raw: string): any | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* try repairs below */ }
  // Models emit near-JSON constantly: a trailing comma, a comment, a stray
  // newline inside a string. Repairing is cheaper than a second generation and
  // the plan is validated afterwards anyway — a bad repair cannot produce a
  // dangerous DAG, only an invalid one.
  const repaired = slice
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  try { return JSON.parse(repaired); } catch { return null; }
}

/**
 * Validate and repair a model-authored DAG.
 *
 * Repair (rather than reject) is the right default here: a plan with one
 * unknown node kind and a broken `next` pointer is 90% correct, and throwing
 * it away to fall back to a generic playbook wastes the good 90%.
 */
export function repairPlan(p: any): (MissionPlan & { repaired: boolean }) | null {
  if (!p || typeof p !== "object") return null;
  let repaired = false;
  const rawNodes: any[] = Array.isArray(p.nodes) ? p.nodes : [];
  const nodes: WfNode[] = [];

  for (const n of rawNodes.slice(0, 14)) {
    if (!n || typeof n !== "object") { repaired = true; continue; }
    const id = String(n.id ?? "").replace(/[^\w.-]/g, "").slice(0, 24);
    let kind = String(n.kind ?? "") as NodeKind;
    if (!id) { repaired = true; continue; }
    if (!KINDS.includes(kind)) {
      // map common model inventions onto nodes we actually have
      const k = kind.toLowerCase();
      kind = k.includes("schedule") || k.includes("cron") ? "trigger"
        : k.includes("telegram") || k.includes("publish") || k.includes("send") ? "connector"
        : k.includes("if") || k.includes("branch") ? "condition"
        : k.includes("review") || k.includes("human") ? "approval"
        : k.includes("save") || k.includes("store") ? "content"
        : "transform";
      repaired = true;
    }
    nodes.push({ id, kind, label: typeof n.label === "string" ? n.label.slice(0, 40) : undefined, cfg: sanitizeCfg(n.cfg), next: [] });
  }
  if (!nodes.length) return null;

  // Wire `next` pointers; any that reference a missing node are dropped.
  const ids = new Set(nodes.map((n) => n.id));
  for (let i = 0; i < nodes.length; i++) {
    const src = rawNodes[i]?.next ?? rawNodes[i]?.then;
    let next: string[] = Array.isArray(src) ? src.map((x: any) => String(x)).filter((x) => ids.has(x)) : [];
    if (!next.length) {
      const model = rawNodes[i]?.next;
      if (model !== undefined && (!Array.isArray(model) || model.length === 0)) {
        // explicit empty `next` means "this is the end"
        next = [];
      } else if (i + 1 < nodes.length) {
        next = [nodes[i + 1].id];
        repaired = true;
      }
    }
    nodes[i].next = next;
  }

  // The entry node must be the trigger; if the model put one mid-list, reorder.
  const triggerAt = nodes.findIndex((n) => n.kind === "trigger");
  if (triggerAt > 0) { const [t] = nodes.splice(triggerAt, 1); nodes.unshift(t); repaired = true; }
  else if (triggerAt === -1) {
    nodes.unshift({ id: "in", kind: "trigger", cfg: {}, next: nodes[0] ? [nodes[0].id] : [] });
    repaired = true;
  }
  // Exactly one node must be reachable-entry; ensure the entry has an outgoing edge.
  if (!nodes[0].next?.length && nodes.length > 1) { nodes[0].next = [nodes[1].id]; repaired = true; }

  // Safety net: if anything can publish, force a policy node earlier in the chain.
  // Conservative on purpose: *any* connector node may reach the outside
  // world, and guessing wrong here means an ungated post. A wasted policy
  // node costs one step; a missing one costs the owner's trust.
  const hasPublish = nodes.some((n) => n.kind === "connector" || n.kind === "notify");
  const hasPolicy = nodes.some((n) => n.kind === "policy");
  if (hasPublish && !hasPolicy) {
    const firstNext = nodes[0].next ?? [];
    nodes.splice(1, 0, { id: "policy", kind: "policy", label: "دروازهٔ سیاست", cfg: { destination: "channel" }, next: firstNext });
    nodes[0].next = ["policy"];
    repaired = true;
  }

  return {
    name: String(p.name ?? "مأموریت").slice(0, 60),
    on_event: String(p.on_event ?? ""),
    nodes,
    entry: nodes[0].id,
    requires: Array.isArray(p.requires) ? p.requires.map(String).slice(0, 6) : [],
    source: "ai",
    notes: String(p.notes ?? "").slice(0, 200),
    repaired,
  };
}

/** Keep cfg JSON-safe and bounded — it goes straight into a D1 text column. */
function sanitizeCfg(cfg: any): Record<string, any> {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg).slice(0, 12)) {
    if (typeof v === "string") out[k] = v.slice(0, 2000);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 10).map((x) => (typeof x === "string" ? x.slice(0, 120) : x));
    else if (v && typeof v === "object") out[k] = JSON.parse(JSON.stringify(v).slice(0, 1000));
  }
  return out;
}

function pickTrigger(value: string): string {
  const v = (value ?? "").trim();
  return TRIGGERS.includes(v) ? v : "";
}

/**
 * The trigger a mission *says out loud*, independent of the model.
 *
 * The planner was allowed to leave `on_event` empty, and it did exactly that for
 * «هر وقت مخزن X نسخهٔ جدید داد، در کانال بگذار» — a sentence whose first two
 * words are a schedule. The owner then had a workflow that only ran when he
 * pressed a button, which is the opposite of what he asked for, and the GitHub
 * connector had nothing to feed it. The words decide this; the model cannot
 * forget them.
 */
export function triggerForMission(mission: string): string {
  const m = String(mission ?? "").toLowerCase();
  const recurring = /هر وقت|هر زمان|هروقت|whenever|each time|every time|بعد از (?:هر|هزینه)|تا (?:نسخه|ریلیز) جدید|وقتی .* (?:شد|داد|آمد)|به محض/.test(m);
  if (!recurring) return "";
  const hasRepo = /[\w.-]+\/[\w.-]+/.test(m);
  if (/نسخه|ریلیز|release|version|تگ|tag|آپدیت|update/.test(m) && hasRepo) return "github.release.*";
  if (/کامیت|commit|push|پوش|شاخه|branch/.test(m) && hasRepo) return "github.push.*";
  if (/ایشو|issue|مشکل|باگ گزارش/.test(m) && hasRepo) return "github.issue.*";
  if (/فید|rss|feed/.test(m)) return "rss.item.new";
  if (/صفحه|وب\s?سایت|api|تغییر کرد|عوض شد|پایش|monitor|watch/.test(m)) return "http.value.changed";
  if (hasRepo) return "github.release.*";
  return "";
}

/**
 * Persist a plan as a real workflow the owner can read and edit.
 *
 * Installing the *same* mission twice is one workflow, not two. The owner asked
 * for «این مخزن هر وقت آپدیت شد خودکار پست کن», repeated it while tuning the
 * wording, and ended up with three identical enabled workflows on one event —
 * three posts per release, three times the model spend, and no way to tell which
 * one to delete. Identity here is (trigger, repositories, owner): a different
 * mission in the same shape is an edit, not a new machine. A plan with no
 * trigger and no repositories stays additive, because two manual workflows are
 * legitimately two things.
 */
export async function installPlan(
  env: Env, ownerId: number, plan: MissionPlan, mission: string, repos: string[],
): Promise<{ id: string; replaced: boolean }> {
  const sameShape = plan.on_event && repos.length;
  if (sameShape) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM hub_workflows WHERE owner_id=? AND on_event=? ORDER BY created_at DESC LIMIT 5`,
    ).bind(ownerId, plan.on_event).all<{ id: string }>().catch(() => ({ results: [] as any[] }));
    for (const row of results ?? []) {
      const theirs = await loadRepos(env, row.id);
      const same = theirs.length === repos.length && theirs.every((r) => repos.includes(r));
      if (!same) continue;
      await env.DB.prepare(
        `UPDATE hub_workflows SET name=?, mission=?, dag=? WHERE id=? AND owner_id=?`,
      ).bind(plan.name, mission, JSON.stringify({ entry: plan.entry, nodes: plan.nodes }), row.id, ownerId)
        .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      return { id: row.id, replaced: true };
    }
  }
  const id = await saveWorkflow(env, {
    owner_id: ownerId,
    name: plan.name,
    mission,
    dag: { entry: plan.entry, nodes: plan.nodes },
    on_event: plan.on_event,
    enabled: 1,
  });
  return { id, replaced: false };
}

/** Persist a plan as a real workflow the owner can read and edit. */
export async function savePlan(env: Env, ownerId: number, plan: MissionPlan, mission: string): Promise<string> {
  return saveWorkflow(env, {
    owner_id: ownerId,
    name: plan.name,
    mission,
    dag: { entry: plan.entry, nodes: plan.nodes },
    on_event: plan.on_event,
    enabled: 1,
  });
}

/** Human-readable rendering of a DAG — used by the UI and the audit trail. */
export function describeDag(plan: { nodes: WfNode[]; entry: string }): string {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const walk = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id) || depth > 8) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    lines.push(`${"   ".repeat(depth)}${depth ? "└─ " : "▶ "}${ICON[n.kind] ?? "•"} ${n.label ?? n.kind}`);
    for (const nx of n.next ?? []) walk(nx, depth + 1, seen);
  };
  walk(plan.entry, 0, new Set());
  return lines.join("\n");
}

const ICON: Record<NodeKind, string> = {
  trigger: "🎯", ai: "🧠", "compose.release": "🧩", http: "🌐", transform: "🔧", condition: "🔀",
  policy: "🔐", content: "🕸", approval: "🕹", notify: "🔔", connector: "🔌", delay: "⏳", stop: "⏹",
};
