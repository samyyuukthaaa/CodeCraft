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
- **Scout and Ask Scout.** A walking guide character and a built-in help guide that makes **no model calls**. Both are **on the `codetown-scout` branch** and not merged into `main` yet.

## 4. How context is selected
- **Repository index:** Python, TypeScript and JavaScript symbols, import edges and related tests. It is incremental and kept in VS Code workspace storage.
- **Retrieval:** `@file:` and `@symbol:` references, the editor selection, and files ranked from the request. The agent can also search (`search_symbols`, `search_text`, `list_related`).
- **Size budget:** context is capped by `codecraft.contextBudget` (default 6,000 tokens) with outlines and excerpts. The panel shows each file that was included or left out, and why. A context-too-large error retries once with a quarter of the budget.
- **Paged `read_file`:** large files are read in pages that stay under TrueForge's 24,000-character tool-response limit.
- **Plan before edits:** the agent must call `submit_plan` (files to edit or create, and why) before any proposal. The plan and a warn-before-edit list (planned files, tests that might break) are shown before the first write.

## 5. Model setup
- **Final primary:** TODO (until the last runs finish). Currently configured: `google-gemini/gemini-3-5-flash`.
- **Final fallback:** TODO. Currently configured: `google-gemini/gemini-3-5-flash-lite`.
- **Switching models:** set `codecraft.primaryModel` or `codecraft.fallbackModel` in VS Code Settings to any model reference TrueForge lists. On the next run the TrueForge agents are updated; no code change is needed. Keys stay in TrueForge Settings.
- **Approximate cost:** $0 on the Google Gemini free tier used for all recorded runs. The free tier allows 15 requests per minute, 250k input tokens per minute and 500 requests per day per model, but only 20 requests per day for `gemini-3-5-flash`. Recorded token use per run was about 60k–1.3M for Task A and 0.87M–4.2M for Task B (`docs/RESULTS.md`). Paid pricing was not measured.

## 6. Scorecard
The rubric wording for A1–C2 is not in the repository yet. **Assumption:** they follow the verification steps of Tasks A–C in `docs/TASKS.md` (3 + 4 + 2). Replace each criterion with the rubric text if it differs.

| Criterion | Claim (from `docs/RESULTS.md`) | Video |
|---|---|---|
| A1 | The selected `get_debug_flag` gets a diff for "off"/"n" as false (Task A, 3 of 3 passes on `53fdb7a`) | TODO |
| A2 | The diff is reviewed and accepted per hunk; only accepted hunks are written, as one undo step | TODO |
| A3 | `FLASK_DEBUG=off` prints `False`, checked by real commands in every passing Task A run | TODO |
| B1 | With no files named, the agent finds `cli.py`, `docs/cli.rst` and `tests/test_cli.py` and plans them before editing | TODO |
| B2 | The hunks are reviewed and accepted; the TrueForge session is recorded per run | TODO |
| B3 | `pytest tests/test_cli.py` and the masked JSON passed in some runs, but **not 3 in a row** (see section 8) | TODO |
| B4 | Passing Task B runs touched three files (code, test, docs) | TODO |
| C1 | The editor stays responsive: maximum event-loop lag 12–19 ms in the final Task C batch (`53fdb7a`) | TODO |
| C2 | Invalid key: the fallback takes over automatically or a clear message appears; git status clean (3 of 3, both variants, `53fdb7a`) | TODO |

## 7. Tools used
Claude Code, Antigravity, TrueForge, VS Code.

## 8. Known limitations and what I would do with another month
- **Task B does not pass 3 in a row.** Free-tier "lite" models wrote a `flask config` command that could not JSON-encode some values and then looped (up to 4.2M tokens). The stronger primary has only 20 free requests per day, so recent runs finished on the lite fallback with one failing test.
- **Free-tier quotas** shaped most failures: per-minute 429s and daily limits. Both models use the same provider, so a provider-wide outage or a revoked key takes out both.
- **Not verified live:** history compaction, and TrueForge's ask-user question with a real Gemini model (verified only with a test-only mock model).
- **No sandbox on Windows:** TrueForge's sandbox isn't available there, so `run_tests` runs on the machine after a confirmation.
- **Not merged yet:** Scout and Ask Scout are on a branch.
- **Code Town without a GPU:** about 15–17 fps in software rendering (144 fps on a GPU), clean re-measure on the `codetown-scout` branch. The first measurement in `docs/CODETOWN.md` on `main` ran beside a leftover headless browser; the corrected numbers arrive with that branch.
- **With another month:**
  - a fallback on a second provider;
  - paid or higher-quota models to get Task B to 3 of 3;
  - live verification of compaction and asking;
  - sandboxed tests;
  - faster software rendering for Code Town;
  - more languages in the index.
