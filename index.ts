/**
 * Plan Mode (Ralph planner front-end)
 *
 * `pi --plan "<feature / user story / issue>"` boots a dedicated, read-only PLANNER
 * persona whose only deliverable is a Ralph-format `prd.json` for downstream executor
 * agents (e.g. ralph.sh).
 *
 * Flow:
 *   pi --plan "add notifications"
 *     -> planner persona, read-only tools
 *     -> /explore   interactive advisory loop (agent helps the USER understand
 *                   options/implications/changes; decisions are recorded)
 *     -> emit_plan  schema + Ralph-checklist validated
 *                   -> writes tasks/prd-<branch>.md  (human review gate, always)
 *                   -> on approval writes ./prd.json (the handoff; ralph.sh consumes it)
 *
 * The executor (ralph.sh) is never touched. The only shared contract is prd.json.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafeCommand } from "./bash-allowlist.ts";
import { exploreKickoff, PLANNER_PERSONA } from "./prompts.ts";
import { type Prd, PrdSchema, toPrdJson, validatePlan } from "./schema.ts";

// Where artifacts land. Adjust to match your ralph.sh location if needed.
const PRD_JSON_PATH = "prd.json";
const prdMdPath = (branch: string) => path.join("tasks", `prd-${branch.replace(/^ralph\//, "")}.md`);

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash"];

interface Decision {
	question: string;
	decision: string;
	rationale?: string;
}

export default function planMode(pi: ExtensionAPI): void {
	let planEnabled = false;
	let decisions: Decision[] = [];

	pi.registerFlag("plan", {
		description: "Boot as a read-only Ralph planner (produces prd.json)",
		type: "boolean",
		default: false,
	});

	// ── helpers ────────────────────────────────────────────────────────────────
	function refreshUi(ctx: ExtensionContext): void {
		if (!planEnabled) {
			ctx.ui.setStatus("plan", undefined);
			ctx.ui.setWidget("plan-decisions", undefined);
			return;
		}
		const ready = decisions.length > 0;
		ctx.ui.setStatus(
			"plan",
			ready
				? ctx.ui.theme.fg("success", `📋 planner · ${decisions.length} decision(s)`)
				: ctx.ui.theme.fg("warning", "📋 planner · explore first"),
		);
		const lines =
			decisions.length === 0
				? [ctx.ui.theme.fg("dim", "No decisions yet — run /explore")]
				: decisions.map((d, i) => `${ctx.ui.theme.fg("accent", `${i + 1}.`)} ${d.question} → ${ctx.ui.theme.fg("muted", d.decision)}`);
		ctx.ui.setWidget("plan-decisions", lines);
	}

	function persist(): void {
		pi.appendEntry("plan-decisions", { decisions });
	}

	function restore(ctx: ExtensionContext): void {
		decisions = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "plan-decisions") {
				const data = (entry as { data?: { decisions?: Decision[] } }).data;
				if (data?.decisions) decisions = data.decisions;
			}
		}
	}

	// ── lifecycle: enter planner persona on --plan ──────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planEnabled = true;
		if (!planEnabled) return;
		restore(ctx);
		pi.setActiveTools(PLAN_TOOLS);
		refreshUi(ctx);
		if (decisions.length === 0) {
			ctx.ui.notify(
				"📋 Planner mode (read-only). Describe your feature to start exploring — or use /explore for a focused round.",
				"info",
			);
		}
	});

	// Strip write/edit and unsafe bash while planning.
	pi.on("tool_call", async (event) => {
		if (!planEnabled) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			return { block: true, reason: "Planner is read-only. Produce a plan with emit_plan instead of editing files." };
		}
		if (event.toolName === "bash" && !isSafeCommand(String(event.input.command ?? ""))) {
			return { block: true, reason: "Planner allows read-only bash only." };
		}
	});

	// Layer the planner persona onto the system prompt every turn.
	pi.on("before_agent_start", async (event) => {
		if (!planEnabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLANNER_PERSONA}` };
	});

	// ── /explore : interactive advisory loop ────────────────────────────────────
	pi.registerCommand("explore", {
		description: "Interactively explore the request — options, implications, impact (read-only)",
		handler: async (args, ctx) => {
			if (!planEnabled) {
				ctx.ui.notify("Explore is only available in planner mode (pi --plan).", "error");
				return;
			}
			pi.sendUserMessage(exploreKickoff(args.trim()));
		},
	});

	// ── /decisions : show recorded decisions ────────────────────────────────────
	pi.registerCommand("decisions", {
		description: "Show decisions recorded during exploration",
		handler: async (_args, ctx) => {
			if (decisions.length === 0) {
				ctx.ui.notify("No decisions recorded yet. Run /explore.", "info");
				return;
			}
			const list = decisions
				.map((d, i) => `${i + 1}. ${d.question}\n   → ${d.decision}${d.rationale ? `\n     (${d.rationale})` : ""}`)
				.join("\n");
			ctx.ui.notify(`Recorded decisions:\n${list}`, "info");
		},
	});

	// ── tool: record_decision (called by the agent during exploration) ──────────
	pi.registerTool({
		name: "record_decision",
		label: "Record Decision",
		description:
			"Record a decision the user committed to during exploration. Call this whenever the user resolves an option or scope question.",
		parameters: Type.Object({
			question: Type.String({ description: "The decision point / question being resolved" }),
			decision: Type.String({ description: "What the user decided" }),
			rationale: Type.Optional(Type.String({ description: "Why (optional)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			decisions.push({ question: params.question, decision: params.decision, rationale: params.rationale });
			persist();
			refreshUi(ctx);
			return {
				content: [{ type: "text", text: `Recorded decision: ${params.question} → ${params.decision}` }],
				details: { decisionCount: decisions.length },
			};
		},
	});

	// ── tool: emit_plan (gated by exploration + human review) ───────────────────
	pi.registerTool({
		name: "emit_plan",
		label: "Emit Plan",
		description:
			"Emit the final Ralph-format plan. Only call after exploration has recorded decisions. Writes a human-reviewable PRD.md, then prd.json after the human approves.",
		parameters: PrdSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const plan = params as Prd;

			if (decisions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Blocked: no decisions recorded. Run an /explore round and record decisions before emitting a plan.",
						},
					],
					isError: true,
				};
			}

			const { errors, warnings } = validatePlan(plan);
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `Plan rejected by validation:\n- ${errors.join("\n- ")}` }],
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "emit_plan requires interactive mode for the human review gate." }],
					isError: true,
				};
			}

			// Write the human-readable PRD first (review gate input).
			const mdPath = prdMdPath(plan.branchName);
			await fs.mkdir(path.dirname(path.resolve(ctx.cwd, mdPath)), { recursive: true });
			await fs.writeFile(path.resolve(ctx.cwd, mdPath), renderPrdMarkdown(plan, decisions, warnings), "utf8");

			const warnLine = warnings.length ? `\n⚠ ${warnings.length} warning(s) — see ${mdPath}` : "";
			const choice = await ctx.ui.select(
				`Plan written to ${mdPath}. Review it, then:`,
				["✓ Approve — write prd.json", "✗ Reject — revise"],
			);

			if (!choice?.startsWith("✓")) {
				return {
					content: [{ type: "text", text: `Human rejected the plan. Revise and emit again. (${mdPath} kept for reference.)` }],
					isError: true,
				};
			}

			await fs.writeFile(path.resolve(ctx.cwd, PRD_JSON_PATH), toPrdJson(plan), "utf8");
			return {
				content: [
					{
						type: "text",
						text: `Plan approved.\n- ${mdPath} (human PRD)\n- ${PRD_JSON_PATH} (executor handoff)${warnLine}\nReady for the executor (ralph.sh).`,
					},
				],
				details: { stories: plan.userStories.length, warnings },
			};
		},
	});

	// keep decisions correct when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		refreshUi(ctx);
	});
}

// ── PRD.md renderer (human review artifact) ───────────────────────────────────
function renderPrdMarkdown(plan: Prd, decisions: Decision[], warnings: string[]): string {
	const stories = [...plan.userStories]
		.sort((a, b) => a.priority - b.priority)
		.map(
			(s) =>
				`### ${s.id}: ${s.title}\n**Description:** ${s.description}\n\n**Acceptance Criteria:**\n${s.acceptanceCriteria
					.map((c) => `- [ ] ${c}`)
					.join("\n")}\n`,
		)
		.join("\n");

	const decisionsMd = decisions.length
		? decisions.map((d) => `- **${d.question}** → ${d.decision}${d.rationale ? ` _(${d.rationale})_` : ""}`).join("\n")
		: "_none_";

	const warningsMd = warnings.length ? `\n## ⚠ Validation Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : "";

	return `# PRD: ${plan.project}

**Branch:** \`${plan.branchName}\`

${plan.description}

## Decisions from Exploration
${decisionsMd}

## User Stories
${stories}
${warningsMd}
---
_Review this document. Approving in pi writes \`${PRD_JSON_PATH}\` for the executor._
`;
}
