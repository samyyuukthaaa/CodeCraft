# CodeCraft: write-up (DRAFT)

**Draft.** Items marked TODO are filled in after the last runs and the video. Every claim points to something in the repository.

## 1. Team
- **Team name:** Team Ocean Water (as in the licence).
- **Members:** TODO (names).
- **College or employer:** TODO.
- **GitHub handles:** TODO.

## 2. Starting point
- **CodeCraft:** built **from scratch** for this event, as a fresh VS Code extension (MIT licence).
- **Flask:** pallets/flask tag **3.1.3, commit `22d92470`**, is used **only as the test fixture** for the three fixed tasks. It is cloned into `fixtures/flask`, which is gitignored and never forked or redistributed, and it is reset after every scenario run. Its upstream BSD-3-Clause licence is preserved (`fixtures/flask/LICENSE.txt`).
- **Other dependencies:** TrueForge and the MCP SDK are used as published npm packages, unmodified.

## 3. Architecture on TrueForge
- **TrueForge client.** TrueForge runs the agent loop and every model call; CodeCraft never calls a provider and never stores keys. The extension registers two TrueForge agents, `codecraft-primary` and `codecraft-fallback` (identical instructions), creates sessions and sends turns. It streams turn events and resumes a cut stream after the last event ID.
- **Editor tools as MCP tools.** A local MCP server, `codecraft-editor` on `127.0.0.1`, protected by a bearer token kept in VS Code SecretStorage and by Host/Origin checks, exposes:
  - reading and search: paged `read_file`, `list_files`, `search_text`, `search_symbols`, `list_related`;
  - planning and changes: `submit_plan`, `propose_write`, `propose_changes`;
  - tests: `run_tests`.
- **Approval drives review.** `propose_*` and `run_tests` need TrueForge approval. When TrueForge pauses for approval, CodeCraft shows a diff, and you accept or reject whole groups or single hunks. Only accepted hunks are written, as one undo step, and only if the file is unchanged since the agent read it. Each change set gets an operation ID, journaled before the write, so the same change is never applied twice.
- **Self-healing.** Errors are classified from real TrueForge error texts (39 captured samples). Each class has its own retry budget; there is failover to the fallback, a per-provider circuit breaker, and an append-only journal. 16 injected faults behaved as expected in 3 of 3 runs each (`docs/FAILURE_TABLE.md`).
- **Context-engineering feature: history compaction** with an input-token trigger (48,000 tokens) plus TrueForge's large-tool-response handling, on both agents. It is set in the agent config and unit-tested, but not yet verified in a live run (`docs/TRUEFORGE_NOTES.md`).
- **Code Town.** A 3D town of the workspace (folders are districts, files are buildings, imports are roads, the provider is a power plant), fed only from the journal and the index. It has Agent Journey and Architecture views, an inspector, replay, a 2D fallback and reduced motion (`docs/CODETOWN.md`).
  - **Day / Night switch** (Night by default). Day has a sunny sky with a sunset horizon and brighter, more saturated rooftops; string lights stay on in both. Every building state keeps the same colour, icon and text in both themes (`src/town/theme.ts`).
  - **A playful night:** more saturated districts, denser string lights plus a garland over each district, 5 lanterns over each success, and small confetti when a change is applied (none with reduced motion).
- **Scout and Ask Scout** (merged into `main`). Both make **no model calls**.
  - **Scout** is always on screen: he starts on the plaza, about the height of a small house, with a lantern and a name tag. With no run active he patrols the streets on a seeded route. The patrol is renderer-only: no clock, no randomness, never journaled. During a run he walks to the agent's files. In 2D and without WebGL he is docked in a corner. **Find Scout** and **Follow Scout** move the camera to him.
  - **Ask Scout** answers from a built-in guide plus the live town state (`src/town/help.ts`). The answer appears in a speech bubble above Scout: the first 2–3 sentences, then Show more, a close button and Esc. While he talks his patrol pauses, and he resumes after close, Esc, 20 s of quiet or a new run. During a run he finishes his current walk first, and an agent move that arrives while he talks waits until he is done. The panel keeps a chat history, and screen readers still hear each answer. This is renderer state only, so replays are unchanged (`src/town/talk.ts`).

## 4. How context is selected
- **Repository index:** Python, TypeScript and JavaScript symbols, import edges and related tests. It is incremental and kept in VS Code workspace storage.
- **Retrieval:** `@file:` and `@symbol:` references, the editor selection, and files ranked from the request. The agent can also search (`search_symbols`, `search_text`, `list_related`).
- **Size budget:** context is capped by `codecraft.contextBudget` (default 6,000 tokens) with outlines and excerpts. The panel shows each file that was included or left out, and why. A context-too-large error retries once with a quarter of the budget.
- **Paged `read_file`:** large files are read in pages that stay under TrueForge's 24,000-character tool-response limit.
- **Plan before edits:** the agent must call `submit_plan` (files to edit or create, and why) before any proposal. The plan and a warn-before-edit list (planned files, tests that might break) are shown before the first write.

## 5. Model setup
- **Final primary:** TODO (after the teammates' 3-in-a-row runs). Currently configured: `google-gemini/gemini-3-5-flash-lite`, with `codecraft.preloadTools` on (TrueForge loads the editor tools into the model).
- **Final fallback:** TODO. Currently configured: `google-gemini/gemini-3-1-flash-lite`. It was the primary until live runs showed it wrapping `call_tool` arguments wrongly, which TrueForge rejected (`docs/RESULTS.md`).
- **Switching models:** set `codecraft.primaryModel` or `codecraft.fallbackModel` in VS Code Settings to any model reference TrueForge lists. On the next run the TrueForge agents are updated; no code change is needed. Keys stay in TrueForge Settings.
- **Approximate cost:** $0 on the Google Gemini free tier used for all recorded runs. The free tier allows 15 requests per minute, 250k input tokens per minute and 500 requests per day per model, but only 20 requests per day for `gemini-3-5-flash`. Recorded token use per run was about 60k–1.3M for Task A and 0.87M–4.2M for Task B (`docs/RESULTS.md`). Paid pricing was not measured.

## 6. Scorecard
One honest line per criterion, with proof and gaps, is in `docs/RUBRIC_AUDIT.md`. Final model results: TODO.

| Criterion | Claim (evidence) | Video |
|---|---|---|
| A1 Inline edit, per-hunk accept/reject | Selection-based request; diff with per-hunk review; only accepted hunks written (`test/gate.test.ts`; Task A 3/3 on `53fdb7a`). Gap: no in-editor inline widget | TODO |
| A2 Agent mode finds 3+ files | Plan of cli.py, docs/cli.rst, tests/test_cli.py before any edit; Task B passed on the primary (`9f4e8de`). 3 in a row: TODO | TODO |
| A3 Streaming, immediate cancel | Live text streaming, stream resume (3/3), Stop Run cancels the session. Gap: cancel not verified live | TODO |
| B1 Context with a visible budget | 6,000-token budget, included and left-out files with reasons, budget meter in the panel | TODO |
| B2 Per-hunk review, working undo | Per-hunk gate, Undo Last Change, roll back to checkpoint (unit-tested) | TODO |
| B3 Resilience, fallback, clean git | 16 faults 3/3 (`docs/FAILURE_TABLE.md`); Task C 3/3 both variants on `53fdb7a`, git clean | TODO |
| B4 TrueForge depth, context engineering | Agents, sessions, approvals, MCP tools, preloadTools; history compaction configured. Gap: compaction not yet seen live | TODO |
| C1 Video | TODO | TODO |
| C2 Write-up with scorecard | This document | n/a |

## 7. Tools used
Claude Code, Antigravity, TrueForge, VS Code.

## 8. Known limitations and what I would do with another month
- **Task B is not yet 3 in a row.** Free-tier lite models looped, or wrapped `call_tool` wrongly. With `preloadTools`, a per-run read budget and automatic answers to questions, it passed once on the primary in 22 requests (`9f4e8de`). The 3-in-a-row proof is pending (`docs/RUNBOOK.md`).
- **Free-tier quotas** shaped most failures: per-minute 429s and daily limits. Both models use the same provider, so a provider-wide outage or a revoked key takes out both.
- **Not verified live:** history compaction, and TrueForge's ask-user question with a real Gemini model (verified only with a test-only mock model).
- **No sandbox on Windows:** TrueForge's sandbox isn't available there, so `run_tests` runs on the machine after a confirmation.
- **Code Town performance:** on a laptop GPU (Intel UHD) it holds 144 fps, the screen-refresh cap, in two 5-minute runs: Scout patrolling, and the Ask Scout bubble kept open. JS heap after garbage collection stayed at 6.3–6.4 MB and resource counts stayed flat (`docs/results/town-scout-patrol-perf.json`, `town-scout-ask-bubble-perf.json`). Without a GPU it was about 15 fps in software rendering, measured **before** the Day/Night and playful-night changes, which have not been re-measured in software.
- **With another month:**
  - a fallback on a second provider;
  - paid or higher-quota models to get Task B to 3 of 3;
  - live verification of compaction and asking;
  - sandboxed tests;
  - faster software rendering for Code Town;
  - more languages in the index.
