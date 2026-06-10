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
 *     -> /explore     interactive advisory loop (agent helps the USER understand
 *                     options/implications/changes; decisions are recorded)
 *     -> agent drafts the PRD as markdown in chat (no file writes)
 *     -> /emit-plan   USER command: validates the draft against the full
 *                     Ralph checklist (same conditions as compiling) and
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

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash"];

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
				"📋 Planner mode (read-only). Describe your feature to start exploring — or use /explore for a focused round.",
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

	// ── /emit-plan : USER command — validate drafted PRD, write tasks/prd-<branch>.md ──
	pi.registerCommand("emit-plan", {
		description: "Validate the PRD the planner drafted in chat and write tasks/prd-<branch>.md",
		handler: async (_args, ctx) => {
			if (!planEnabled) {
				ctx.ui.notify("/emit-plan is only available in planner mode (pi --plan).", "error");
				return;
			}
			if (decisions.length === 0) {
				ctx.ui.notify("Blocked: no decisions recorded. Run an /explore round and record decisions first.", "error");
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
				ctx.ui.notify("Drafted PRD has no parseable **Branch:** line. Ask the planner to redraft it.", "error");
				return;
			}

			// The plan must meet ALL compiling conditions before it can be emitted.
			const { errors, warnings } = validatePlan(plan);
			if (errors.length > 0) {
				ctx.ui.notify(
					`Plan does not meet compile conditions — not emitted:\n- ${errors.join("\n- ")}\nAsk the planner to fix the draft, then run /emit-plan again.`,
					"error",
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
