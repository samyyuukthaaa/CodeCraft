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
