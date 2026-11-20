# CodeCraft

A VS Code extension that is the interface and editor-tool host for TrueForge agents, with gated hunk review, a recovery journal and (later) Code Town, a read-only 3D view of the repository and the agent's confirmed actions.

TrueForge owns the agent loop and all model calls. CodeCraft never calls providers and never handles API keys.

## Status
P2: repository index (Python, TypeScript/JavaScript symbols and import edges), MCP tools `search_symbols` and `list_related`, context budget with @file:/@symbol: references and a "Context used" panel section. See `docs/REPO_INDEX.md`, `docs/PERFORMANCE.md`.

P1: editor MCP server (read, list, search, gated propose_write, run_tests), per-hunk review, undo, stop, approval pause/resume, and failover from `codecraft-primary` to `codecraft-fallback` (models set in `codecraft.primaryModel` / `codecraft.fallbackModel`). See `docs/EDITOR_TOOLS.md`, `docs/TRUEFORGE_NOTES.md`, `docs/MODELS.md`.

Note: TrueForge must be started with `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]` so it may call the local editor tools.

## Develop
```
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run build       # esbuild: out/extension.js and out/webview.js
npm test            # unit tests (node:test, bundled by esbuild)
npm run smoke       # real TrueForge: registers agents, hello turn on each (needs TrueForge at codecraft.baseUrl)
npm run live-mcp -- [primary|fallback|failover|auto] [reject] [deny]   # live end-to-end check (needs the env var above)
npm run perf-index -- <root>   # index timings (fixtures/flask by default; clone pallets/flask there first)
npm run secret-scan # staged files; add -- --all for every tracked file
```
Press F5 ("Run CodeCraft Extension") and run "CodeCraft: Open Agent Panel". Settings are documented in `config.example.json`.
