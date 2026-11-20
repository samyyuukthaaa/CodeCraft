# Models

All agent execution and model calls happen inside TrueForge. CodeCraft never calls a model provider directly and never stores, logs or commits API keys. Keys are configured only in TrueForge Settings.

| Role | Agent name in TrueForge | TrueForge model name | Provider |
|---|---|---|---|
| Primary | `codecraft-primary` | `google-gemini/gemini-3-1-flash-lite` (model id `gemini-3.1-flash-lite`) | `google-gemini` |
| Fallback | `codecraft-fallback` | `groq/gpt-oss-120b` | `groq` (custom OpenAI-compatible, endpoint `https://api.groq.com/openai/v1`) |

Both agents get identical instructions (`AGENT_INSTRUCTIONS` in `src/trueforge/config.ts`), so only the model differs.

TrueForge: v0.185.1 standalone at `http://localhost:8790` (setting `codecraft.baseUrl`, loopback only).
Settings: `codecraft.baseUrl`, `codecraft.primaryModel`, `codecraft.fallbackModel` (see `config.example.json`). These are model names registered in TrueForge, not secrets.

## Verification status (2026-11-20)
- Both models appear in `GET /api/v1/models` (14 models registered).
- `npm run smoke` registered both agents and got `CODECRAFT HELLO` from each through the SDK (VERIFIED-RUN). A second run reported both agents `unchanged`.
- Earlier the same day `google-gemini/gemini-3-1-flash-lite` returned `[Model Error] Request failed (503)` to two consecutive turns (a real provider outage), then recovered.
- Automatic failover between the two is NOT implemented or verified yet (planned for P4).
- TrueForge has no local sandbox on Windows; tests run through the extension in the workspace with user confirmation.
