# CodeCraft

A VS Code extension that is the interface and editor-tool host for TrueForge agents, with gated hunk review, a recovery journal and (later) Code Town, a read-only 3D view of the repository and the agent's confirmed actions.

TrueForge owns the agent loop and all model calls. CodeCraft never calls providers and never handles API keys.

## Status
P0: scaffold, SDK client wrapper, two registered agents, agent panel. See `docs/TRUEFORGE_NOTES.md`, `docs/MODELS.md`, `docs/CODE_TOWN_INTEGRATION_AUDIT.md`.

## Develop
```
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run build       # esbuild: out/extension.js and out/webview.js
npm test            # unit tests (node:test, bundled by esbuild)
npm run smoke       # real TrueForge: registers agents, hello turn on each (needs TrueForge at codecraft.baseUrl)
npm run secret-scan # staged files; add -- --all for every tracked file
```
Press F5 ("Run CodeCraft Extension") and run "CodeCraft: Open Agent Panel". Settings are documented in `config.example.json`.
