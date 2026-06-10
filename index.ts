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
 *     -> chat: agent clarifies decision points interactively (ask_decision picker)
 *              and records every commitment (record_decision); /explore is an
 *              OPTIONAL structured-briefing helper, never a prerequisite
 *     -> agent drafts the PRD as markdown in chat (no file writes)
 *     -> /emit-plan   USER command: validates the draft against the full
 *                     Ralph checklist; on failure the errors are bounced back
 *                     to the planner so it corrects the draft; on success it
 *                     writes tasks/prd-<branch>.md (human review gate, always)
 *     -> /compile-prd USER command: tasks/prd-<branch>.md -> ./prd.json
 *
 * The executor (ralph.sh) is never touched. The only shared contract is prd.json.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafeCommand } from "./bash-allowlist.ts";
import { exploreKickoff, PLANNER_PERSONA } from "./prompts.ts";
import {
	type Decision,
	extractPrdMarkdown,
	parsePrdMarkdown,
	renderPrdMarkdown,
	toPrdJson,
	validatePlan,
} from "./schema.ts";

// Where artifacts land. Adjust to match your ralph.sh location if needed.
const PRD_JSON_PATH = "prd.json";
const prdMdPath = (branch: string) => path.join("tasks", `prd-${branch.replace(/^ralph\//, "")}.md`);

// NOTE: must include this extension's own tools — setActiveTools() deactivates
// anything not listed, including extension-registered tools.
const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "record_decision", "ask_decision"];

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
				: ctx.ui.theme.fg("muted", "📋 planner"),
		);
		const lines =
			decisions.length === 0
				? [ctx.ui.theme.fg("dim", "No decisions yet — they are recorded as you chat (/explore is optional)")]
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

	/** Find the most recent drafted PRD in the current session branch. */
	function findDraftedPrd(ctx: ExtensionContext): string | null {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const text = entry.message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const prd = extractPrdMarkdown(text);
			if (prd) return prd;
		}
		return null;
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
				"📋 Planner mode (read-only). Describe your feature — decisions are recorded as you chat. /explore is an optional deep-dive. Emit the PRD with /emit-plan.",
				"info",
			);
		}
	});

	// Strip write/edit and unsafe bash while planning.
	pi.on("tool_call", async (event) => {
		if (!planEnabled) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: "Planner is read-only. Draft the PRD as markdown in chat; the user emits it with /emit-plan.",
			};
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

	// ── /explore : OPTIONAL interactive advisory loop ───────────────────────────
	pi.registerCommand("explore", {
		description: "Optional: explore the request in depth — options, implications, impact (read-only)",
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
				ctx.ui.notify("No decisions recorded yet. They are recorded automatically as you resolve questions in chat.", "info");
				return;
			}
			const list = decisions
				.map((d, i) => `${i + 1}. ${d.question}\n   → ${d.decision}${d.rationale ? `\n     (${d.rationale})` : ""}`)
				.join("\n");
			ctx.ui.notify(`Recorded decisions:\n${list}`, "info");
		},
	});

	// ── tool: ask_decision (interactive picker — presents options, records pick) ─
	pi.registerTool({
		name: "ask_decision",
		label: "Ask Decision",
		description:
			"Present a decision point to the user as an interactive picker. The user's choice is recorded as a decision automatically. Use this whenever the user must choose between concrete options.",
		parameters: Type.Object({
			question: Type.String({ description: "The decision point / question being resolved" }),
			options: Type.Array(Type.String(), {
				description: "2-5 concrete options the user can pick from (a free-text 'Other' is added automatically)",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "No interactive UI available. Ask the question in chat instead, then record the answer with record_decision.",
						},
					],
				};
			}
			const OTHER = "✎ Other (type an answer)";
			const choice = await ctx.ui.select(params.question, [...params.options, OTHER]);
			if (choice === undefined) {
				return { content: [{ type: "text", text: "User cancelled — no decision recorded." }] };
			}
			let answer = choice;
			if (choice === OTHER) {
				const typed = await ctx.ui.input(params.question, "your answer");
				if (!typed?.trim()) {
					return { content: [{ type: "text", text: "User cancelled — no decision recorded." }] };
				}
				answer = typed.trim();
			}
			decisions.push({ question: params.question, decision: answer });
			persist();
			refreshUi(ctx);
			return {
				content: [{ type: "text", text: `User decided: ${params.question} → ${answer} (recorded)` }],
				details: { decisionCount: decisions.length },
			};
		},
	});

	// ── tool: record_decision (free-form commitments made in chat) ──────────────
	pi.registerTool({
		name: "record_decision",
		label: "Record Decision",
		description:
			"Record a decision the user committed to in chat. Call this immediately whenever the user resolves an option, scope, or direction question — on every interaction where a decision is made.",
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

	// ── /emit-plan : USER command — validate drafted PRD, write tasks/prd-<branch>.md ──
	pi.registerCommand("emit-plan", {
		description: "Validate the PRD the planner drafted in chat and write tasks/prd-<branch>.md",
		handler: async (_args, ctx) => {
			if (!planEnabled) {
				ctx.ui.notify("/emit-plan is only available in planner mode (pi --plan).", "error");
				return;
			}

			const draft = findDraftedPrd(ctx);
			if (!draft) {
				ctx.ui.notify(
					"No drafted PRD found in the conversation. Ask the planner to draft the plan (a `# PRD:` markdown block) first.",
					"error",
				);
				return;
			}

			const plan = parsePrdMarkdown(draft);
			if (!plan.branchName) {
				ctx.ui.notify("Drafted PRD has no parseable **Branch:** line — asking the planner to correct it.", "warning");
				pi.sendUserMessage(
					"[EMIT-PLAN FAILED] The drafted PRD has no parseable **Branch:** `ralph/<kebab-case>` line. Redraft the full corrected PRD as a single fenced markdown block, then I will run /emit-plan again.",
				);
				return;
			}

			// The plan must meet ALL compiling conditions before it can be emitted.
			// On failure, bounce the errors back to the planner so it corrects the draft.
			const { errors, warnings } = validatePlan(plan);
			if (errors.length > 0) {
				ctx.ui.notify(
					`Draft fails compile conditions — asking the planner to correct it:\n- ${errors.join("\n- ")}`,
					"warning",
				);
				pi.sendUserMessage(
					`[EMIT-PLAN FAILED] The drafted PRD does not meet the compile conditions:\n- ${errors.join("\n- ")}\n\nFix these issues and redraft the FULL corrected PRD as a single fenced markdown block, then I will run /emit-plan again.`,
				);
				return;
			}

			// Write the human-readable PRD. The human reviews it, then runs /compile-prd.
			const mdPath = prdMdPath(plan.branchName);
			const absMd = path.resolve(ctx.cwd, mdPath);
			await fs.mkdir(path.dirname(absMd), { recursive: true });
			await fs.writeFile(absMd, renderPrdMarkdown(plan, decisions, warnings), "utf8");

			const branch = plan.branchName.replace(/^ralph\//, "");
			const warnNote = warnings.length ? `\n⚠ ${warnings.map((w) => `- ${w}`).join("\n")}` : "";
			ctx.ui.notify(
				`PRD written to ${mdPath} (${plan.userStories.length} stories).${warnNote}\nReview it, edit by hand if needed, then run /compile-prd ${branch} to produce ${PRD_JSON_PATH}.`,
				warnings.length ? "warning" : "info",
			);
		},
	});

	// ── /compile-prd : transform tasks/prd-<branch>.md → prd.json ────────────────
	pi.registerCommand("compile-prd", {
		description: "Compile a reviewed tasks/prd-<branch>.md into prd.json for the executor",
		handler: async (args, ctx) => {
			const arg = args.trim();
			let mdPath: string;

			if (arg) {
				// Accept a branch name, a bare prd-*.md filename, or a path.
				mdPath = arg.includes("/") || arg.endsWith(".md") ? arg : prdMdPath(arg);
			} else {
				const tasksDir = path.resolve(ctx.cwd, "tasks");
				const found = await fs
					.readdir(tasksDir)
					.then((files) => files.filter((f) => /^prd-.+\.md$/.test(f)))
					.catch(() => [] as string[]);
				if (found.length === 0) {
					ctx.ui.notify("No tasks/prd-*.md files found. Emit or write a PRD first.", "error");
					return;
				}
				const picked = found.length === 1 ? found[0] : await ctx.ui.select("Which PRD do you want to compile?", found);
				if (!picked) return;
				mdPath = path.join("tasks", picked);
			}

			const absMd = path.resolve(ctx.cwd, mdPath);
			let md: string;
			try {
				md = await fs.readFile(absMd, "utf8");
			} catch {
				ctx.ui.notify(`Could not read ${mdPath}.`, "error");
				return;
			}

			const plan = parsePrdMarkdown(md);
			if (!plan.branchName) {
				ctx.ui.notify(`Could not parse a branch name from ${mdPath}. Is it a valid PRD?`, "error");
				return;
			}

			const { errors, warnings } = validatePlan(plan);
			if (errors.length > 0) {
				ctx.ui.notify(`Plan rejected by validation:\n- ${errors.join("\n- ")}`, "error");
				return;
			}

			if (ctx.hasUI) {
				const warnLine = warnings.length ? ` (${warnings.length} warning(s))` : "";
				const choice = await ctx.ui.select(
					`Compile ${mdPath} → ${PRD_JSON_PATH}? ${plan.userStories.length} story(ies)${warnLine}`,
					["✓ Write prd.json", "✗ Cancel"],
				);
				if (!choice?.startsWith("✓")) {
					ctx.ui.notify("Cancelled. prd.json not written.", "info");
					return;
				}
			}

			await fs.writeFile(path.resolve(ctx.cwd, PRD_JSON_PATH), toPrdJson(plan), "utf8");
			const warnNote = warnings.length ? `\n⚠ ${warnings.map((w) => `- ${w}`).join("\n")}` : "";
			ctx.ui.notify(
				`Wrote ${PRD_JSON_PATH} from ${mdPath} (${plan.userStories.length} stories).${warnNote}`,
				warnings.length ? "warning" : "info",
			);
		},
	});

	// keep decisions correct when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		refreshUi(ctx);
	});
}
