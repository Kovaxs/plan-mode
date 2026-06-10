# AGENT.md

## Project

**plan-mode** — a [pi](https://github.com/earendil-works/pi-coding-agent) extension that boots a read-only planner persona (`pi --plan`). It produces a Ralph-format `prd.json` for downstream executor agents (`ralph.sh`). This repo is the *plan* half of plan-and-execute; the executor is never touched. See `README.md` for the full workflow.

## Commands

```bash
node --test schema.test.ts                  # run unit tests (8 tests, no deps)
pi -e ./index.ts --plan "your feature"      # run the extension ad hoc
```

There is no `package.json`, no build step, no bundler. TypeScript files are loaded directly by pi (extension) and Node's test runner (`.ts` via type stripping).

## Files

| File | Role |
|------|------|
| `index.ts` | Extension entry point: `--plan` flag, persona injection, tool/bash gating, `/explore`, `/decisions`, `/emit-plan`, `/compile-prd`, `ask_decision` + `record_decision` tools, status bar/widget, decision persistence via session entries |
| `prompts.ts` | `PLANNER_PERSONA` system prompt (clarify-as-you-chat → draft, compile self-check, example .md/.json artifacts) and `exploreKickoff()` |
| `schema.ts` | **Dependency-free** PRD contract: `Prd`/`UserStory`/`Decision` types, `validatePlan()`, `extractPrdMarkdown()`, `parsePrdMarkdown()`, `renderPrdMarkdown()`, `toPrdJson()` |
| `schema.test.ts` | Unit tests for the full emit pipeline (extract → parse → validate → render → re-parse → JSON) |
| `bash-allowlist.ts` | `isSafeCommand()` — deny destructive patterns, then allow only known read-only commands |

## Architecture invariants — do not break these

1. **`schema.ts` stays dependency-free.** No TypeBox, no pi imports, no node builtins. It must remain testable with bare `node --test`. Only `index.ts` may import from pi / TypeBox.
2. **The agent never writes files.** The planner drafts the PRD as a fenced ```` ```markdown ```` block in chat. Files land on disk only via USER commands: `/emit-plan` writes `tasks/prd-<branch>.md`; `/compile-prd` writes `prd.json`. Never give the planner persona write access or have it call write tools.
3. **`/emit-plan` and `/compile-prd` enforce the same `validatePlan()` checklist.** When `/emit-plan` finds errors it writes nothing and bounces the error list back to the planner via `pi.sendUserMessage("[EMIT-PLAN FAILED] ...")` so it redrafts. If you change validation rules, both paths inherit them automatically — keep it that way.
3c. **A pre-existing draft is NOT required for `/emit-plan`.** If no `# PRD:` block exists in the chat, the command sends an `[EMIT-PLAN]` draft request and auto-resumes via the `agent_end` hook (`pendingEmit` counter, `EMIT_ATTEMPTS` budget). Keep the retry budget bounded — the draft/fix loop must never ping-pong indefinitely. The `agent_end` handler must stay a no-op when `pendingEmit === 0` or planner mode is off.
3a. **`/explore` and recorded decisions are OPTIONAL.** `/emit-plan` must never block on `decisions.length`. Decisions are recorded continuously during chat (`ask_decision` interactive picker for option forks, `record_decision` for free-form commitments) and flushed into the PRD on emit; zero decisions renders `_none_`.
3b. **`PLAN_TOOLS` must include this extension's own tools.** `pi.setActiveTools()` deactivates anything not listed — omitting `record_decision`/`ask_decision` silently breaks decision recording (this was a real bug).
4. **Markdown round-trip is the contract.** `renderPrdMarkdown()` and `parsePrdMarkdown()` must remain inverses (modulo priority/passes/notes, which are reconstructed: priority = document order, `passes: false`, `notes: ""`). The on-chat draft template in `prompts.ts`, the parser in `schema.ts`, and the README example must all stay in sync.
5. **`prd.json` shape is Ralph's contract.** `{ project, branchName, userStories: [{ id, title, description, acceptanceCriteria, priority, passes, notes }] }`, stories sorted by priority. Don't change it without changing the executor.
6. **Bash allowlist is deny-first.** A command must both avoid all `DESTRUCTIVE_PATTERNS` and match a `SAFE_PATTERNS` entry. Unknown commands are blocked by default — preserve that.

## Validation rules (in `validatePlan()`)

- **Errors (block emit/compile):** `branchName` must start with `ralph/`; ≥1 story; no duplicate IDs; `passes === false`; ≥1 acceptance criterion per story; every story includes "Typecheck passes".
- **Warnings (surfaced, allowed):** ID not `US-001`-shaped; non-empty `notes`; UI-looking story without "Verify in browser using dev-browser skill"; duplicate priorities.

## Conventions

- Tabs for indentation, double quotes, semicolons, trailing commas (match existing files).
- Comments use the `// ── section ──...` divider style in `index.ts`.
- Decision state lives in `index.ts` module scope and is persisted/restored via `pi.appendEntry("plan-decisions", ...)` and `session_start` / `session_tree` handlers — keep restore idempotent (last entry wins).
- Interactive dialogs in tools: guard with `ctx.hasUI`; `ctx.ui.select()` returns `undefined` on cancel/timeout. `ask_decision` appends an "✎ Other (type an answer)" option backed by `ctx.ui.input()`.
- Output paths are constants at the top of `index.ts` (`PRD_JSON_PATH`, `prdMdPath`).

## When changing things

- Adding/changing a validation rule → update `schema.ts`, add a test in `schema.test.ts`, update the rules list in `README.md` (and this file).
- Changing the PRD template → update `prompts.ts` (persona template **and** its example artifacts), `schema.ts` (parser/renderer), `schema.test.ts` fixtures, and `README.md` (template + Example artifacts section) in lockstep.
- Adding a tool via `pi.registerTool` → also add its name to `PLAN_TOOLS` or it will be inactive in planner mode.
- Always run `node --test schema.test.ts` after touching `schema.ts` or `schema.test.ts`.
- For pi API questions (events, commands, tools, UI), consult the pi docs listed in the system prompt rather than guessing.
