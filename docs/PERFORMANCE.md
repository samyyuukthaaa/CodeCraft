# Performance

Real measurements only. Re-run with `npm run perf-index -- <root>`.

## Repository index (P2), measured 2026-11-20
Machine: Windows 11 (win32 10.0.26200), 13th Gen Intel Core i7-13620H (16 logical cores), Node v24.15.0.
Method: `test/perf-index.ts`. One untimed warm-up build, then 5 timed full builds ("cold": no previous index, so every file is read and parsed; the OS file cache is warm), then 5 timed incremental builds with nothing changed ("warm": files are re-scanned and stat'ed, unchanged entries reused, all import edges re-resolved). Times are `performance.now()` around `buildIndex`.

| Repository | Files indexed | Python | TS/JS | Other | Symbols | Import edges | Test files | Cold build (median of 5) | Warm build (median of 5) | Save / load JSON | Index size |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `fixtures/flask` (pallets/flask @ 49943b5) | 235 | 83 | 0 | 152 | 1,622 | 226 | 68 | 39 ms (36-41) | 10 ms (10-11) | 3.5 ms / 1.2 ms | 220 KB |
| CodeCraft workspace (includes `fixtures/flask`) | 286 | 84 | 38 | 164 | 1,776 | 201 | 78 | 46 ms (42-48) | 12 ms (11-12) | 3.5 ms / 1.3 ms | 254 KB |

Notes
- Skipped during the scan: `node_modules`, `.git`, `out`, `dist`, `build`, virtualenvs (`.venv`, `venv`, `env`), `__pycache__`, tool caches, `site-packages`, `*.egg-info`, `coverage`, plus secret-like files (`.env*`, keys).
- The CodeCraft row has fewer edges than Flask alone: Python import roots are detected only at the workspace top level (`''`, `src/`, `lib/`), so Flask's absolute imports (`from flask import ...` resolving under `fixtures/flask/src`) do not resolve when the workspace root is CodeCraft. Indexing Flask as its own workspace resolves them.
- The index is persisted to VS Code workspace storage (outside the repository) after every build.
- Not measured yet: a repository above 2,000 files, memory use, and the extension host end to end (needs VS Code). The scanner caps at 20,000 files and marks the index `truncated`.

## Context budget
Token counts are estimates: `ceil(characters / 4)`. No tokenizer is bundled, so real model token counts will differ (typically by tens of percent depending on language and model).
