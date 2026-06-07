# Plan Mode — Ralph planner front-end

A dedicated, **read-only planner persona** for pi. It produces a
[Ralph](https://github.com/snarktank/ralph)-format `prd.json` that downstream executor
agents (e.g. `ralph.sh`) consume. This is the *plan* half of plan-and-execute — the
execute half stays in Ralph, untouched.

Just the flag is enough — `pi --plan` drops you into the planner and you chat. An
initial message is optional (it only seeds the first turn), and `/explore` is an optional
helper for a focused round: describing your feature in plain chat already starts
exploration, because the persona is active on every turn.

```
pi --plan                                  # then just chat
pi --plan "add a notifications system"     # optional: seeds the first turn
   │
   ├─ planner persona, read-only tools (read, grep, find, ls, safe bash)
   │
   ├─ /explore   interactive advisory loop:
   │             the agent investigates the codebase and helps YOU understand
   │             the request — interpretation, options, implications, impact,
   │             and the decisions you need to make. Commits are recorded.
   │
   ├─ emit_plan  (agent tool) → schema + Ralph-checklist validated
   │             → writes tasks/prd-<branch>.md   ← human review artifact
   │
   └─ /compile-prd <branch>   (user command) → re-validates the reviewed
                 (optionally hand-edited) markdown and writes ./prd.json
                 ← the handoff for ralph.sh
```

## `/compile-prd` — markdown → prd.json

The agent never writes `prd.json` directly. `emit_plan` only produces the human-readable
`tasks/prd-<branch>.md`. You review it (and edit it by hand if you like), then run the
command yourself to compile it into the executor handoff:

- `/compile-prd <branch>` — compile `tasks/prd-<branch>.md` → `prd.json`
- `/compile-prd path/to/prd-foo.md` — compile a specific file
- `/compile-prd` — pick from the `tasks/prd-*.md` files found

The command re-parses the markdown, re-runs schema + Ralph-checklist validation, asks for
confirmation, then writes `prd.json`. Because it parses the file on disk, any manual edits
you make to the PRD are picked up.

## Why a flag, not a toggle

`--plan` is a **persona**, not a mode you flip mid-session. The planner is a different
agent with a read-only contract and a single deliverable (`prd.json`). Booting into it
keeps planning sessions clean and isolated from execution.

## `/explore` — agent → user

Unlike Ralph's PRD clarifying questions (which *extract intent from the user*),
`/explore` flows the other way: the agent **builds the user's understanding** of their
own request. It's an interactive loop — keep exploring until you're confident, then plan.

- `/explore` — continue exploring; surface remaining options/decisions
- `/explore <focus>` — focus the round on a specific concern
- `/decisions` — show what's been recorded so far

Decisions are recorded by the agent via the `record_decision` tool and persisted, so a
resumed planning session keeps its grounding.

## Guardrails

- **Read-only**: `write`/`edit` are blocked; bash is allowlisted to read-only commands.
- **Exploration required**: `emit_plan` is blocked until at least one decision is recorded.
- **Human review always**: `emit_plan` only writes `tasks/prd-<branch>.md`. `prd.json` is
  written exclusively by the `/compile-prd` command after you review the markdown.
- **Schema + checklist validation**: every story must include `Typecheck passes`,
  `branchName` must be `ralph/...`, dependency ordering and story sizing are enforced/warned.

## Output

| File | Purpose |
|------|---------|
| `tasks/prd-<branch>.md` | Human-readable PRD (review gate input) |
| `prd.json` | Machine handoff consumed by `ralph.sh` |

Adjust `PRD_JSON_PATH` / `prdMdPath` in `index.ts` if your `ralph.sh` expects the JSON
elsewhere (Ralph's default is `scripts/ralph/prd.json`).

## Install

```bash
# project-local
mkdir -p .pi/extensions && cp -r plan-execute-mode .pi/extensions/
# or global
cp -r plan-execute-mode ~/.pi/agent/extensions/

# quick test
pi -e ./plan-execute-mode/index.ts --plan "your feature"
```

## Files

| File | Role |
|------|------|
| `index.ts` | Flag, persona, read-only gating, `/explore`, `record_decision`, `emit_plan`, `/compile-prd` |
| `prompts.ts` | Planner persona + explore kickoff instruction |
| `schema.ts` | `prd.json` typebox schema, Ralph-checklist validation, markdown↔plan parse |
| `bash-allowlist.ts` | Read-only bash gating |
