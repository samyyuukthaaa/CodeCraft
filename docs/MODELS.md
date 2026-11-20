# Models

All agent execution and model calls happen inside TrueForge. CodeCraft never calls a model provider directly and never stores, logs or commits API keys. Keys are configured only in TrueForge Settings.

| Role | TrueForge model name | Provider |
|---|---|---|
| Primary | `google-gemini/gemini-3-1-flash-lite` (model id `gemini-3.1-flash-lite`) | `google-gemini` |
| Fallback | `groq/gpt-oss-120b` | `groq` (custom OpenAI-compatible, endpoint `https://api.groq.com/openai/v1`) |

TrueForge: v0.185.1 standalone at `http://localhost:8790` (extension setting `forge.baseUrl`, loopback only).

Model names are overridable in the extension via `forge.primaryModel` and `forge.fallbackModel`. They are names registered in TrueForge, not secrets.

## Verification status (2026-11-20)

- Both models appear in `GET /api/v1/models`.
- `groq/gpt-oss-120b` answered a hello turn through the CodeCraft client path (VERIFIED).
- `google-gemini/gemini-3-1-flash-lite` answered earlier smoke tests in TrueForge, but on 2026-11-20 around 13:26 UTC it returned `[Model Error] Request failed (503): This model is currently experiencing high demand` to the CodeCraft client (VERIFIED, a real provider outage).
- Later the same day (after the outage) `npm run smoke` got a successful hello from both models through the CodeCraft client (VERIFIED, exit 0 each).
- Automatic failover between the two is NOT implemented or verified yet (planned for P4).
- TrueForge has no local sandbox on Windows; tests run through the extension in the workspace with user confirmation.
