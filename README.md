# Plan Mode — Ralph planner front-end

A dedicated, **read-only planner persona** for [pi](https://github.com/earendil-works/pi-coding-agent). It produces a [Ralph](https://github.com/snarktank/ralph)-format `prd.json` that downstream executor agents (e.g. `ralph.sh`) consume. This is the *plan* half of plan-and-execute — the execute half stays in Ralph, untouched.

---

## Quick start

```bash
pi --plan                                    # enter planner, then just chat
pi --plan "add a notifications system"       # optional: seed the first turn
```

From there you describe your feature, the agent explores and helps you make decisions, then drafts a PRD in chat. You emit it with `/emit-plan` (validated against the full compile checklist), review the markdown, then compile it into the executor handoff with `/compile-prd`.

---

## Architecture overview

| File | Role |
|------|------|
| `index.ts` | Extension entry: `--plan` flag, persona injection, tool/command gating, `/explore`, `/decisions`, `/emit-plan`, `/compile-prd`, `record_decision` tool, UI status, decision persistence |
| `prompts.ts` | `PLANNER_PERSONA` system prompt (two-phase workflow: explore → draft), `exploreKickoff()` message generator |
| `schema.ts` | **Dependency-free** PRD contract: types (`Prd`, `UserStory`, `Decision`), `validatePlan()` (Ralph checklist), `extractPrdMarkdown()` (chat draft → markdown), `parsePrdMarkdown()` (markdown → Prd), `renderPrdMarkdown()` (Prd → `tasks/prd-<branch>.md`), `toPrdJson()` (Prd → `prd.json`) |
| `schema.test.ts` | 8 unit tests covering the full `/emit-plan` pipeline |
| `bash-allowlist.ts` | `isSafeCommand()` — blocks destructive bash patterns, allows read-only commands only |

### Data flow

```
User describes feature
        │
        ▼
  ┌─ /explore ─┐  read-only codebase investigation
  │  briefing   │  → Interpretation, Options, Implications, Impact, Decisions
  │  decisions  │  → user commits → record_decision tool
  └─────────────┘
        │
        ▼
  Agent drafts PRD as fenced ```markdown block in chat (cannot write files)
        │
        ▼
  ┌─ /emit-plan ─┐  USER command (not the agent)
  │  find draft   │  → scans assistant messages for # PRD: block
  │  parse +      │  → parsePrdMarkdown() → Prd
  │  validate     │  → validatePlan() — must pass ALL compile conditions
  │  write        │  → tasks/prd-<branch>.md  (human review gate)
  └───────────────┘
        │
        ▼
  User reviews (and optionally hand-edits) tasks/prd-<branch>.md
        │
        ▼
  ┌─ /compile-prd ─┐  USER command
  │  re-parse       │  → tasks/prd-<branch>.md → Prd
  │  re-validate    │  → validatePlan() (same checklist, always passes)
  │  write          │  → prd.json  (Ralph handoff)
  └─────────────────┘
        │
        ▼
  ralph.sh reads prd.json, executes stories, flips passes: true
```

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

### Phase 2 — Draft the PRD

Once decisions are recorded, you ask the agent to draft the plan. The agent converts the agreed direction into a Ralph-format PRD and presents it as a **fenced `` ```markdown `` code block** in chat. It follows an exact template:

~~~markdown
```markdown
# PRD: <project name>

**Branch:** `ralph/<kebab-case-branch>`

<one-paragraph description>

## User Stories

### US-001: <title>
**Description:** As a <user>, I want <feature> so that <benefit>

**Acceptance Criteria:**
- [ ] <verifiable criterion>
- [ ] Typecheck passes
```
~~~

Story order = priority order. Every story must include "Typecheck passes". UI stories must include "Verify in browser using dev-browser skill". The planner is read-only — **it cannot write files**.

### Phase 3 — Emit the PRD (user command)

Emitting is an **explicit user command**, not something the agent does:

**`/emit-plan`** —

1. Scans the conversation for the most recent assistant message containing a `# PRD:` markdown block.
2. Parses it into a structured `Prd` via `parsePrdMarkdown()`.
3. Runs `validatePlan()` — the **exact same Ralph checklist that `/compile-prd` enforces**. If any compile condition fails (missing `ralph/` prefix, no stories, duplicate IDs, missing "Typecheck passes", `passes !== false`, etc.), the plan is **rejected** with the full error list. Nothing is written.
4. On success, renders and writes `tasks/prd-<branch>.md` — a normalized markdown document including project metadata, recorded exploration decisions, ordered user stories, and any validation warnings.

If the user wants changes, they ask the agent to revise the draft, then run `/emit-plan` again.

### Phase 4 — Review & compile

1. **Review** `tasks/prd-<branch>.md`. Edit by hand if needed.
2. **`/compile-prd`** — compile the reviewed markdown into `prd.json`:
   - `/compile-prd <branch>` — compile `tasks/prd-<branch>.md`
   - `/compile-prd path/to/file.md` — compile a specific file
   - `/compile-prd` — pick interactively from all `tasks/prd-*.md` files

The command re-parses the markdown, re-runs schema + Ralph-checklist validation, asks for confirmation, then writes `prd.json`. Because it parses the file on disk, any manual edits you made are picked up.

---

## Output artifacts

| File | Produced by | Purpose |
|------|-------------|---------|
| `tasks/prd-<branch>.md` | `/emit-plan` | Human-readable PRD — the review gate |
| `prd.json` | `/compile-prd` | Machine handoff consumed by `ralph.sh` |

Adjust `PRD_JSON_PATH` / `prdMdPath` in `index.ts` if your Ralph setup expects the JSON elsewhere.

---

## User story validation rules

The `validatePlan()` function in `schema.ts` enforces Ralph's story-quality checklist on every `/emit-plan` and `/compile-prd` — a plan that cannot compile cannot be emitted:

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
| **Read-only** | `write` and `edit` tools are blocked in planner mode — the agent can only draft the PRD in chat |
| **Safe bash only** | `bash-allowlist.ts` matches destructive patterns (`rm`, `mv`, `npm install`, `git commit`, etc.) and blocks them; only read-only commands pass |
| **Human emits, not the agent** | The PRD only lands on disk when the USER runs `/emit-plan` — the agent never calls a write tool |
| **Exploration required** | `/emit-plan` is blocked until at least one decision is recorded via `record_decision` |
| **Compile conditions gate emission** | `/emit-plan` runs the exact same `validatePlan()` checklist as `/compile-prd`; drafts with errors are rejected |
| **Human review always** | `/emit-plan` only writes `tasks/prd-<branch>.md`; `prd.json` is written exclusively by `/compile-prd` after review |
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

## Tests

`schema.ts` is **dependency-free** (no TypeBox, no pi imports), so the entire emit pipeline is unit-testable directly with Node's built-in test runner:

```bash
node --test schema.test.ts
```

**8 tests, all passing:**

| Test | What it covers |
|------|----------------|
| `extractPrdMarkdown` — fenced block | Pulls the PRD out of a ` ```markdown ` fenced chat draft |
| `extractPrdMarkdown` — unfenced fallback | Falls back to an unfenced `# PRD:` heading |
| `extractPrdMarkdown` — no PRD | Returns `null` when no PRD is present in the text |
| `parsePrdMarkdown` round-trip | Reconstructs the full Ralph contract (ids, priorities, criteria) |
| Valid draft → no errors | A well-formed draft meets all compile conditions |
| Compile conditions fail | Catches: missing Typecheck, bad branch prefix, no stories, duplicate IDs |
| Full pipeline | chat draft → extract → parse → validate → render `tasks/prd-<branch>.md` → re-parse → `prd.json` matching Ralph's contract |
| Priority ordering | `toPrdJson()` sorts stories by priority regardless of input order |

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
