/**
 * prd.json schema + validation.
 *
 * This is the handoff contract consumed by Ralph (ralph.sh). The planner
 * never hand-writes this JSON — it calls the `emit_plan` tool, whose params
 * are validated against this schema PLUS Ralph's story-quality checklist.
 */

import { Type, type Static } from "typebox";

export const UserStorySchema = Type.Object({
	id: Type.String({ description: "Sequential id, e.g. US-001" }),
	title: Type.String({ description: "Short descriptive name" }),
	description: Type.String({ description: "As a [user], I want [feature] so that [benefit]" }),
	acceptanceCriteria: Type.Array(Type.String(), {
		description: "Verifiable checklist. Must include 'Typecheck passes'. UI stories must include browser verification.",
	}),
	priority: Type.Number({ description: "1-based. Dependency order: schema -> backend -> UI." }),
	passes: Type.Boolean({ description: "Always false on emit (executor flips it)." }),
	notes: Type.String({ description: "Empty on emit." }),
});

export const PrdSchema = Type.Object({
	project: Type.String(),
	branchName: Type.String({ description: "kebab-case, prefixed with 'ralph/'" }),
	description: Type.String(),
	userStories: Type.Array(UserStorySchema),
});

export type UserStory = Static<typeof UserStorySchema>;
export type Prd = Static<typeof PrdSchema>;

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

const UI_HINT = /\b(ui|page|component|button|modal|dropdown|badge|screen|view|form|css|style|render|frontend)\b/i;
const TYPECHECK = /typecheck\s+passes/i;
const BROWSER_VERIFY = /verify in browser|dev-browser/i;

/**
 * Run Ralph's story-quality checklist over a plan.
 * Errors block emission; warnings are surfaced but allowed.
 */
export function validatePlan(plan: Prd): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!plan.branchName.startsWith("ralph/")) {
		errors.push(`branchName must start with "ralph/" (got "${plan.branchName}")`);
	}
	if (plan.userStories.length === 0) {
		errors.push("Plan has no user stories.");
	}

	const seenIds = new Set<string>();
	const seenPriorities = new Set<number>();

	plan.userStories.forEach((story, i) => {
		const where = `${story.id || `story #${i + 1}`}`;

		if (!/^US-\d{3,}$/.test(story.id)) {
			warnings.push(`${where}: id should look like US-001.`);
		}
		if (seenIds.has(story.id)) {
			errors.push(`${where}: duplicate id.`);
		}
		seenIds.add(story.id);

		if (story.passes !== false) {
			errors.push(`${where}: passes must be false on emit.`);
		}
		if (story.notes !== "") {
			warnings.push(`${where}: notes should be empty on emit.`);
		}
		if (story.acceptanceCriteria.length === 0) {
			errors.push(`${where}: needs at least one acceptance criterion.`);
		}
		if (!story.acceptanceCriteria.some((c) => TYPECHECK.test(c))) {
			errors.push(`${where}: must include "Typecheck passes" as a criterion.`);
		}

		const looksUi = UI_HINT.test(story.title) || UI_HINT.test(story.description);
		const hasBrowserVerify = story.acceptanceCriteria.some((c) => BROWSER_VERIFY.test(c));
		if (looksUi && !hasBrowserVerify) {
			warnings.push(`${where}: looks UI-related but has no "Verify in browser using dev-browser skill" criterion.`);
		}

		if (seenPriorities.has(story.priority)) {
			warnings.push(`${where}: priority ${story.priority} is reused (ordering may be ambiguous).`);
		}
		seenPriorities.add(story.priority);
	});

	return { errors, warnings };
}

/** Normalize a plan into the exact on-disk prd.json shape Ralph expects. */
export function toPrdJson(plan: Prd): string {
	const ordered = [...plan.userStories].sort((a, b) => a.priority - b.priority);
	return `${JSON.stringify({ ...plan, userStories: ordered }, null, 2)}\n`;
}

/**
 * Parse a human-reviewed `tasks/prd-<branch>.md` back into a Prd.
 *
 * This is the inverse of `renderPrdMarkdown` in index.ts. The markdown does not
 * carry priority / passes / notes, so we reconstruct them: priority follows the
 * (dependency-ordered) document order, passes is always false, notes is empty.
 */
export function parsePrdMarkdown(md: string): Prd {
	const project = (md.match(/^#\s+PRD:\s*(.+)$/m)?.[1] ?? "").trim();
	const branchName = (md.match(/\*\*Branch:\*\*\s*`([^`]+)`/)?.[1] ?? "").trim();

	// Description: everything between the Branch line and the first "## " heading.
	const afterBranch = md.split(/\*\*Branch:\*\*\s*`[^`]+`/)[1] ?? "";
	const description = afterBranch.split(/\n##\s/)[0].trim();

	// User Stories section: between "## User Stories" and the next "## " or the trailing "---".
	const storiesSection = md.split(/##\s+User Stories\s*\n/)[1] ?? "";
	const storiesBody = storiesSection.split(/\n##\s/)[0].split(/\n---/)[0];

	const userStories: UserStory[] = `\n${storiesBody}`
		.split(/\n###\s+/)
		.slice(1)
		.map((block, idx): UserStory => {
			const header = block.match(/^([^\n:]+):\s*(.+)/);
			const id = header ? header[1].trim() : `US-${String(idx + 1).padStart(3, "0")}`;
			const title = header ? header[2].trim() : "";
			const description = block.match(/\*\*Description:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
			const acIndex = block.indexOf("**Acceptance Criteria:**");
			const acBlock = acIndex >= 0 ? block.slice(acIndex) : "";
			const acceptanceCriteria = [...acBlock.matchAll(/^\s*-\s*\[[ xX]?\]\s+(.+)$/gm)].map((m) => m[1].trim());
			return { id, title, description, acceptanceCriteria, priority: idx + 1, passes: false, notes: "" };
		});

	return { project, branchName, description, userStories };
}
