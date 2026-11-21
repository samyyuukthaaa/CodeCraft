# Self-healing and trust features (P4, P5)

All of these run inside the extension; model calls stay in TrueForge. Unit-tested without live model calls; live behaviour of compaction and probes is not yet verified (live runs were paused).

## Error handling per class (`src/trueforge/errors.ts`, `failover.ts`)
| Class | Retries on the same agent | Then |
|---|---|---|
| invalid or revoked key (401/403) | 0 | immediate failover; banner "its API key was rejected (HTTP 401)"; without a fallback: "Provider key rejected ... update it in TrueForge Settings" |
| rate limit, per minute (429) | waits for Retry-After / "retry in N s" (capped 65 s); counts only consecutive failures without progress (3), at most 10 waits per run | failover |
| rate limit, daily quota | 0 | failover; message says the daily quota is used up and when it resets |
| outage / timeout (5xx, connect/headers timeout) | 2 (5 s, 15 s + jitter) | failover |
| bad output (unparseable tool call, empty response) | 1 | failover |
| context too large | 1, with the context rebuilt at a quarter of the budget in a fresh session | failover |
| TLS certificate error | 0 | stop (no failover: a local network problem); clear message |
| Editor tools unreachable (`[MCP Error]`: TrueForge cannot reach CodeCraft's MCP server) | 0 | stop (no failover: every model needs the same server); "reload the window" message; the provider's breaker is not touched |

## Circuit breaker (`src/trueforge/breaker.ts`)
Per provider (the part of the model reference before `/`). Opens after an invalid key (10 min), outage or per-minute rate limit (60 s), daily quota (60 min), or 3 other failures in a row; TLS and editor-tools errors never open it. While open, that provider is skipped and the fallback is used (banner "the primary model ... is paused ..."); after the cooldown the next run or a Test providers probe goes through, and success reports `provider_recovered`.

## Operation IDs and checkpoint resume (`src/journal/journal.ts`, `src/mcp/gate.ts`)
Each applied change set has an operation ID (each file's path and content hash before and after). It is journaled as `op_started` before the write and `op_applied` after; an operation that is already applied and not undone is refused, so a retried run never applies the same edit twice. On a retry or failover the prompt carries what the run already completed (from the journal) so the next model does not redo it.

Every journal entry carries a per-run sequence number. Before EVERY tool call runs, a `tool_call` entry with its own operation ID is written (tool name and paths/queries only, never file content). Where the run is in TrueForge (session ID, turn ID, last event ID) is journaled as `turn_position`; when the stream to CodeCraft is cut, the same turn is resumed after the last event (live subscription, or the turn's persisted events), at most twice per run.

## Fault injection (`src/trueforge/faults.ts`)
For testing failover in the editor: the panel's **Inject fault…** button arms one fault for the next run; the `codecraft.faultInjection` setting applies one to every run. Modes: outage, timeout, malformed tool call, cut stream, invalid key, rate limit. The primary model's first turn then fails with the exact text TrueForge produced for that fault (from `test/fixtures/trueforge-errors.json`); a cut stream drops the real stream after the first model message. Each injection is journaled (`fault_injected`) and shown in the panel. Measured behaviour per fault: [FAILURE_TABLE.md](FAILURE_TABLE.md).

## Provider health panel
The agent panel's **Provider health** section shows, per configured model: role, model, status (healthy, paused until HH:MM, probe pending, unknown), last error class and time. Keys are never shown (CodeCraft never has them). **Test providers** runs one tiny turn per agent through TrueForge and updates the breaker.

## Redaction (`src/util/redact.ts`)
Google, Groq, OpenAI, Anthropic, xAI, AWS, GitHub and Slack key shapes, PEM private keys, Bearer tokens and key/token/password assignments are redacted from everything shown, logged, journaled or sent to the panel. `test/redaction.test.ts` plants fake keys everywhere a run's text can come from and fails if any outbound string contains one (verified by disabling redaction: the test fails). The one deliberate exception is `read_file`, which returns exact file content to the agent so edits match; `.env` and key files are blocked from it entirely.

## Context engineering
TrueForge history compaction with an input-token trigger (48k) on both agents, visible as compaction events in the panel. Rationale and the alternative considered: `docs/TRUEFORGE_NOTES.md`.

## Trust features (P5)
- **Edit journal**: append-only, redacted JSONL in VS Code workspace storage (never in the repository). **CodeCraft: Show Edit Journal** renders runs, plans, applied operations (IDs, files, hunks accepted/rejected), rejections, undos, tests, provider errors and recoveries, model switches, and operations that started but were never confirmed.
- **Safe run_tests**: the configured command is validated (no shell operators or newlines, at most 300 characters) and run as program plus arguments; secret-looking environment variables are removed from the test process; confirmation shows exactly what runs; time limit, output cap, redaction and Stop Run kill remain.
- **Workspace secret scan**: **CodeCraft: Scan Workspace for Secrets** checks every indexed text file with the same rules as redaction and lists `.env*` files; the report has file, line and rule only, never values. Lines marked `secret-scan:allow` are skipped.

### Every change group: reason, plain sentence, confidence, real test status
Shown in the review (quick pick title, placeholder and details) and in the panel's **Changes** section, and journaled (`change_group`) with the operation ID. The reason and the beginner sentence come from the agent (`reason`, `plain` in `propose_changes`); when it gives none, CodeCraft writes the sentence from the facts ("This changes cli.py to add the --env-file option."). The test status is the REAL result: *not run yet*, *passed*, *failed*, *a test that passed before now fails*, or *could not be run*.

**Confidence rule** (`src/trust/confidence.ts`; the first level with a matching rule wins, and every matching rule of that level is shown as the reason):

| Tag | Any of these |
|---|---|
| **risky** | a test that passed before now fails, or the tests fail after the change; touches a file that is not in the submitted plan; deletes a file; changes more than 150 lines or more than 4 files; changes a source file that 10 or more files import |
| **check this** | changes more than 40 lines; changes an existing source file that no test is related to; changes a source file that 3 or more files import; the tests could not be run |
| **sure** | none of the above: a small, planned change to files covered by tests |

Facts come from the proposal (hunks: added plus removed lines), the plan, and the repository index (importers; related tests by import or name). The test status can only lower a tag, never raise it: once real tests run, applied groups are re-rated. Unit tests: `test/confidence.test.ts`.

### Warn before edit
When the agent submits its plan, before any write, the panel shows the files planned for change and the tests that might break (the related tests of those files, from the index, as `list_related` reports them); the first review of the run repeats it. Journaled as `warn_list`.

### Tests around the change, and exactly one automatic fix
1. At plan time CodeCraft runs the project's test command once on the unchanged files (the baseline). The first write waits until it has finished.
2. After the agent finishes, if anything was written in the run, CodeCraft runs the tests again.
3. If a test that passed in the baseline now fails, CodeCraft sends the real error output to the agent and asks for exactly ONE minimal fix. The fix goes through the same plan check and per-hunk review; the plan store allows exactly one reviewed proposal.
4. CodeCraft runs the tests again and shows the outcome either way: fixed, still failing, or no fix applied. There is never a second automatic fix.

Tests that already failed in the baseline are never blamed on the change. If the baseline could not run, no test counts as newly broken. Failing tests are recognised in pytest, node:test/TAP and Jest output; otherwise the whole command counts as one test. Every test run asks for confirmation as before; **Allow for this run** also covers CodeCraft's own runs in that run. Journaled: `tests` (phase baseline, after, after_fix or agent, with the failing test IDs), `regression`, `autofix`.

### Ask instead of guessing
TrueForge's `ask_user_question` tool is enabled on both agents, and the instructions say to ask ONE short question when the request is unclear instead of editing. The question appears in the panel with its options and a free-text box. The answer goes back as `user.tool_response` and the same turn continues (VERIFIED-RUN, see `docs/TRUEFORGE_NOTES.md`). Stop Run answers for the user ("no answer"). Any other client-side tool gets an error result instead of ending the run. Journaled as `question`.

### Rollback to any checkpoint
**CodeCraft: Roll Back to Checkpoint** (or **Roll back…** in the panel) lists the checkpoints of the last run that changed files: "before the first change of this run" and "after group N" for every applied change group, including between two groups of one change set.
- Groups come from the journal's `change_group` entries.
- Rolling back part of a change set reverts only the later groups' files (journaled as `files_undone`). The rest of that change set stays applied, and **Undo Last Change** then reverts only what is still applied.
- The rollback is planned from the journal: the operations applied after the checkpoint and not yet undone.
- File contents come from a content-addressed store in VS Code workspace storage, never in the repository. Each copy is verified by its sha256 when read.
- It applies as ONE step, and only if every affected file is still exactly what CodeCraft wrote. Otherwise nothing changes.
- A file created after the checkpoint is deleted.
- It is journaled as `op_undone` for each operation plus a `rollback` entry, so a later retry never treats those operations as still applied.

Unit tests: `test/rollback.test.ts`.

### Cost and speed
The panel shows the active model (updated on failover), tokens in and out, and the estimated cost when TrueForge reports it. Elapsed time ticks while the run is going, alongside files read versus files indexed. Tokens are TrueForge's per-turn totals (`turn.done` / paused `metrics`), added up over the run's turns. Journaled as `metrics` at the end of the run.

### Task buttons and the run report
**Fix this bug**, **Rename across files** and **Add tests** fill the prompt box with a template; the user edits it and presses Send. **Export report** (or **CodeCraft: Export Run Report**) opens a Markdown report of the last run, built only from the journal. It covers what changed (operations, per-group confidence and tests), why (the plan and per-group reasons, the warn list, questions asked), what failed, how it recovered (switches, recoveries, stream resumes, the automatic fix, rollbacks) and the models used, with cost and speed.
