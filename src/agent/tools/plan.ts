import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";
import { addTerms, planVocabularyProblems, plannedFrom } from "../../core/vocabulary.ts";

/** The binding-id reminder riding plan_init's slim content (owner,
 *  2026-10-09): plan_init is the exact moment the node ids become
 *  load-bearing — every later quiz/explain call must reference one. The
 *  field-drop incidents (tools_fails_2) showed the turn's tail is where
 *  discipline slips; the reminder lands right there. */
/** plan_init without a vocabulary is accepted (older callers, tiny maps) but
 *  told what it skipped — the declared vocabulary is what lets the map be
 *  checked for terms used before they are taught. */
const VOCABULARY_MISSING =
	"No vocabulary was given, so the map was not checked for terms used before they are taught. Re-call plan_init with vocabulary (known + per-node introduces/needs) unless this lesson uses no technical terms.";

const PLAN_NODE_IDS_REMINDER =
	"These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/**
 * The plan tool — AUTHOR-ONCE protocol (2026-09-03 design pass): the teacher
 * WRITES the map and never tracks progress. One tool, plan_init, takes the
 * whole dependency map as a mermaid `graph TD` block:
 *
 *   - call it ONCE right after the probe concludes, to present the map (the
 *     LEARNER'S ACCEPTANCE of the presented plan, not this call, ends
 *     planning — docs/probe-teach-split.md §4)
 *   - statuses (current / visited / upcoming) are DERIVED from the quiz
 *     nodeId tags the teacher fires (contracts.ts derivePlanStatuses) — the
 *     teacher never declares them, and there is no "done" bookkeeping
 *   - re-call it any time the map is wrong: the new block replaces the tree
 *     wholesale. Node slugs are permanent — the map tracks nothing between
 *     rewrites
 *   - checks name the node they assess (quiz nodeId, validated against the
 *     live tree at the call boundary) — that tag is the only thing statuses
 *     derive from
 *
 * The former mutation tools (add/update/remove node/edge, set_current,
 * mark_done) are gone by design: restructuring is a rewrite, tracking is
 * derived. SERVER-SIDE with execute: parse → validate → persist. The
 * result is CONTEXT-SLIM (owner, context diet 2026-10-09): the model
 * WROTE the mermaid one message ago, so content never echoes the tree —
 * it carries the validated nodeIds + the binding-nodeId reminder (the
 * exact moment the ids become load-bearing); `details` keeps the full
 * tree for the record and the plan popup (latestTree reads it — the
 * agent-invisible channel, serializer-verified).
 */
const termList = (what: string) => Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: what }));
/** The plan's vocabulary (2026-11): what each node introduces and needs — so a
 *  node can never lean on a term no earlier node teaches. Checked against the
 *  map's edges at the call; a node that needs an untaught term is refused. */
const planVocabularyInput = Type.Object({
	known: termList("Technical terms the learner already holds (from the probe) — usable anywhere without teaching."),
	nodes: Type.Record(
		Type.String(),
		Type.Object({
			introduces: termList("Technical terms this node teaches (their meaning is given here, before they are relied on)."),
			needs: termList("Technical terms this node relies on — each must be known, or introduced by a node that comes before this one."),
		}),
		{ description: "Per node id: { introduces, needs }. Every node that uses technical vocabulary gets an entry." },
	),
}, {
	description:
		"The map's vocabulary: every technical term the lesson will use, where it is taught (introduces), and where it is relied on (needs). " +
		"A node that needs a term must come after (via --> edges) the node that introduces it, or the term must be in known. " +
		"Violations are refused with the list of problems — fix the map or the vocabulary and re-call.",
});

const planInitInput = Type.Object({
	mermaid: Type.String({
		minLength: 1,
		description:
			"A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
			"The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId. " +
			"Titles are free single-line text; `-->` means 'from = prerequisite' (chains fine); no subgraphs, styles, or classes.",
	}),
	vocabulary: Type.Optional(planVocabularyInput),
});

export function planTools(ctx: PlanToolContext): Record<string, AgentTool<any>> {
	return {
		plan_init: {
			name: "plan_init",
			label: "plan_init",
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan window. " +
				"Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid graph block (any direction): one node per line (`slug[Short Title]` — slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), " +
				"`-->` edges meaning 'from must be understood before to' (chains fine). 5–15 nodes: a map, not a syllabus — one reasoning step per node, compress. " +
				"Give `vocabulary` too: the terms the learner already knows, and per node the technical terms it introduces and needs — a node may only need terms that are known or introduced by a node before it (refused otherwise). " +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those tags.",
			parameters: planInitInput,
			execute: serverExecute("plan_init", planInitInput, async ({ mermaid, vocabulary }) => {
				const { chatId, chatStore } = ctx;
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					// No tree echo — the model needs the problems, not a restatement of
					// the map it is rewriting (owner, context diet 2026-10-09).
					return { ok: false, error: parsed.problems.join("\n") };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const next = createTree(parsed.plan.nodes, parsed.plan.edges);
					// The vocabulary gate (2026-11): a node may only need terms that are
					// known or introduced before it. Refused like a structural problem —
					// the teacher fixes and re-calls; nothing is saved.
					if (vocabulary) {
						const problems = planVocabularyProblems(next.nodes.map((n) => n.id), next.edges, vocabulary);
						if (problems.length) return { ok: false, error: "The plan uses terms before teaching them:\n" + problems.join("\n") };
					}
					chatStore.saveTree(chatId, next);
					if (vocabulary) {
						const at = new Date().toISOString();
						chatStore.updateVocabulary?.(chatId, (v) => {
							v.planned = plannedFrom(vocabulary);
							addTerms(v, (vocabulary.known ?? []).map((term) => ({ term, gloss: "", source: "known" as const, at })));
						});
					}
					// Context diet: content = the validated nodeIds + the reminder (the
				// ids just became binding for every quiz/explain call); details =
					// the full tree for the record/UI — the plan popup's latestTree
					// seam, agent-invisible (the serializer sends content only).
					return {
						text: JSON.stringify({
							ok: true,
							nodeIds: next.nodes.map((n) => n.id),
							reminder: PLAN_NODE_IDS_REMINDER,
							...(vocabulary ? {} : { vocabulary: VOCABULARY_MISSING }),
						}),
						details: { ok: true, tree: next },
					};
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message };
					throw err;
				}
			}),
		},
	};
}