# CodeCraft: Code Town Integration Audit (CT-0)

Status: audit only. No source code has been written. Date of audit: 2026-11-20.
Every statement below is marked VERIFIED (observed in this environment) or UNVERIFIED (assumption that must be checked before it is relied on).

## 1. What actually exists

VERIFIED, by listing `d:\CodeCraft` and `git ls-remote origin`:

| Item | State |
|---|---|
| Repository contents | `.gitignore`, empty `code.py` (0 bytes), `.git` |
| Git history | One commit, `37ada3e` "Baseline before Code Town and self-healing work"; remote `main` is at the same commit |
| Extension manifest, entry point, build, webview, MCP server, indexer, hunk review, journal, checkpoints, rollback, event contracts, scene code, tests, Flask fixtures | None present |

Searched `C:\` and `D:\` to depth 2 for folders named like forge or codecraft. Nothing else found.

Consequence: there is no existing architecture to audit. The "existing ForgeGuard Studio extension", "Phase 6 block-world view", "three fixed Flask tasks", "existing MCP tools" and "existing journal" cannot be inspected. Sections 2 to 8 therefore record what is unknown, not what is true.

## 2. Architecture, modules and files: UNKNOWN

Cannot be listed. Needed from the owner: the real code (path, repo or branch).

## 3. Events, payloads and sources of truth: UNKNOWN

The expected names in the master prompt (`run_started`, `file_read`, `plan_updated`, `hunk_proposed`, `hunk_decided`, `file_written`, `test_run`, `model_failed`, `model_switched`, `step_resumed`, `run_finished`) are requests, not verified contracts. `provider_error{class}` and `provider_recovered` are new additions to be made through an adapter.

## 4. Index schema: UNKNOWN

Whether the index holds symbols (classes, functions) or dependencies (imports, calls) cannot be stated. Town grammar for rooms, floors, roads and bridges stays conditional on the index really supporting them.

## 5. Webview structure and security: UNKNOWN

Unverified: CSP, nonce use, `localResourceRoots`, message validation.

## 6. Write, approval, diff, undo, rollback path: UNKNOWN

## 7. Provider errors and fallback

TrueForge, partial observation only. On 2026-11-19 `npx @truefoundry/trueforge@latest` started TrueForge v0.185.1 in standalone mode on Windows. VERIFIED from its log:

- It polls `GET /api/internal/sandbox-environments/pending` every 5 seconds (200 responses).
- Local sandbox fallback is unavailable on win32 (macOS and Linux only).
- Standalone mode is documented by TrueForge as localhost-only.
- The process later exited with code 1 with no error line preceding it.

UNVERIFIED: the shapes of TrueForge turn and error events, HTTP status codes or error codes for invalid key, rate limit, timeout, bad output and context-too-large, and any retry-after hints. The five error classes cannot be mapped from real events until they are observed (for example by running a deliberately failing provider) or documented.

## 8. Existing scene code: UNKNOWN

## 9. Reuse, missing, must-not-duplicate

Nothing to reuse in this repository. If the real code is supplied, the audit must re-run before any of the following is decided.

## 10. Proposed file layout (only valid if the project is greenfield)

Only if the owner confirms a fresh project. Layout keeps the scene model free of VS Code and Three.js imports:

```
package.json, tsconfig.json
src/extension/        activation, commands, webview host, message validation
src/core/events/      typed event adapter, event types
src/core/scene/       SceneNode/SceneEdge/SceneEvent types, pure reducer
src/core/health/      error classifier, circuit breaker (no provider calls)
src/webview/          renderer (Three.js), 2D fallback, UI
test/                 reducer, adapter, classifier unit tests
scripts/              secret scan
```

Not proposed: any agent loop, planner, model client or direct provider call. Those belong to TrueForge.

## 11. Risks

- Building on an unverified premise (the existing extension). High risk of contract mismatch later.
- Deadline: Round 1 feature freeze is 18:00 IST on 2026-11-20. Log timestamps show the session was already past 18:22 local time (timezone unverified).
- TrueForge error shapes unknown, so Workstream A classification could be wrong.
- Performance claims (2,000-file aggregation, instancing) cannot be measured without a real index.

## 12. Test plan (outline)

Unit: error classifier against recorded real error fixtures; reducer determinism and replay equivalence; adapter normalisation; secret scanner. Integration: only after the real extension and Flask tasks are available.

## 13. Scope split

Round 1 minimum: A1 to A3 plus CT-1 (scene types, adapter, reducer, tests) and a simple activity panel. Round 2: Three.js renderer, Agent Journey Mode visuals, replay polish, WebXR.

## 14. Blockers and questions

1. Where is the real ForgeGuard Studio code? Without it this audit cannot proceed past this page.
2. If the project is meant to be fresh, confirm so the layout in section 10 can be approved.
3. Reference clips were not provided; visual direction will follow the text description.
4. Need real TrueForge turn and error event samples (or docs) to define the error mapping.
5. Confirm whether the Round 1 deadline has passed.
