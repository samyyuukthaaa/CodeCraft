# Scenario results (real runs only)

All runs: 2026-11-20, against pallets/flask 3.1.3 (`22d92470`) in `fixtures/flask`, real TrueForge 0.185.1, real models (primary `google-gemini/gemini-3-1-flash-lite`, fallback `google-gemini/gemini-3-5-flash-lite`, both on the Gemini free tier), the real MCP server, and real verification commands (python, pytest, flask CLI). Only the human is scripted (tool approval and hunk review). Commands: `npm run scenario -- task1|task2|task3-fallback|task3-nofallback`. Full per-run JSON: `docs/results/`.

## Summary

| Task | Result | What the evidence shows |
|---|---|---|
| Task A (task1) | **Behaviour correct; recorded run FAIL on a scope check that was too strict** | Run 1 (clean, not overlapped): agent finished on the primary after 2 rate-limit retries; `FLASK_DEBUG=off` prints `False`; all 18 values in the case-insensitive truth table correct; docstring lists 0, false, no, off, n; full Flask suite **492 passed, 0 failed** (the agent also added 2 tests). The only failed check was CodeCraft's own "only src/flask/helpers.py changed" rule, which also rejected the added tests in `tests/test_helpers.py`; the check now allows test files. The agent also wrote an invented `.. versionchanged:: 2.3` note in the docstring. Cost: 732k tokens, 170 s. |
| Task B (task2) | **Not passed** | First run: the fallback model double-wrapped tool arguments, every editor tool call failed validation, then it called TrueForge's `ask_user_question`, which CodeCraft does not support (ended as "unsupported"). Both causes were fixed (argument unwrap, `ask_user_question` disabled). The re-run could not reach the providers at all: both models failed with `Cannot connect to API: certificate has expired` (machine network/TLS problem at that time, same window as a DNS failure). No passing run of Task B. |
| Task C, fallback (task3-fallback) | **Takeover works; run not completed** | Re-run (clean): the invalid key was rejected (`401 Invalid API Key`); CodeCraft switched to the fallback automatically with no user action and nothing written; banner: "The primary model codecraft-test-badkey/gpt-oss-120b stopped because its API key was rejected (HTTP 401). CodeCraft switched to the fallback model google-gemini/gemini-3-5-flash-lite automatically and is continuing your request."; git clean; max event-loop lag 15 ms; dummy key never shown. The fallback then got `503 high demand` three times (initial + 2 retries) and the run ended in error before proposing, so the "fallback did the work" check failed. |
| Task C, no fallback (task3-nofallback) | **PASS** | Run fails in about 1 s with no prompts; message: "Provider key rejected (HTTP 401) for codecraft-test-badkey/gpt-oss-120b: update it in TrueForge Settings. Nothing was changed in your files."; git clean; lag 12 ms; dummy key never shown. |

### Caveat on the recorded rows below
A stopped 3-run batch of task1 kept running in the background (only its shell wrapper was stopped), so **task1 runs 2-3, the first task2 run and the first task3-fallback run overlapped** on the same fixture and the same per-minute quota. Treat those rows as unreliable. The clean evidence is task1 run 1, the second task3-fallback run (16:42) and task3-nofallback.

### Root causes found and fixed during these runs
- TrueForge truncates tool responses over 24,000 characters; `read_file` of `src/flask/helpers.py` (25,640 chars as JSON) was replaced by a notice and the agent re-read it 34 times (~362k tokens) until the Gemini free-tier limit (15 requests/minute) returned 429. Fixed: paged `read_file`, find/replace `edits`, line endings preserved.
- Runaway turns: sub-agents and 512 iterations allowed by default. Fixed: sub-agents off, 60 iterations.
- No retry on transient errors. Fixed: capped retries honouring "Please retry in N s"; invalid keys fail over immediately.
- Model double-wrapping `call_tool` input. Fixed: exact-shape unwrap before strict validation.
- `ask_user_question` (no UI in CodeCraft). Fixed: disabled in the agent config.
- A stale MCP port was dialled once (`ECONNREFUSED`). Fixed defensively: fixed port and stable local token.

## Raw recorded rows (written by the runner, unedited)


### task2: 1 run(s), 2026-11-20T16:30:17.281Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | (none) | .github/ISSUE_TEMPLATE/config.yml<br>src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>tests/static/config.json<br>tests/static/config.toml<br>tests/test_apps/cliapp/inner1/inner2/flask.py<br>tests/test_config.py<br>src/flask/globals.py | 1/234 | 151262 | 239 s | 15 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands |

### task1: 3 run(s), 2026-11-20T16:31:03.920Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | FAIL | codecraft-primary | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 2/234 | 732368 | 170 s | 16 ms | only src/flask/helpers.py changed |
| task1 | 2 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 2/234 | 657601 | 306 s | 31 ms | agent run finished; only src/flask/helpers.py changed; TASKS.md check: FLASK_DEBUG=off prints False; false for off/n/0/false/no (any case), empty and unset; true otherwise; docstring lists every false value (0, false, no, off, n) |
| task1 | 3 | FAIL | codecraft-primary | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 2/234 | 253502 | 34 s | 15 ms | only src/flask/helpers.py changed |

### task3-fallback: 1 run(s), 2026-11-20T16:31:48.730Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 0/234 | 36782 | 90 s | 15 ms | TASKS.md: the second configured model took over (run finished on codecraft-fallback); the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user) |

### task3-nofallback: 1 run(s), 2026-11-20T16:31:50.471Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 0/234 | n/a | 1 s | 12 ms | - |

### task3-fallback: 1 run(s), 2026-11-20T16:42:51.518Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py | 2/234 | 141309 | 174 s | 15 ms | TASKS.md: the second configured model took over (run finished on codecraft-fallback); the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user) |

### task2: 1 run(s), 2026-11-20T16:44:17.638Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | (none) | .github/ISSUE_TEMPLATE/config.yml<br>src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>tests/static/config.json<br>tests/static/config.toml<br>tests/test_apps/cliapp/inner1/inner2/flask.py<br>tests/test_config.py<br>src/flask/globals.py | 0/234 | 42631 | 85 s | 16 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands |

### task1: 3 run(s), 2026-11-20T18:50:55.406Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | PASS | codecraft-primary | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 515392 | 328 s | 15 ms | - |
| task1 | 2 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 3/234 | 609156 | 195 s | 39 ms | - |
| task1 | 3 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 3/234 | 1057559 | 273 s | 29 ms | - |

### task2: 3 run(s), 2026-11-20T19:12:28.625Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | PASS | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 1399686 | 385 s | 15 ms | - |
| task2 | 2 | PASS | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 1654049 | 424 s | 15 ms | - |
| task2 | 3 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 4/234 | 1825667 | 479 s | 16 ms | agent run finished; TASKS.md: pytest tests/test_cli.py -q passes; full Flask test suite passes (0 failed) |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-20T19:15:06.942Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 248630 | 155 s | 16 ms | TASKS.md: the second configured model took over (run finished on codecraft-fallback) |
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |
| task3-nofallback | 2 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 0 s | 11 ms | - |
| task3-nofallback | 3 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |

### task2: 3 run(s), 2026-11-20T19:32:03.273Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | src/flask/cli.py<br>tests/test_config_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 2/234 | 3295484 | 902 s | 21 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: pytest tests/test_cli.py -q passes; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; documented in docs/cli.rst with the other built-in commands; full Flask test suite passes (0 failed) |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-20T19:32:05.392Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | - | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 7 ms | exactly one automatic switch, from the invalid-key agent to codecraft-fallback; the switch was caused by the rejected key (HTTP 401); no user action before the takeover (0 approvals, 0 reviews) and nothing written at that moment; banner says in plain words that the primary key was rejected and the fallback took over; TASKS.md: the second configured model took over (run finished on codecraft-fallback); the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user) |
| task3-nofallback | 1 | FAIL | - | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 0 s | 0 ms | TASKS.md: the user sees a clear message (key rejected, where to fix it, nothing changed) |

### task1: 3 run(s), 2026-11-20T19:41:10.379Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 208862 | 330 s | 16 ms | - |
| task1 | 2 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 63692 | 107 s | 130 ms | - |
| task1 | 3 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 64152 | 107 s | 136 ms | - |
