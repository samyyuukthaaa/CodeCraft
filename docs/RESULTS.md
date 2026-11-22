# Scenario results (real runs only)

All runs: 2026-11-20, against pallets/flask 3.1.3 (`22d92470`) in `fixtures/flask`, real TrueForge 0.185.1, real models (primary `google-gemini/gemini-3-1-flash-lite`, fallback `google-gemini/gemini-3-5-flash-lite`, both on the Gemini free tier), the real MCP server, and real verification commands (python, pytest, flask CLI). Only the human is scripted (tool approval and hunk review). Commands: `npm run scenario -- task1|task2|task3-fallback|task3-nofallback`. Full per-run JSON: `docs/results/`.

## Current status (2026-11-22, honest)

- **Setup:** primary `google-gemini/gemini-3-5-flash-lite`, fallback `google-gemini/gemini-3-1-flash-lite`, `codecraft.preloadTools` on (TrueForge loads the editor tools into the model), per-run read budget, failover on repeated "not found in tool mapping", automatic answers to ask-user questions in non-interactive runs.
- **Task B (task2): passed once on the primary with no failover** (`9f4e8de`): 22 requests, 321k tokens, 101 s, all checks passed. It has **not** yet passed 3 in a row on one commit.
- **Task A (task1) and Task C (task3, both variants):** passed 3 in a row on `53fdb7a` with the earlier models; **not yet re-run** on the current setup.
- **The 3-in-a-row proof on one commit is pending the teammates' run** ([RUNBOOK.md](RUNBOOK.md)). No `submission-safe` tag exists yet.

## Earlier status as of 2026-11-21 12:40 UTC (3-in-a-row goal)

On the final code `53fdb7a`: task1, task3-fallback and task3-nofallback pass 3 in a row; task2 does not. Every run since the first summary, in order (all rows are in the raw table below):

| Code | Scenario | Runs | Result | Cause of each failure |
|---|---|---|---|---|
| `68dd453` | task1 | 3 | **PASS, PASS, PASS** | (runs 2-3 finished on the fallback after the primary hit per-minute 429s) |
| `68dd453` | task2 | 3 | PASS, PASS, FAIL | run 3: both models out of retries on per-minute 429s mid-change (retry budget counted every 429; fixed in `6a9ce30`) |
| `68dd453` | task3-fallback | 1 | FAIL | fallback out of retries on per-minute 429s (same cause) |
| `68dd453` | task3-nofallback | 3 | **PASS, PASS, PASS** | |
| `6a9ce30` | task2 | 1 | FAIL | primary agent's edits never matched: the model sent `find` text with literal backslash-n (30 refused proposals); then a DNS outage (`ENOTFOUND`) and the 15-min limit (fixed in `1038062`) |
| `6a9ce30` | task3 (both) | 1 each | FAIL | TrueForge: `Outbound URL blocked for host "api.groq.com"` during the same DNS outage (setup works when DNS is up) |
| `6a9ce30` | task1 | 3 | **PASS, PASS, PASS** | |
| `1038062` | task2 | 3 | PASS, PASS, FAIL | run 3: Gemini free-tier **daily** limit (500 requests/day per model) reached on both models at ~20:06 UTC |
| `1038062` | task3-fallback | 1 | FAIL | fallback already at the daily limit (0 tokens served) |
| `1038062` | task3-nofallback | 3 | **PASS, PASS, PASS** | |
| `1038062` | task1 | 1 | FAIL | daily limit, and the machine was asleep (no event-loop tick for 893 s); the 15-min run limit fired |
| `7d47965` | task1 | 1 | aborted | process exited (code 127) mid-run right after the plan and first proposals, with no error output; cause not yet known; fixture left clean |
| `7d47965` | task3-fallback | 1 | FAIL | 401 failover worked; the fallback then re-proposed after each rejection by the scripted user until the 25-round limit (fixed: proposals are refused after 2 whole rejections in a row) |
| `7d47965` | task3-nofallback | 3 | **PASS, PASS, PASS** | |
| `7d47965` | task2 | 2 | PASS, FAIL | run 2: `Cannot connect to API: certificate has expired` (TLS on this machine). Per the project rule the batch STOPPED and nothing was retried. |
| `7176115` | task1 | 3 | **PASS, PASS, PASS** | (all three on the primary; run 2 shows a 408 s event-loop gap, likely the machine sleeping, and still passed) |
| `7176115` | task3-fallback | 3 | **PASS, PASS, PASS** | invalid key -> automatic takeover by gemini-3-5-flash-lite, proposal rejected by the scripted user, git clean |
| `7176115` | task3-nofallback | 3 | **PASS, PASS, PASS** | |
| `7176115` | task2 | 1 | FAIL | Gemini free-tier per-minute input-token quota: the primary waited out 10 per-minute 429s while progressing, failed over, the fallback hit the same limit, and the harness's own 15-minute run limit cancelled the run mid-change (raised to 25 minutes; no task check changed) |
| `ec18181` | task2 | 1 | FAIL | every TASKS.md check passed (3 files, test_cli 59 passed, masked JSON, `config` in --help, test, docs, suite 491 passed), but the plan before the first review listed cli.py and a new test only; docs were planned after the code was proposed (instructions changed in `64a515a`) |
| `64a515a` | task2 | 1 | FAIL | the first plan listed cli.py, docs/cli.rst and tests/test_cli.py (fixed), but the fallback model's `flask config` failed to JSON-encode some config values; it then spent 15 debug cycles (4.2M tokens) until the free-tier quota stopped it with 1 failing test in test_cli.py |
| `53fdb7a` | task2 | 1 | FAIL | the new primary `gemini-3-5-flash` returned 429 at once: Google's free tier allows it only **20 requests per day** (quota text names `gemini-3.6-flash`, limit 20); the lite fallback did the work, left 1 failing test in test_cli.py and stopped as instructed instead of looping (done in 542 s, 0.87M tokens) |
| `53fdb7a` | task1 | 3 | **PASS, PASS, PASS** | all three finished on the lite fallback after the primary's daily 429 (28-54 s, ~60k tokens each) |
| `53fdb7a` | task3-fallback | 3 | **PASS, PASS, PASS** | |
| `53fdb7a` | task3-nofallback | 3 | **PASS, PASS, PASS** | |
| `1b101e0` | task2 | 1 | FAIL | primary back to `gemini-3-1-flash-lite` (2026-11-22). The model called the editor tools **by name** (`list_files`, `read_file`, `run_tests`, ...) instead of through TrueForge's `call_tool` wrapper; TrueForge answered "Tool list_files not found in tool mapping" 89 times. The model then said the tools were unavailable and ended the turn as `done`, so failover never fired. Nothing written, 0 files read, no plan; about 96 requests (90 model calls + 6 per-minute 429s waited out), 1.11M tokens, 385 s. Session `01m814zm6ss85ehg23smf7spf3`. |
| `d3e2cf3` | task2 | 1 | **PASS** (on the fallback) | After the call_tool instruction line and the tool-mapping failover (`17b97f5`, `cb53492`), and `npm run probe` passing on the primary (2 requests, a real `list_files` call). The primary now used call_tool (0 "not found in tool mapping"), but spent 166 model calls reading (104 `read_file`, 10 `list_files`, 44 `call_tool` with no tool name) without submitting a plan, until its 10th per-minute 429 wait; it then failed over. The fallback `gemini-3-5-flash-lite` planned cli.py, tests/test_cli.py and docs/cli.rst, and all checks passed (59 test_cli, 491 suite, masked JSON, `config` in --help). About 222 requests (166 + 42 answered model calls, 14 per-minute 429s), 4.35M tokens, 1113 s. Sessions `01m816xntxvkg9m8cg5pxqs89j`, `01m817rdwgkxzjwefbtcq2b23a`. |
| `1b3398d` | task2 | 1 | FAIL | With the per-run read budget. The primary still looped, but **none of its calls reached the editor tools**: all 137 of its `call_tool` calls put `mcp_server` (and often `tool_name`) inside `input`, and TrueForge's own `call_tool` validation rejected each one ("mcp_server: expected string, received undefined"). It cycled through 7 argument shapes (122 list_files attempts) until its 10th per-minute 429 wait, so the budget never triggered (0 capped, 0 cached). The fallback planned all three files and changed them, but `config` was not registered (not in `flask --help`, `No such command 'config'`) and 1 test in test_cli.py failed. About 192 requests (143 + 37 answered model calls, 12 per-minute 429s), 3.12M tokens, 862 s. Sessions `01m818j0g7ehx4822ajmgjb8js`, `01m8197zjhwxgk5gy7bwe9m7rf`. |

**Primary model changed (2026-11-21, approved by the project owner):** from `google-gemini/gemini-3-1-flash-lite` to `google-gemini/gemini-3-5-flash`; `google-gemini/gemini-3-5-flash-lite` stays the fallback. Reason: in Task B the free-tier "lite" models repeatedly wrote a `flask config` command that could not JSON-encode some config values, then looped on debugging (up to 4.2M tokens in one run) until the free-tier quota stopped them. At the same time the agent instructions now require verifying a new command through a test and run_tests before declaring done, and CodeCraft refuses further proposals after 2 failed test runs in a run (the agent must stop and report). Task wording and checks are unchanged. All three tasks are re-run 3 times on this configuration before any tag.

Environment facts, not code: both Gemini models are on the free tier (15 requests/min, 250k input tokens/min, 500 requests/day per model; the daily quota resets at midnight Pacific = 08:00 UTC); one DNS outage; the machine slept during one batch. Code changes made because of these runs: per-minute 429 retries count only consecutive failures without progress; daily-quota 429s are not retried and say so; over-escaped edit text is decoded once as a fallback. No check was weakened.

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

### task2: 3 run(s), 2026-11-20T20:06:27.305Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | PASS | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 874858 | 350 s | 51 ms | - |
| task2 | 2 | PASS | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 1799195 | 519 s | 69 ms | - |
| task2 | 3 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 386416 | 492 s | 63 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-20T20:07:53.153Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 81 s | 60 ms | TASKS.md: the second configured model took over (run finished on codecraft-fallback); the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user) |
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 15 ms | - |
| task3-nofallback | 2 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 24 ms | - |
| task3-nofallback | 3 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |

### task1: 3 run(s), 2026-11-20T20:25:32.396Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1058 s | 893513 ms | agent run finished; src/flask/helpers.py changed; nothing else except tests; TASKS.md check: FLASK_DEBUG=off prints False; false for off/n/0/false/no (any case), empty and unset; true otherwise; docstring lists every false value (0, false, no, off, n) |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-21T08:18:17.198Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | FAIL | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 151355 | 738 s | 51 ms | TASKS.md: the second configured model took over (run finished on codecraft-fallback) |
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |
| task3-nofallback | 2 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 3 ms | - |
| task3-nofallback | 3 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |

### task2: 3 run(s), 2026-11-21T08:27:06.854Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | PASS | codecraft-primary | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 4/234 | 1811339 | 431 s | 120 ms | - |
| task2 | 2 | FAIL | codecraft-primary | (none) | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 1/234 | 184305 | 95 s | 97 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands; plan shown before proposing, listing src/flask/cli.py, a tests/ file and docs/cli.rst to change |

### task1: 3 run(s), 2026-11-21T10:57:39.884Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | PASS | codecraft-primary | src/flask/helpers.py<br>tests/test_debug_flag.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 256106 | 77 s | 29 ms | - |
| task1 | 2 | PASS | codecraft-primary | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 1305665 | 715 s | 408318 ms | - |
| task1 | 3 | PASS | codecraft-primary | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 214928 | 121 s | 15 ms | - |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-21T11:00:35.860Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 102161 | 27 s | 15 ms | - |
| task3-fallback | 2 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 109636 | 75 s | 15 ms | - |
| task3-fallback | 3 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 3/234 | 188298 | 71 s | 15 ms | - |
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |
| task3-nofallback | 2 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 1 ms | - |
| task3-nofallback | 3 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 13 ms | - |

### task2: 3 run(s), 2026-11-21T11:15:38.750Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | src/flask/cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 1/234 | 3302822 | 902 s | 38 ms | agent run finished; TASKS.md: the diff touches at least three files; TASKS.md: pytest tests/test_cli.py -q passes; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands; full Flask test suite passes (0 failed); plan shown before proposing, listing src/flask/cli.py, a tests/ file and docs/cli.rst to change |

### task2: 3 run(s), 2026-11-21T11:28:03.658Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 5/234 | 1146054 | 682 s | 28 ms | plan shown before proposing, listing src/flask/cli.py, a tests/ file and docs/cli.rst to change |

### task2: 3 run(s), 2026-11-21T11:45:08.641Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_config_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 5/234 | 2140010 | 986 s | 28 ms | plan shown before proposing, listing src/flask/cli.py, a tests/ file and docs/cli.rst to change |

### task2: 3 run(s), 2026-11-21T12:07:13.386Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 8/234 | 4228534 | 1279 s | 35 ms | agent run finished; TASKS.md: pytest tests/test_cli.py -q passes; TASKS.md: `flask config` prints JSON; full Flask test suite passes (0 failed) |

### task2: 3 run(s), 2026-11-21T12:28:18.246Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 865544 | 542 s | 18 ms | TASKS.md: pytest tests/test_cli.py -q passes; full Flask test suite passes (0 failed) |

### task1: 3 run(s), 2026-11-21T12:30:15.954Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task1 | 1 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 64763 | 54 s | 15 ms | - |
| task1 | 2 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 58897 | 35 s | 15 ms | - |
| task1 | 3 | PASS | codecraft-fallback (failover x1) | src/flask/helpers.py<br>tests/test_helpers.py | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 67757 | 28 s | 17 ms | - |

### task3-fallback, task3-nofallback: 3 run(s), 2026-11-21T12:33:00.687Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task3-fallback | 1 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 63831 | 52 s | 19 ms | - |
| task3-fallback | 2 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 3/234 | 273699 | 75 s | 18 ms | - |
| task3-fallback | 3 | PASS | codecraft-fallback (failover x1) | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 2/234 | 102709 | 34 s | 17 ms | - |
| task3-nofallback | 1 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 14 ms | - |
| task3-nofallback | 2 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 12 ms | - |
| task3-nofallback | 3 | PASS | codecraft-test-primary-badkey | (none) | src/flask/helpers.py<br>tests/test_converters.py<br>tests/test_helpers.py<br>src/flask/globals.py<br>src/flask/signals.py<br>src/flask/wrappers.py | 0/234 | n/a | 1 s | 15 ms | - |

### task2: 1 run(s), 2026-11-22T08:18:20.014Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-primary | (none) | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 0/234 | 1110596 | 385 s | 16 ms | TASKS.md: the diff touches at least three files; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; covered by a test (added test code invokes "config"); documented in docs/cli.rst with the other built-in commands; plan shown before proposing, listing src/flask/cli.py, a tests/ file and docs/cli.rst to change |

Root cause of this run (from the TrueForge session events): `gemini-3-1-flash-lite` called the editor MCP tools directly by name, which TrueForge does not map ("Tool list_files not found in tool mapping", 89 times); only `call_tool {mcp_server, tool_name, input}` reaches them. The turn ended as `done` with an apology, so it was not treated as a provider failure and the fallback never ran. Fixes follow in the next commits; the task wording and checks are unchanged.

### task2: 1 run(s), 2026-11-22T09:04:20.642Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | PASS | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 4354103 | 1113 s | 46 ms | - |

### task2: 1 run(s), 2026-11-22T09:28:45.223Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-fallback (failover x1) | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 3123804 | 862 s | 19 ms | TASKS.md: pytest tests/test_cli.py -q passes; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; full Flask test suite passes (0 failed) |

**Models swapped (2026-11-22, project owner's decision, after the `1b3398d` run):** primary `google-gemini/gemini-3-5-flash-lite`, fallback `google-gemini/gemini-3-1-flash-lite`. Reason: `gemini-3-1-flash-lite` nests `mcp_server` inside `call_tool`'s `input` and TrueForge rejects every such call (137 of 137 in the `1b3398d` run), while `gemini-3-5-flash-lite` built `call_tool` correctly and finished Task B once (`d3e2cf3`, as the fallback). Task wording and checks are unchanged.

### task2: 1 run(s), 2026-11-22T09:42:16.313Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | PASS | codecraft-primary | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 4/234 | 321086 | 101 s | 16 ms | - |

**Tool probe with `codecraft.preloadTools` ON (2026-11-22, `c2514b9`, one run each):** primary `gemini-3-5-flash-lite` **PASS**: 3 requests, two real `list_files` calls reached CodeCraft, fixture clean. Fallback `gemini-3-1-flash-lite` **FAIL** by the probe's rule: its editor tool calls did reach CodeCraft (4 `list_files`), but it kept listing past the 6-request cap (7 requests, then cancelled). Because the primary passed, preloadTools is on by default from `9f4e8de`.

| Code | Scenario | Runs | Result | Notes |
|---|---|---|---|---|
| `9f4e8de` | task2 | 1 | **PASS on the primary, no failover** | Primary `gemini-3-5-flash-lite` with preloadTools on: called the editor tools directly (8 `search_text`, 9 `read_file`, 1 `submit_plan` before the first proposal listing cli.py, docs/cli.rst and tests/test_cli.py, 1 `propose_changes`, 1 `run_tests`; 2 identical repeats answered from the read budget's cache, 0 caps, 0 "not found in tool mapping"). All checks passed: 3 files, test_cli 61 passed, full suite 493 passed, masked JSON (33 keys), `config` in `--help`, test and docs. **22 requests** (21 model calls + 1 per-minute 429), 321k tokens, 101 s. Session `01m81a1zyf4bsq7ma54vfwvx9x`. |

### task2: 3 run(s), 2026-11-22T11:52:08.511Z

| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |
|---|---|---|---|---|---|---|---|---|---|---|
| task2 | 1 | FAIL | codecraft-primary | docs/cli.rst<br>src/flask/cli.py<br>tests/test_cli.py | src/flask/app.py<br>src/flask/cli.py<br>src/flask/config.py<br>docs/cli.rst<br>docs/config.rst<br>tests/test_async.py<br>tests/test_cli.py<br>tests/test_config.py<br>tests/test_testing.py<br>src/flask/__init__.py | 3/234 | 349567 | 82 s | 15 ms | TASKS.md: pytest tests/test_cli.py -q passes; TASKS.md: `flask config` prints JSON; TASKS.md: `config` appears in flask --help; full Flask test suite passes (0 failed) |

Root cause of the task2 failure on `c7c390b` (session `01m81hgcjfkf6e3y2ad6r6zn9z`, primary `gemini-3-5-flash-lite`, about 18 model calls, 350k tokens, 82 s, no rate limits, no failover): the model sent every edit's replacement text with literal backslash-n instead of newlines. CodeCraft decoded a replacement only when its `find` text also needed decoding, so an exactly matching one-line `find` wrote the literal `\n` into tests/test_cli.py, a SyntaxError at collection (`run_tests` failed twice, then the 2-failed-runs limit stopped further proposals). `config` was also not registered with the CLI group (`No such command 'config'`). The loop stopped at run 1; task1 and task3 were not run.
