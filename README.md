# CodeCraft

CodeCraft is a VS Code extension that puts a TrueForge coding agent inside the editor, with safe, reviewable edits:

- **TrueForge owns the agent loop and every model call.** CodeCraft never calls a model provider and never stores, logs or commits API keys. Keys live only in TrueForge Settings.
- **CodeCraft is the editor-tool host.** It runs a local MCP server (`codecraft-editor`) that TrueForge calls: `read_file` (paged), `list_files`, `search_text`, `search_symbols`, `list_related`, `propose_write`, `propose_changes`, `run_tests`.
- **Nothing is written without you.** `propose_write` / `propose_changes` never write by themselves: TrueForge pauses for your approval, then you review a diff and accept or reject whole groups or single hunks. Only accepted hunks are applied, as one undo step, and only if the file is unchanged since the agent read it.
- **Failover and recovery.** A primary and a fallback agent with identical instructions. Temporary provider errors (rate limit, 503, timeout) are retried with capped backoff; an invalid key fails over at once, with a plain-words banner. Without a fallback you get a clear message ("Provider key rejected ... update it in TrueForge Settings").
- **Repository context.** A Python / TypeScript / JavaScript index (symbols, imports, related tests), `@file:` and `@symbol:` references, your editor selection, and a token budget that shows what was included and why.

**Current status (2026-11-22):** Task B passed once on the primary model in 22 requests with no failover; the 3-in-a-row proof for all three tasks on one commit is pending (teammates run it with [docs/RUNBOOK.md](docs/RUNBOOK.md)). Status and honest limits: see [docs/RESULTS.md](docs/RESULTS.md) and the write-up ([docs/WRITEUP.md](docs/WRITEUP.md), draft). Code Town, a 3D view of the workspace fed from the journal, is built: **CodeCraft: Open Code Town** ([docs/CODETOWN.md](docs/CODETOWN.md)).

---

## 1. Prerequisites
- Windows, macOS or Linux; **Node.js 22+** and npm; **VS Code 1.90+**; git.
- **Python 3.12** only for the Flask fixture and the scenario tests.
- A model provider key you add **in TrueForge** (the project was tested with Google Gemini).

## 2. Start TrueForge (local, standalone)
TrueForge must be allowed to call CodeCraft's local editor-tools server on `127.0.0.1`. Its outbound-URL guard blocks loopback addresses unless you allow them at start-up:

```bash
# bash / zsh
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.185.1
```
```powershell
# PowerShell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
```
TrueForge serves its UI and API at **http://localhost:8790**. Keep it running.
(Tested with TrueForge 0.185.1 standalone, which is meant for localhost only. Its local sandbox is not available on Windows, so `run_tests` runs in your workspace after a confirmation dialog.)

## 3. Add your model provider in TrueForge (keys stay there)
Open http://localhost:8790 -> **Settings -> Model providers** and add a provider with your key. The tested setup:

| Role | Model reference (as listed by TrueForge) |
|---|---|
| Primary | `google-gemini/gemini-3-5-flash-lite` |
| Fallback | `google-gemini/gemini-3-1-flash-lite` |

Any model reference that TrueForge lists under `GET http://localhost:8790/api/v1/models` works, from any provider. Never put keys anywhere in this repository.

## 4. Build and run the extension
```bash
git clone https://github.com/samyyuukthaaa/CodeCraft.git
cd CodeCraft
npm install
npm run build
```
Open the folder in VS Code and press **F5** ("Run CodeCraft Extension (opens fixtures/flask)"). In the new window run **CodeCraft: Open Agent Panel** from the Command Palette, type a request and press Send.

The agents are **registered for you**: on the first request CodeCraft starts its local MCP server, registers it with TrueForge as `codecraft-editor`, and creates or updates two TrueForge agents, `codecraft-primary` and `codecraft-fallback` (identical instructions, the models from your settings). Nothing needs to be created by hand in TrueForge besides the provider key.

Commands: **CodeCraft: Open Agent Panel** (prompt with task buttons *Fix this bug* / *Rename across files* / *Add tests*, the agent's question if a request is unclear, plan, warn-before-edit list, change groups with a beginner sentence, confidence tag (sure / check this / risky) and real test status, cost and speed, context used, provider health with **Test providers**, **Roll back…** and **Export report**), **CodeCraft: Roll Back to Checkpoint**, **CodeCraft: Export Run Report**, **CodeCraft: Undo Last Change** (reverts the last applied change set if the files are still exactly what CodeCraft wrote), **CodeCraft: Stop Run**, **CodeCraft: Show Edit Journal**, **CodeCraft: Scan Workspace for Secrets**. Self-healing and trust features: [docs/TRUST.md](docs/TRUST.md).

### Settings (example)
Copy into your VS Code `settings.json` to change the defaults (also in [config.example.json](config.example.json)). No keys here:
```json
{
  "codecraft.baseUrl": "http://localhost:8790",
  "codecraft.primaryModel": "google-gemini/gemini-3-5-flash-lite",
  "codecraft.fallbackModel": "google-gemini/gemini-3-1-flash-lite",
  "codecraft.preloadTools": true,
  "codecraft.contextBudget": 6000,
  "codecraft.testCommand": "npm test",
  "codecraft.mcpPort": 8791
}
```
`codecraft.baseUrl` must be a loopback address. To swap the fallback to another provider, change `codecraft.fallbackModel`; no code change is needed. For the Flask fixture set `codecraft.testCommand` to `.venv\Scripts\python -m pytest -q` (Windows) or `.venv/bin/python -m pytest -q`.

## 5. The Flask test repository (fixture)
The three fixed tasks run against **pallets/flask release 3.1.3, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`**, checked out in `fixtures/flask` (gitignored, not part of this repository). Exact steps, pinned test dependencies and the 490-test baseline: [docs/FIXTURE.md](docs/FIXTURE.md). Short form:
```bash
git clone --depth 1 https://github.com/pallets/flask fixtures/flask
git -C fixtures/flask fetch --depth 1 origin tag 3.1.3
git -C fixtures/flask checkout --detach "3.1.3^{commit}"
# then create fixtures/flask/.venv and install the pinned versions listed in docs/FIXTURE.md
```

## 6. Tests
```bash
npm run typecheck              # strict TypeScript
npm test                       # unit + integration tests (no network, no models)
npm run scenario -- task1      # live end-to-end Task A against fixtures/flask (needs TrueForge + a provider)
npm run scenario -- task2      # Task B
npm run scenario -- task3      # Task C, both variants (uses a TEST-ONLY provider with a dummy key)
npm run probe -- --agent primary   # cheap live check (2-7 requests): a real editor tool call must succeed
npm run test:vscode            # runs the extension inside a separately downloaded VS Code
npm run secret-scan            # staged files; -- --all for every tracked file (npm test also scans every tracked file)
npm run capture-errors         # records real TrueForge error shapes into test/fixtures/trueforge-errors.json
npm run failure-table          # every fault x3 end to end through TrueForge -> docs/FAILURE_TABLE.md (~20 min)
npm run ask-user               # live check: the agent's question round trip through TrueForge (test-only mock model)
```
For the live 3-in-a-row runs, follow [docs/RUNBOOK.md](docs/RUNBOOK.md) step by step.

The capture and failure-table scripts use only test-only providers: a local mock provider on 127.0.0.1:8799 that fails on purpose (`codecraft-test-mock`, `codecraft-test-mock-fallback`), a port with nothing listening (`codecraft-test-unreachable`) and the dummy-key provider below. To try failover by hand in the editor, use the panel's **Inject fault…** button (next run only) or the `codecraft.faultInjection` setting (every run; keep `none` normally).
The three tasks are quoted word for word in [docs/TASKS.md](docs/TASKS.md); real run results are in [docs/RESULTS.md](docs/RESULTS.md). Task C's scenario creates a TrueForge provider named `codecraft-test-badkey` with the obvious dummy key `DUMMY-INVALID-KEY-FOR-CODECRAFT-TESTS` and an agent `codecraft-test-primary-badkey`; both are test-only and never defaults.

## 7. Documentation
- [docs/FAILURE_TABLE.md](docs/FAILURE_TABLE.md): each fault, expected vs observed behaviour, from real runs
- [docs/EDITOR_TOOLS.md](docs/EDITOR_TOOLS.md): tools, write gate, change sets, review flow
- [docs/REPO_INDEX.md](docs/REPO_INDEX.md): index, context budget, `@file:` / `@symbol:`
- [docs/TRUEFORGE_NOTES.md](docs/TRUEFORGE_NOTES.md): TrueForge API shapes and error texts verified live
- [docs/MODELS.md](docs/MODELS.md): model identifiers and why other fallbacks were dropped
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measured index timings

## 8. Licences, upstream code and declarations
- **CodeCraft** is released under the [MIT License](LICENSE) (Copyright (c) 2026 Team Ocean Water).
- **Flask** (used only as a test fixture) is (c) 2010 Pallets, distributed under the BSD-3-Clause license; see `fixtures/flask/LICENSE.txt` after cloning. CodeCraft does **not** include, fork or redistribute Flask: the fixture is a fresh clone of the unmodified upstream release **3.1.3, commit `22d92470`**, and every scenario run resets it (`git checkout -- . && git clean -fd`), so no agent edits are kept.
- **TrueForge** (`@truefoundry/trueforge`, `@truefoundry/trueforge-sdk` 0.185.0) and the **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`) are used as published npm packages, unmodified.
- **Secrets:** no API keys are in this repository or its history. A secret scan runs before every commit (`npm run secret-scan`).
