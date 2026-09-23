import type { Env } from "../env";
import type { AiBrain } from "../ai/brain";
import { Telegram } from "../tg/api";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";
import { type HubEvent, hubId, matches, markEvent } from "./event";
import { connector, pluck } from "./connectors";
import { evaluate, type PolicySubject } from "./policy";
import * as CG from "./content";
import { mesh, meshConfidence, type TaskKind } from "./mesh";
import { composeReleasePost, type Asset } from "./editor";
import { indexEntities, embedDocument } from "./knowledge";

/**
 *  THE ENGINE
 *
 *      trigger → [node] → [node] → … → publish
 *
 *  A workflow is a DAG of small nodes; each node receives a shared bag of
 *  variables and returns a patch to it. That is the whole contract, and it is
 *  what makes the node library composable: any node can follow any node,
 *  because none of them know about each other.
 *
 *  Three design rules the engine will not break:
 *
 *   • **A run is resumable.** The frontier is persisted, so an `approval` node
 *     pauses the run for a day and resumes exactly where it stopped.
 *   • **A step is inspectable.** Every node records kind, ms, and a short
 *     summary into `hub_runs.steps` — the owner can always see what happened.
 *   • **A failure is contained.** A node that throws stops its own run, marks
 *     the event, and never takes the worker down with it.
 */

export type NodeKind =
  | "trigger" | "ai" | "compose.release" | "http" | "transform" | "condition"
  | "policy" | "content" | "approval" | "notify" | "connector" | "delay" | "stop";

export interface WfNode {
  id: string;
  kind: NodeKind;
  label?: string;
  cfg?: Record<string, any>;
  next?: string[];
}

export interface Workflow {
  id: string;
  owner_id: number;
  name: string;
  mission: string;
  dag: { entry: string; nodes: WfNode[] };
  on_event: string;
  enabled: number;
  runs: number;
  created_at: number;
}

export interface Step {
  node: string;
  kind: NodeKind;
  ms: number;
  summary: string;
  ok: boolean;
  error?: string;
}

export interface RunResult {
  run_id: string;
  state: "ok" | "failed" | "waiting";
  steps: Step[];
  bag: Record<string, any>;
  /** when state==="waiting": the node waiting on a human, and what remains */
  waiting?: { node: string; remaining: string[] };
  error?: string;
}

export interface EngineCtx {
  env: Env;
  ai: AiBrain;
  tg: Telegram;
  owner_id: number;
  trace: string;
  event?: HubEvent;
  autonomy?: "manual" | "auto-with-review" | "auto";
  /**
   * Preview mode. A dry run must be indistinguishable from a real one in what it
   * *shows* and completely inert in what it *does*: it does not ask for approval
   * and it does not post, no matter how the owner's autonomy is set. Without
   * this flag the two were the same code path, which is how "آزمایشی" produced
   * real prompts.
   */
  dry?: boolean;
  /** resume support: skip straight to this node (approval already granted) */
  resumeFrom?: string;
}

/** `{{event.payload.repo}}` → the value at that path. Missing → empty string. */
export function render(tpl: string, scope: Record<string, any>): string {
  return String(tpl ?? "").replace(/\{\{\s*([\w.$[\]-]+)\s*\}\}/g, (_m, path: string) => {
    const v = pluck(scope, path);
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

function nodeById(wf: Workflow, id: string): WfNode | null {
  return wf.dag.nodes.find((n) => n.id === id) ?? null;
}

/**
 * Walk the DAG from `entry`, executing nodes until a stop, an approval gate, or
 * the end of the chain.
 */
export async function runWorkflow(
  ctx: EngineCtx,
  wf: Workflow,
  input: Record<string, any>,
  runId?: string,
): Promise<RunResult> {
  const started = Date.now();
  const id = runId ?? hubId("run");
  const steps: Step[] = [];
  const bag: Record<string, any> = {
    ...input,
    // the run's own id rides in the bag so an approval button can carry it
    // back to us and resume exactly this run
    run_id: id,
    event: ctx.event ? { type: ctx.event.type, source: ctx.event.source, payload: ctx.event.payload } : {},
    owner_id: ctx.owner_id,
  };

  // Resolve the owner's publishing target up front.
  //
  // The policy node has to know whether a channel exists *before* it can decide
  // anything, and a workflow triggered by an event has no way to carry that in
  // its payload. Loading it once here also means every node downstream — the
  // connector that publishes, the notification that reports — agrees on where
  // "the channel" is, instead of each looking it up and disagreeing.
  if (bag.channel == null) {
    const tgConf = await loadConnectorConfig(ctx.env, ctx.owner_id, "telegram");
    if (tgConf.channel) bag.channel = tgConf.channel;
  }

  let current: string | null = ctx.resumeFrom ?? wf.dag.entry ?? wf.dag.nodes[0]?.id ?? null;
  let state: RunResult["state"] = "ok";
  let error: string | undefined;
  let waiting: RunResult["waiting"];

  const guard = new Set<string>();
  while (current) {
    if (guard.has(current)) { error = `حلقه در گراف: ${current}`; state = "failed"; break; }
    guard.add(current);
    const node = nodeById(wf, current);
    if (!node) break;

    const t0 = Date.now();
    try {
      const out = await execNode(ctx, node, bag, wf);
      if (out.patch) Object.assign(bag, out.patch);
      steps.push({ node: node.id, kind: node.kind, ms: Date.now() - t0, summary: out.summary ?? "", ok: true });
      if (out.halt) break;
      if (out.wait) {
        state = "waiting";
        waiting = { node: node.id, remaining: out.remaining ?? node.next ?? [] };
        steps[steps.length - 1].summary = out.summary ?? "در انتظار تأیید";
        break;
      }
      const nextList = out.branch ?? node.next ?? [];
      current = nextList.length ? nextList[0] : null;
      // A node may fan out; run the extra branches inline so `next` stays a
      // simple array in the stored DAG (a real fork/join engine is a bigger
      // change than this slice needs, and inline keeps ordering obvious).
      for (const extra of nextList.slice(1)) {
        const sub = await runWorkflow(ctx, { ...wf, dag: { entry: extra, nodes: wf.dag.nodes } }, bag, id);
        steps.push(...sub.steps.map((s) => ({ ...s, summary: `↳ ${s.summary}` })));
        if (sub.state === "waiting") { state = "waiting"; waiting = sub.waiting; }
      }
      if (state === "waiting") break;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 240);
      steps.push({ node: node.id, kind: node.kind, ms: Date.now() - t0, summary: "خطا", ok: false, error: msg });
      state = "failed";
      error = msg;
      break;
    }
  }

  const result: RunResult = { run_id: id, state, steps, bag, waiting, error };
  await persistRun(ctx, wf, id, input, result, started);
  if (ctx.event && state !== "waiting") await markEvent(ctx.env, ctx.event.id, error);
  await ctx.env.DB.prepare(`UPDATE hub_workflows SET runs = runs + 1 WHERE id=?`).bind(wf.id)
    .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  return result;
}

async function persistRun(ctx: EngineCtx, wf: Workflow, id: string, input: any, r: RunResult, started: number) {
  // Values are bound positionally, one per line, against the column list right
  // above them. No spread: a `[...args]` here would be invisible to the SQL
  // guard and to a reader, and this is the exact shape that silently put
  // vectors in the wrong column of `hub_docs` (see knowledge.ts).
  const res = await ctx.env.DB.prepare(
    `INSERT INTO hub_runs (id, wf_id, owner_id, event_id, input, state, steps, trace, output, error, started_at, ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,                                                              // id
    wf.id,                                                           // wf_id
    ctx.owner_id,                                                    // owner_id
    ctx.event?.id ?? null,                                           // event_id
    JSON.stringify(input).slice(0, 4000),                            // input
    r.state,                                                         // state
    JSON.stringify(r.steps).slice(0, 12000),                         // steps
    ctx.trace,                                                       // trace
    JSON.stringify({ bag: trimBag(r.bag), waiting: r.waiting ?? null }).slice(0, 12000), // output
    r.error ?? null,                                                 // error
    started,                                                         // started_at
    Date.now(),                                                      // ended_at
  ).run().catch((e: any) => {
    console.error("hub-run-insert", String(e?.message ?? e));
    return null;
  });
  // A resumed run already has a row — update instead of inserting.
  if (!res) {
    await ctx.env.DB.prepare(
      `UPDATE hub_runs SET state=?, steps=?, output=?, error=?, ended_at=? WHERE id=?`,
    ).bind(r.state, JSON.stringify(r.steps).slice(0, 12000), JSON.stringify({ bag: trimBag(r.bag), waiting: r.waiting ?? null }).slice(0, 12000), r.error ?? null, Date.now(), id)
      .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
}

/** Never persist the whole payload blob — runs are logs, not an event store. */
function trimBag(bag: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(bag)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[k] = s && s.length > 1200 ? `${s.slice(0, 1200)}…` : v;
  }
  return out;
}

interface NodeOut {
  patch?: Record<string, any>;
  summary?: string;
  halt?: boolean;
  wait?: boolean;
  remaining?: string[];
  branch?: string[];
}

async function execNode(ctx: EngineCtx, node: WfNode, bag: Record<string, any>, wf: Workflow): Promise<NodeOut> {
  const cfg = node.cfg ?? {};
  switch (node.kind) {
    case "trigger":
      return { summary: `رویداد: ${bag.event?.type ?? "دستی"}` };

    case "ai": {
      const prompt = render(String(cfg.prompt ?? ""), bag);
      const kind = (cfg.task ?? "compose") as TaskKind;
      const r = await mesh(ctx.ai, prompt, {
        kind,
        breadth: Number(cfg.breadth ?? 1),
        system: cfg.system ? render(String(cfg.system), bag) : undefined,
        max_tokens: Number(cfg.max_tokens ?? 900),
        temperature: cfg.temperature != null ? Number(cfg.temperature) : 0.3,
        adjudicate: Number(cfg.breadth ?? 1) > 1,
        feature: `hub:${wf.id}`,
        userId: ctx.owner_id,
      });
      const out = cfg.out ? String(cfg.out) : "ai";
      const confidence = meshConfidence(r);
      const models = r.attempts.filter((a) => a.ok).map((a) => a.tier);
      return {
        // `confidence` is lifted to the top level as well as kept under the
        // node's own meta: the policy engine reads the flat key, and a rule
        // that never fires because its input never arrived is worse than no
        // rule at all (it reads as "everything was checked and fine").
        patch: {
          [out]: r.text,
          [`${out}__meta`]: { chosen: r.chosen, agreement: r.agreement, confidence, models },
          confidence,
          models,
        },
        summary: `AI (${r.chosen}) · ${r.text.length} نویسه · اطمینان ${Math.round(confidence * 100)}٪`,
      };
    }

    case "compose.release": {
      const p = bag.event?.payload ?? {};
      const editorial = cfg.editorial_from ? String(bag[String(cfg.editorial_from)] ?? "") : "";
      const post = composeReleasePost({
        repo: p.repo ?? cfg.repo ?? "",
        tag: p.tag ?? cfg.tag ?? "",
        name: p.name, body: p.body, url: p.url, publishedAt: p.published_at,
        prerelease: !!p.prerelease,
        assets: (p.assets ?? []) as Asset[],
        editorial,
      });
      return {
        patch: { post: post.text, markup: post.markup, asset_count: post.assetCount },
        summary: `پست ساخته شد · ${post.assetCount} فایل`,
      };
    }

    case "http": {
      const c = connector("http");
      const url = render(String(cfg.url ?? ""), bag);
      const out = await c?.act?.({ env: ctx.env, owner_id: ctx.owner_id, config: {} }, "request", {
        url, method: cfg.method ?? "GET", headers: cfg.headers, body: cfg.body,
      });
      return { patch: { [String(cfg.out ?? "http")]: out?.json ?? out?.text ?? null }, summary: `HTTP ${out?.status ?? "?"}` };
    }

    case "transform": {
      const value = cfg.path ? pluck(bag, String(cfg.path)) : undefined;
      const out = String(cfg.out ?? "value");
      if (cfg.op === "length") return { patch: { [out]: Array.isArray(value) ? value.length : String(value ?? "").length }, summary: "طول" };
      if (cfg.op === "upper") return { patch: { [out]: String(value ?? "").toUpperCase() }, summary: "بزرگ" };
      if (cfg.op === "json") return { patch: { [out]: typeof value === "string" ? safeParse(value) : value }, summary: "JSON" };
      if (cfg.op === "template") return { patch: { [out]: render(String(cfg.template ?? ""), bag) }, summary: "قالب" };
      return { patch: { [out]: value }, summary: "مقدار" };
    }

    case "condition": {
      const left = pluck(bag, String(cfg.path ?? ""));
      const op = String(cfg.op ?? "exists");
      const right = cfg.value;
      const pass =
        op === "exists" ? left != null :
        op === "eq" ? String(left) === String(right) :
        op === "neq" ? String(left) !== String(right) :
        op === "gt" ? Number(left) > Number(right) :
        op === "lt" ? Number(left) < Number(right) :
        op === "includes" ? String(left ?? "").includes(String(right)) :
        op === "match" ? new RegExp(String(right), "i").test(String(left ?? "")) :
        false;
      return {
        branch: pass ? (node.next ?? []) : (cfg.else ?? []),
        summary: `${op} → ${pass ? "بله" : "خیر"}`,
      };
    }

    case "policy": {
      const text = cfg.text ? render(String(cfg.text), bag) : String(bag.post ?? bag[String(cfg.from ?? "")] ?? "");
      const sourceRef = String(bag.source_ref ?? bag.event?.payload?.identity ?? "");

      // Duplication is resolved *here*, not asked of the caller — the whole
      // point of a gate is that the thing behind it cannot skip the check.
      // Two passes: an exact hit on the source identity, then a near-duplicate
      // search over recently written text for sources that have no stable id.
      let duplicate = !!bag.duplicate;
      let duplicateScore = Number(bag.duplicate_score ?? 0);
      if (!duplicate && sourceRef) {
        const prior = await CG.findBySource(ctx.env, ctx.owner_id, sourceRef);
        if (prior) { duplicate = true; duplicateScore = 1; }
      }
      if (!duplicate && text) {
        const similar = await CG.findSimilar(ctx.env, ctx.owner_id, text, 0.8).catch(() => []);
        if (similar.length) { duplicate = true; duplicateScore = similar[0].score; }
      }

      const subject: PolicySubject = {
        destination: (cfg.destination ?? "channel") as PolicySubject["destination"],
        text,
        sourceRef: sourceRef || null,
        confidence: typeof bag.confidence === "number" ? bag.confidence : 0.7,
        duplicate,
        duplicateScore,
        stale: !!bag.stale,
        failedCheck: !!bag.failed_check,
        quotaLeft: null,
      };
      const decision = evaluate(subject, {
        hasChannel: !!bag.channel,
        autonomy: ctx.autonomy ?? "manual",
      });
      return {
        patch: {
          policy: { allow: decision.allow, require: decision.require, summary: decision.summary, verdicts: decision.verdicts.filter((v) => !v.allow || v.require).map((v) => v.code) },
          duplicate,
          duplicate_score: duplicateScore,
        },
        branch: decision.allow ? (node.next ?? []) : [],
        summary: decision.allow ? `مجاز (${decision.require ?? "بدون شرط"})` : `مسدود: ${decision.summary.slice(0, 80)}`,
      };
    }

    case "content": {
      const title = cfg.title ? render(String(cfg.title), bag) : String(bag.event?.payload?.name ?? bag.event?.payload?.repo ?? "محتوا");
      const body = String(bag[String(cfg.from ?? "post")] ?? "");
      const cid = await CG.createContent(ctx.env, {
        owner_id: ctx.owner_id,
        kind: (cfg.kind ?? "post") as CG.ContentKind,
        title, body,
        lang: String(cfg.lang ?? "fa"),
        source_ref: String(bag.source_ref ?? bag.event?.payload?.identity ?? "") || undefined,
        dna: {
          topic: String(bag.event?.payload?.repo ?? "").split("/").pop() || "general",
          source: bag.event?.source,
          entities: bag.event?.payload?.repo ? [String(bag.event.payload.repo)] : [],
          models: Array.isArray(bag.models) ? bag.models : [],
          confidence: typeof bag.confidence === "number" ? bag.confidence : 0,
          created_by: "hub",
        },
        state: "draft",
        confidence: typeof bag.confidence === "number" ? bag.confidence : 0,
      });
      // Wire the graph: this post derives from whatever the run was triggered by.
      if (bag.source_content_id) await CG.link(ctx.env, cid, String(bag.source_content_id), "derived_from");

      // …and feed the *knowledge* layer, which is the half that makes the
      // content findable later. Both passes are best-effort: a post that was
      // written is worth keeping even when the AI quota is spent, so a failure
      // here degrades search rather than losing the artefact.
      let entities = 0;
      if (body) {
        entities = await indexEntities(ctx.env, ctx.owner_id, cid, body, {
          repo: String(bag.event?.payload?.repo ?? "") || undefined,
          source: bag.event?.source ? String(bag.event.source) : undefined,
        }).catch(() => 0);
        await embedDocument(ctx.env, ctx.ai, {
          id: cid, owner_id: ctx.owner_id, text: body, title,
          kind: "post", lang: String(cfg.lang ?? "fa"),
          source_ref: String(bag.source_ref ?? ""),
        }).catch(() => false);
      }
      // The markup (one download button per release asset) is part of the
      // artefact, not part of the run's working memory: `trimBag` cuts any
      // stored bag value at 1200 chars, and a release with eight assets has a
      // keyboard longer than that. Keeping it on the content row is what lets
      // an approval resumed an hour later publish the *same* buttons instead of
      // a truncated string Telegram would reject.
      if (bag.markup) {
        await ctx.env.DB.prepare(`UPDATE hub_content SET dna = json_set(COALESCE(NULLIF(dna,''),'{}'), '$.markup', json(?)) WHERE id=?`)
          .bind(JSON.stringify(bag.markup), cid)
          .run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
      return { patch: { content_id: cid }, summary: `محتوا ثبت شد (${cid.slice(-6)}) · ${entities} موجودیت` };
    }

    case "approval": {
      // A preview never knocks on anyone's door; it reports what it would ask.
      if (ctx.dry) return { patch: {}, summary: "آزمایشی — بدون پرسش تأیید", branch: node.next ?? [] };
      // Draft first, ask second: the owner must be able to read the thing they
      // are approving, so the content row always exists before the gate.
      const preview = String(bag[String(cfg.from ?? "post")] ?? "").slice(0, 3500);
      const ask = await ctx.tg.sendMessage(
        cfg.to ? String(cfg.to) : ctx.owner_id,
        `🕹 <b>در انتظار تأیید تو</b>\n\n` +
          `<blockquote>${tgEscape(String(bag.policy?.summary ?? "این خروجی آمادهٔ انتشار است"))}</blockquote>\n\n` +
          preview,
        {
          parse_mode: "HTML",
          reply_markup: kb(
            // The run id, not the content id: approving has to resume *this*
            // run, and the run is what knows which content it produced. The
            // handler resolves run→content before publishing, so both buttons
            // on this card still address the same draft.
            [{ text: "✅ تأیید و انتشار", cb: `hos:ok:${bag.run_id ?? ""}` }],
            [{ text: "✏️ ویرایش متن", cb: `hos:edit:${bag.content_id ?? ""}` }, { text: "🗑 رد کردن", cb: `hos:no:${bag.content_id ?? ""}` }],
          ) as any,
        },
      ).catch(() => null as any);
      return {
        wait: true,
        remaining: node.next ?? [],
        patch: { approval_msg: ask?.result?.message_id ?? null },
        summary: "منتظر تأیید انسانی",
      };
    }

    case "connector": {
      const kind = String(cfg.kind ?? "telegram");
      const c = connector(kind);
      if (!c?.act) throw new Error(`connector ${kind} has no actions`);
      /* The one place in the platform that publishes. A dry run stops here with
         a sentence instead of a post, so "test" can never reach the channel. */
      if (ctx.dry) {
        return { patch: { would_publish: String(bag[String(cfg.from ?? "post")] ?? "").slice(0, 200) },
          summary: "آزمایشی — منتشر نشد" };
      }
      const conf = await loadConnectorConfig(ctx.env, ctx.owner_id, kind);
      const out = await c.act({ env: ctx.env, owner_id: ctx.owner_id, config: conf }, String(cfg.action ?? "publish"), {
        ...(cfg.args ?? {}),
        text: cfg.text ? render(String(cfg.text), bag) : String(bag[String(cfg.from ?? "post")] ?? ""),
        markup: cfg.markup === false ? undefined : bag.markup,
        channel: cfg.channel ? render(String(cfg.channel), bag) : conf.channel,
      });
      return { patch: { published: out }, summary: `${kind}.${cfg.action ?? "act"} ✓` };
    }

    case "notify": {
      const to = cfg.to ? String(cfg.to) : String(ctx.owner_id);
      const text = render(String(cfg.text ?? "{{bag.note}}"), bag);
      await ctx.tg.sendMessage(to, text.slice(0, 3800), { parse_mode: "HTML" }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      return { summary: "به مالک اطلاع داده شد" };
    }

    case "delay": {
      const at = Date.now() + Number(cfg.ms ?? 0);
      return { patch: { not_before: at }, summary: `تأخیر ${Math.round(Number(cfg.ms ?? 0) / 1000)}ث` };
    }

    case "stop":
      return { halt: true, summary: "پایان" };

    default:
      return { summary: `گرهٔ ناشناخته: ${node.kind}` };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/** The stored connector row for this owner+kind (config only, never secrets). */
/**
 * Resume a run that parked itself on an approval gate.
 *
 * The whole point of persisting the frontier is that approval is a *pause*, not
 * a re-run: the bag already contains the post that was written, the entities
 * that were indexed and the ids of what was stored, so replaying the DAG from
 * the top would write a second draft of the same release. This restores the bag
 * from the stored run and starts walking at the node recorded in `waiting`.
 *
 * The same run id is reused, which is why `persistRun` falls back to an UPDATE
 * when the INSERT hits the primary key — a resumed run is the same run.
 */
export async function resumeRun(
  ctx: EngineCtx,
  runId: string,
  extra: Record<string, any> = {},
): Promise<RunResult | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT wf_id, input, output, state FROM hub_runs WHERE id=?`,
  ).bind(runId).first<any>().catch(() => null);
  if (!row || row.state !== "waiting") return null;
  const wf = await getWorkflow(ctx.env, row.wf_id);
  if (!wf) return null;
  const bag: Record<string, any> = safeParse(row.output)?.bag ?? {};
  const remaining: string[] = safeParse(row.output)?.waiting?.remaining ?? [];
  if (!remaining.length) return null;

  // Storage trims long bag values (see `trimBag`), so what comes back can be a
  // cut-off copy of what went in — and the nodes behind a gate publish, so a
  // trimmed body would be published trimmed. The content row is the source of
  // truth for both halves of the post; the bag is a cache. Re-read them.
  const cid = String(bag.content_id ?? "");
  if (cid) {
    const stored = await ctx.env.DB.prepare(
      `SELECT body, dna FROM hub_content WHERE id=?`,
    ).bind(cid).first<any>().catch(() => null);
    if (stored) {
      const body = String(stored.body ?? "");
      if (body.length > String(bag.post ?? "").length) bag.post = body;
      const markup = safeParse(stored.dna)?.markup;
      if (markup) bag.markup = markup;
    }
  }

  const input = { ...(safeParse(row.input) ?? {}), ...bag, ...extra };
  return runWorkflow({ ...ctx, resumeFrom: remaining[0] }, wf, input, runId);
}

export async function loadConnectorConfig(env: Env, ownerId: number, kind: string): Promise<Record<string, any>> {
  const r = await env.DB.prepare(
    `SELECT config FROM hub_connectors WHERE owner_id=? AND kind=? AND enabled=1 ORDER BY created_at DESC LIMIT 1`,
  ).bind(ownerId, kind).first<{ config: string }>().catch(() => null);
  try { return JSON.parse(r?.config ?? "{}"); } catch { return {}; }
}

// ── workflow storage ───────────────────────────────────────────────────────

export function parseWorkflow(r: any): Workflow {
  let dag: Workflow["dag"] = { entry: "", nodes: [] };
  try { dag = JSON.parse(r.dag ?? "{}"); } catch { /* keep empty */ }
  if (!Array.isArray(dag.nodes)) dag = { entry: "", nodes: [] };
  return {
    id: r.id, owner_id: r.owner_id, name: r.name, mission: r.mission ?? "",
    dag, on_event: r.on_event ?? "", enabled: r.enabled ?? 1, runs: r.runs ?? 0, created_at: r.created_at,
  };
}

export async function listWorkflows(env: Env, ownerId: number): Promise<Workflow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM hub_workflows WHERE owner_id=? ORDER BY created_at DESC LIMIT 20`)
    .bind(ownerId).all<any>().catch(() => ({ results: [] as any[] }));
  return (results ?? []).map(parseWorkflow);
}

export async function getWorkflow(env: Env, id: string): Promise<Workflow | null> {
  const r = await env.DB.prepare(`SELECT * FROM hub_workflows WHERE id=?`).bind(id).first<any>().catch(() => null);
  return r ? parseWorkflow(r) : null;
}

export async function saveWorkflow(
  env: Env,
  w: { id?: string; owner_id: number; name: string; mission?: string; dag: Workflow["dag"]; on_event?: string; enabled?: number },
): Promise<string> {
  const id = w.id ?? hubId("wf");
  await env.DB.prepare(
    `INSERT INTO hub_workflows (id, owner_id, name, mission, dag, on_event, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, mission=excluded.mission, dag=excluded.dag,
       on_event=excluded.on_event, enabled=excluded.enabled`,
  ).bind(id, w.owner_id, w.name, w.mission ?? "", JSON.stringify(w.dag), w.on_event ?? "", w.enabled ?? 1, Date.now())
    .run().catch((e: any) => console.error("hub-wf-save", String(e?.message ?? e)));
  return id;
}

/**
 * Fan an event out to every workflow that asked for it.
 *
 * Runs are sequential so a slow workflow cannot stampede the AI quota, and each
 * one is isolated: a failure is logged against its own run and the next
 * workflow still gets its turn.
 */
export async function dispatchEvent(ctx: EngineCtx): Promise<RunResult[]> {
  if (!ctx.event) return [];
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM hub_workflows WHERE enabled=1 AND on_event != '' LIMIT 25`,
  ).all<any>().catch(() => ({ results: [] as any[] }));
  const out: RunResult[] = [];
  for (const row of results ?? []) {
    const wf = parseWorkflow(row);
    if (!matches(wf.on_event, ctx.event.type)) continue;
    // A workflow belongs to one owner; an event with no owner is global (system
    // feeds) and should not run another person's workflow.
    if (ctx.event.owner_id != null && wf.owner_id !== ctx.event.owner_id) continue;
    out.push(await runWorkflow({ ...ctx, owner_id: wf.owner_id }, wf, {}, undefined).catch((e: any) => ({
      run_id: "", state: "failed" as const, steps: [], bag: {}, error: String(e?.message ?? e),
    })));
  }
  return out;
}
