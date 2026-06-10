/**
 * Tests for the /emit-plan pipeline:
 *   agent chat draft → extractPrdMarkdown → parsePrdMarkdown → validatePlan
 *   → renderPrdMarkdown (tasks/prd-<branch>.md) → parsePrdMarkdown → toPrdJson
 *
 * Run:  node --test schema.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractPrdMarkdown,
	parsePrdMarkdown,
	renderPrdMarkdown,
	toPrdJson,
	validatePlan,
	type Prd,
} from "./schema.ts";

const DRAFT = `# PRD: MyApp

**Branch:** \`ralph/task-priority\`

Task Priority System - Add priority levels to tasks

## User Stories

### US-001: Add priority field to database
**Description:** As a developer, I need to store task priority so it persists across sessions.

**Acceptance Criteria:**
- [ ] Add priority column to tasks table: 'high' | 'medium' | 'low' (default 'medium')
- [ ] Generate and run migration successfully
- [ ] Typecheck passes

### US-002: Display priority indicator on task cards
**Description:** As a user, I want to see task priority at a glance.

**Acceptance Criteria:**
- [ ] Each task card shows colored priority badge (red=high, yellow=medium, gray=low)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill
`;

const CHAT_MESSAGE = `Here is the plan based on our decisions:

\`\`\`markdown
${DRAFT}\`\`\`

Run \`/emit-plan\` to emit it.`;

test("extractPrdMarkdown pulls the PRD out of a fenced chat draft", () => {
	const extracted = extractPrdMarkdown(CHAT_MESSAGE);
	assert.ok(extracted);
	assert.ok(extracted.startsWith("# PRD: MyApp"));
	assert.ok(extracted.includes("### US-002"));
	assert.ok(!extracted.includes("```"));
});

test("extractPrdMarkdown falls back to an unfenced # PRD: heading", () => {
	const extracted = extractPrdMarkdown(`Some preamble\n\n${DRAFT}`);
	assert.ok(extracted?.startsWith("# PRD: MyApp"));
});

test("extractPrdMarkdown returns null when no PRD is present", () => {
	assert.equal(extractPrdMarkdown("Just a normal answer with ```code``` in it."), null);
});

test("parsePrdMarkdown reconstructs the Ralph contract from a draft", () => {
	const plan = parsePrdMarkdown(DRAFT);
	assert.equal(plan.project, "MyApp");
	assert.equal(plan.branchName, "ralph/task-priority");
	assert.equal(plan.description, "Task Priority System - Add priority levels to tasks");
	assert.equal(plan.userStories.length, 2);
	const [s1, s2] = plan.userStories;
	assert.equal(s1.id, "US-001");
	assert.equal(s1.priority, 1);
	assert.equal(s1.passes, false);
	assert.equal(s1.notes, "");
	assert.equal(s1.acceptanceCriteria.length, 3);
	assert.equal(s2.id, "US-002");
	assert.equal(s2.priority, 2);
});

test("a valid draft meets all compile conditions (no errors)", () => {
	const { errors } = validatePlan(parsePrdMarkdown(DRAFT));
	assert.deepEqual(errors, []);
});

test("emit is blocked when compile conditions fail", () => {
	// missing "Typecheck passes" on US-001
	const broken = DRAFT.replace("- [ ] Typecheck passes\n", "");
	const { errors } = validatePlan(parsePrdMarkdown(broken));
	assert.ok(errors.some((e) => e.includes('must include "Typecheck passes"')));

	// branch without ralph/ prefix
	const badBranch = DRAFT.replace("`ralph/task-priority`", "`task-priority`");
	assert.ok(validatePlan(parsePrdMarkdown(badBranch)).errors.some((e) => e.includes('must start with "ralph/"')));

	// no stories at all
	const noStories = DRAFT.split("## User Stories")[0];
	assert.ok(validatePlan(parsePrdMarkdown(noStories)).errors.some((e) => e.includes("no user stories")));

	// duplicate ids
	const dupIds = DRAFT.replace("### US-002", "### US-001");
	assert.ok(validatePlan(parsePrdMarkdown(dupIds)).errors.some((e) => e.includes("duplicate id")));
});

test("full /emit-plan pipeline: chat draft → tasks/prd-<branch>.md → prd.json", () => {
	// 1. extract from the assistant chat message
	const extracted = extractPrdMarkdown(CHAT_MESSAGE);
	assert.ok(extracted);

	// 2. parse + validate (the emit gate)
	const plan = parsePrdMarkdown(extracted);
	const { errors, warnings } = validatePlan(plan);
	assert.deepEqual(errors, []);

	// 3. render the review markdown (what /emit-plan writes to tasks/prd-task-priority.md)
	const decisions = [{ question: "Where to store priority?", decision: "DB column", rationale: "persistence" }];
	const md = renderPrdMarkdown(plan, decisions, warnings);
	assert.ok(md.includes("# PRD: MyApp"));
	assert.ok(md.includes("**Branch:** `ralph/task-priority`"));
	assert.ok(md.includes("**Where to store priority?** → DB column"));

	// 4. round-trip: the rendered markdown re-parses to the same plan (/compile-prd input)
	const reparsed = parsePrdMarkdown(md);
	assert.deepEqual(reparsed, plan);

	// 5. prd.json matches the Ralph handoff contract (see prd.json.example in snarktank/ralph)
	const json = JSON.parse(toPrdJson(reparsed));
	assert.deepEqual(Object.keys(json), ["project", "branchName", "description", "userStories"]);
	for (const story of json.userStories) {
		assert.deepEqual(Object.keys(story), [
			"id",
			"title",
			"description",
			"acceptanceCriteria",
			"priority",
			"passes",
			"notes",
		]);
		assert.equal(story.passes, false);
		assert.equal(story.notes, "");
	}
});

test("toPrdJson orders stories by priority", () => {
	const plan: Prd = {
		project: "P",
		branchName: "ralph/x",
		description: "d",
		userStories: [
			{ id: "US-002", title: "b", description: "d", acceptanceCriteria: ["Typecheck passes"], priority: 2, passes: false, notes: "" },
			{ id: "US-001", title: "a", description: "d", acceptanceCriteria: ["Typecheck passes"], priority: 1, passes: false, notes: "" },
		],
	};
	const json = JSON.parse(toPrdJson(plan));
	assert.deepEqual(json.userStories.map((s: { id: string }) => s.id), ["US-001", "US-002"]);
});
