# Plan Mode — Ralph planner front-end

A dedicated, **read-only planner persona** for [pi](https://github.com/earendil-works/pi-coding-agent). It produces a [Ralph](https://github.com/snarktank/ralph)-format `prd.json` that downstream executor agents (e.g. `ralph.sh`) consume. This is the *plan* half of plan-and-execute — the execute half stays in Ralph, untouched.

---

## Quick start

```bash
pi --plan                                    # enter planner, then just chat
pi --plan "add a notifications system"       # optional: seed the first turn
```

From there you describe your feature, the agent explores and helps you make decisions, and when you're ready it emits a human-reviewable PRD. You review it, then compile it into the executor handoff.

---

## Architecture overview

| File | Role |
|------|------|
| `index.ts` | Extension entry: `--plan` flag, persona injection, tool/command gating, `/explore`, `/decisions`, `/compile-prd`, `record_decision` tool, `emit_plan` tool, UI status, decision persistence |
| `prompts.ts` | `PLANNER_PERSONA` system prompt (two-phase workflow), `exploreKickoff()` message generator |
| `schema.ts` | TypeBox `PrdSchema`, Ralph-checklist `validatePlan()`, `toPrdJson()`, `parsePrdMarkdown()` (markdown → Prd for compiling) |
| `bash-allowlist.ts` | `isSafeCommand()` — blocks destructive bash patterns, allows read-only commands only |

---

## Workflow

### Phase 1 — Explore (build understanding)

When you enter planner mode, the agent adopts a read-only persona. Its job is to **build your understanding** of your own request before any plan exists.

1. **Describe your feature** — just chat naturally. The planner persona is active on every turn.
2. **`/explore`** (optional helper) — triggers a focused exploration round:
   - `/explore` — surface remaining options/decisions
   - `/explore <focus>` — focus on a specific concern
3. The agent investigates the codebase (read-only), then briefs you with:
   - **Interpretation** — what it understands your request to mean
   - **Options** — 2–3 concrete approaches
   - **Implications** — tradeoffs, constraints, costs for each option
   - **Impact / changes** — files, systems, data, APIs that would change
   - **Decisions needed** — the forks where you must choose
4. When you commit to a decision, the agent calls `record_decision` to log it.
5. **`/decisions`** — view all recorded decisions at any time.

This is an **interactive loop** — keep exploring until you're confident before moving to planning.

### Phase 2 — Plan (emit the PRD)

Once decisions are recorded, the agent converts the agreed direction into a Ralph-format plan and calls `emit_plan`.

**`emit_plan`** writes only `tasks/prd-<branch>.md` — a human-readable markdown document for review. It does **not** write `prd.json` directly.

The markdown document includes:
- Project name, branch name, description
- All recorded exploration decisions
- Ordered user stories with acceptance criteria
- Validation warnings (if any)

### Phase 3 — Review & compile

1. **Review** `tasks/prd-<branch>.md`. Edit by hand if needed.
2. **`/compile-prd`** — compile the reviewed markdown into `prd.json`:
   - `/compile-prd <branch>` — compile `tasks/prd-<branch>.md`
   - `/compile-prd path/to/file.md` — compile a specific file
   - `/compile-prd` — pick interactively from all `tasks/prd-*.md` files

The command re-parses the markdown, re-runs schema + Ralph-checklist validation, asks for confirmation, then writes `prd.json`. Because it parses the file on disk, any manual edits you made are picked up.

---

## Output artifacts

| File | Purpose |
|------|---------|
| `tasks/prd-<branch>.md` | Human-readable PRD — the review gate |
| `prd.json` | Machine handoff consumed by `ralph.sh` |

Adjust `PRD_JSON_PATH` / `prdMdPath` in `index.ts` if your Ralph setup expects the JSON elsewhere.

---

## User story validation rules

The `validatePlan()` function in `schema.ts` enforces Ralph's story-quality checklist on every `emit_plan` and `/compile-prd`:

### Blocking errors (reject the plan)

- `branchName` must start with `ralph/`
- At least one user story required
- No duplicate story IDs
- `passes` must be `false` on emit (executor flips it)
- Every story must have at least one acceptance criterion
- Every story must include `Typecheck passes` as a criterion

### Non-blocking warnings (surfaced, plan accepted)

- ID should follow `US-001` pattern
- `notes` should be empty on emit
- UI-related stories should include `Verify in browser using dev-browser skill`
- Duplicate priorities (ordering may be ambiguous)

### Story ordering

Priority follows dependency order: schema/migrations → backend logic → UI → aggregate views. Stories are sorted by priority in the output.

---

## Guardrails

| Guardrail | Mechanism |
|-----------|-----------|
| **Read-only** | `write` and `edit` tools are blocked in planner mode |
| **Safe bash only** | `bash-allowlist.ts` matches destructive patterns (`rm`, `mv`, `npm install`, `git commit`, etc.) and blocks them; only read-only commands pass |
| **Exploration required** | `emit_plan` is blocked until at least one decision is recorded via `record_decision` |
| **Human review always** | `emit_plan` only writes `tasks/prd-<branch>.md`; `prd.json` is written exclusively by `/compile-prd` after review |
| **Schema validation** | Every plan is validated against `PrdSchema` (TypeBox) + Ralph-checklist on both emit and compile |
| **Decision persistence** | Decisions are saved to the session via `pi.appendEntry` and restored on `session_start` / `session_tree`, so resuming a session keeps its grounding |

---

## UI integration

When planner mode is active, the extension provides:

- **Status bar** — shows `📋 planner · N decision(s)` (success) or `📋 planner · explore first` (warning) if no decisions yet
- **Widget** — `plan-decisions` panel listing all recorded decisions
- **Notifications** — info/warning/error messages for exploration guidance and validation results

---

## Why a flag, not a toggle

`--plan` is a **persona**, not a mode you flip mid-session. The planner is a different agent with a read-only contract and a single deliverable (`prd.json`). Booting into it keeps planning sessions clean and isolated from execution.

---

## `/explore` vs Ralph's clarifying questions

Unlike Ralph's PRD clarifying questions (which *extract intent from the user*), `/explore` flows the other way: the agent **builds the user's understanding** of their own request. It's an interactive advisory loop — the agent investigates the codebase and helps you see options, implications, and decisions you may not have considered.

---

## Install

```bash
# project-local
mkdir -p .pi/extensions && cp -r plan-mode .pi/extensions/

# global
cp -r plan-mode ~/.pi/agent/extensions/

# quick test
pi -e ./plan-mode/index.ts --plan "your feature"
```

---

## Handoff contract: `prd.json`

The planner and executor share exactly one contract:

```json
{
  "project": "string",
  "branchName": "ralph/kebab-case",
  "description": "string",
  "userStories": [
    {
      "id": "US-001",
      "title": "Short descriptive name",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": ["Typecheck passes", "..."],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

The executor (`ralph.sh`) reads `prd.json`, processes stories in priority order, flips `passes` to `true` as it completes them, and fills in `notes`.
