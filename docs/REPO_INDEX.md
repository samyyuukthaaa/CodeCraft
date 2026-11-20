# Repository index and context budget (P2)

`src/index` builds an index of the open workspace. It is pure Node (no VS Code or Three.js imports) so the tools, the context budget and Code Town can share it.

## What is indexed
- Every file not in a skipped directory (see `docs/PERFORMANCE.md`): path, language, size, line count, mtime, whether it is a test.
- Python: classes, functions, methods (parent class), nested functions (parent function); `import`/`from` statements including relative imports, parenthesised and backslash-continued forms. Imports resolve against the workspace root, `src/` and `lib/`. `from pkg import Name` also follows one re-export hop through `pkg/__init__.py` (e.g. `from flask import Flask` -> `src/flask/app.py`).
- TypeScript/JavaScript: classes, methods (by brace depth), function declarations, `const x = (...) =>` / `function` expressions; `import`/`export ... from`/`require()`/`import()` specifiers. Relative specifiers resolve with TS/JS extensions, `.js`->`.ts` mapping and `index.*` files. Bare specifiers are recorded as external.
- Extraction is regex/line based, not a compiler. Known misses: attribute access through a package (`import flask` then `flask.Blueprint` links only to `__init__.py`), dynamically created definitions, unusual formatting with several members on one line, Python import roots deeper than `src/` or `lib/`.

Schema: `src/index/types.ts` (`RepoIndex`, `IndexedFile`, `IndexedSymbol`).

## MCP tools (read-only, no approval)
- `search_symbols(query, kind?, limit?)`: exact > prefix > substring, non-test files first; `Class.method` narrows to methods of that class.
- `list_related(path)`: `imports`, `importedBy`, and `tests`. A test must be named like a test (`test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.js`, ...) and either import the file or share its stem; fixtures and `conftest.py` under `tests/` appear in `importedBy` only.

## Context budget (`codecraft.contextBudget`, default 6000 estimated tokens)
Before each request CodeCraft picks files in priority order and records why:
1. `@file:path` references
2. definitions of `@symbol:Name` / `@symbol:Class.method` references
3. definitions or file names matching words in the request
4. tests of, and files imported by, the files above

Files are added whole while they fit. A file that does not fit but has a matching symbol contributes an excerpt of that definition (up to 200 lines, reason says which lines). Everything else is listed as "left out: over budget". Secrets are redacted from included text. Unknown references are reported as "not found".

The panel's **Context used** section lists each file, its reason and estimated tokens, the total against the budget, and "Files read by the agent: N of M" (paths the agent actually opened with `read_file`, out of all indexed files). Context is a snapshot: the agent must still call `read_file` before `propose_write`, so stale checks are unaffected.
