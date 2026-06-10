/**
 * prd.json contract + validation + markdown round-trip.
 *
 * This is the handoff contract consumed by Ralph (ralph.sh). The planner agent
 * never writes files — it drafts the PRD as markdown in chat; the HUMAN runs
 * `/emit-plan`, which validates against Ralph's story-quality checklist (the
 * same conditions `/compile-prd` enforces) and writes `tasks/prd-<branch>.md`.
 *
 * This module is dependency-free on purpose so it can be unit-tested directly
 * with `node --test`.
 */

export interface UserStory {
	/** Sequential id, e.g. US-001 */
	id: string;
	/** Short descriptive name */
	title: string;
	/** As a [user], I want [feature] so that [benefit] */
	description: string;
	/** Verifiable checklist. Must include 'Typecheck passes'. UI stories must include browser verification. */
	acceptanceCriteria: string[];
	/** 1-based. Dependency order: schema -> backend -> UI. */
	priority: number;
	/** Always false on emit (executor flips it). */
	passes: boolean;
	/** Empty on emit. */
	notes: string;
}

export interface Prd {
	project: string;
	/** kebab-case, prefixed with 'ralph/' */
	branchName: string;
	description: string;
	userStories: UserStory[];
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

const UI_HINT = /\b(ui|page|component|button|modal|dropdown|badge|screen|view|form|css|style|render|frontend)\b/i;
const TYPECHECK = /typecheck\s+passes/i;
const BROWSER_VERIFY = /verify in browser|dev-browser/i;

/**
 * Run Ralph's story-quality checklist over a plan.
 * Errors block emission/compilation; warnings are surfaced but allowed.
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

export interface Decision {
	question: string;
	decision: string;
	rationale?: string;
}

/** Render the human-review PRD markdown (`tasks/prd-<branch>.md`). */
export function renderPrdMarkdown(plan: Prd, decisions: Decision[], warnings: string[]): string {
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
_Review this document, edit by hand if needed, then run \`/compile-prd\` to produce \`prd.json\` for the executor._
`;
}

/**
 * Extract a drafted PRD (markdown) from an assistant chat message.
 *
 * The planner persona drafts the plan inside a fenced \`\`\`markdown block whose
 * body starts with `# PRD:`. Falls back to an unfenced `# PRD:` heading.
 * Returns null when the text contains no PRD.
 */
export function extractPrdMarkdown(text: string): string | null {
	const fences = [...text.matchAll(/```(?:markdown|md)?[ \t]*\n([\s\S]*?)```/g)];
	for (let i = fences.length - 1; i >= 0; i--) {
		const body = fences[i][1];
		if (/^#\s+PRD:/m.test(body)) return body.trim();
	}
	const match = text.match(/^#\s+PRD:[\s\S]*/m);
	return match ? match[0].trim() : null;
}

/**
 * Parse a PRD markdown document (drafted in chat or reviewed on disk) into a Prd.
 *
 * This is the inverse of `renderPrdMarkdown`. The markdown does not carry
 * priority / passes / notes, so we reconstruct them: priority follows the
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
