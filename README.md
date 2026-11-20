# CodeCraft

A VS Code extension that is the interface and editor-tool host for TrueForge agents, with gated hunk review, a recovery journal and (later) Code Town, a read-only 3D view of the repository and the agent's confirmed actions.

TrueForge owns the agent loop and all model calls. CodeCraft never calls providers and never handles API keys.

## Status
P0: scaffold and TrueForge hello. See `docs/CODE_TOWN_INTEGRATION_AUDIT.md`, `docs/MODELS.md`, `docs/TRUEFORGE_API_NOTES.md`.

## Develop
```
npm install
npm test            # build + unit tests
npm run smoke       # real TrueForge hello (needs TrueForge at forge.baseUrl)
npm run secret-scan # staged files; add -- --all for every tracked file
```
Press F5 ("Run CodeCraft Extension") and run the command "CodeCraft: Hello TrueForge".
