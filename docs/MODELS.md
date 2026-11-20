# Models

All agent execution and model calls happen inside TrueForge. CodeCraft never calls a model provider directly and never stores, logs or commits API keys. Keys are configured only in TrueForge Settings.

| Role | Agent name in TrueForge | Setting | Default model reference | Provider |
|---|---|---|---|---|
| Primary | `codecraft-primary` | `codecraft.primaryModel` | `google-gemini/gemini-3-1-flash-lite` (model id `gemini-3.1-flash-lite`) | `google-gemini` |
| Fallback | `codecraft-fallback` | `codecraft.fallbackModel` | `google-gemini/gemini-3-5-flash-lite` (model id `gemini-3.5-flash-lite`) | `google-gemini` |

Both agents get identical instructions (`AGENT_INSTRUCTIONS` in `src/trueforge/config.ts`) and the same editor tools, so only the model differs.

**Swapping the fallback (or primary) needs no code change.** Set `codecraft.fallbackModel` to any model reference registered in TrueForge (`GET /api/v1/models` lists them, any provider). On the next run CodeCraft calls `ensureAgents`, which updates the `codecraft-fallback` agent in TrueForge to that model. Keys for the new provider are added in TrueForge Settings, never in CodeCraft.

TrueForge: v0.185.1 standalone at `http://localhost:8790` (setting `codecraft.baseUrl`, loopback only), started with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` so it can reach the local editor tools. Settings are documented in `config.example.json`.

## Failover (P1, minimal)
If a run on `codecraft-primary` ends in an error (provider error or a failed session), the same request is run on `codecraft-fallback` in its own session, with a note to re-read files first. Done, Stop Run (cancelled) and unsupported outcomes never fail over. The write gate makes a re-run safe: nothing is applied without a fresh read, a stale check and a new per-hunk decision. Error classes, retries, circuit breaking and journal-based resume come in P4.

Known risk: both models currently use the same provider (`google-gemini`), so a provider-wide outage or a revoked Gemini key takes out both. See the dropped Groq candidates in `docs/TRUEFORGE_NOTES.md`.

## Live verification (2026-11-20, `npm run live-mcp`)
| Run | Result |
|---|---|
| `fallback` approve | Fallback completed read_file, approval pause, resume; 1 hunk applied |
| `fallback reject` | Approval pause and resume; all hunks rejected; nothing written |
| `failover` approve (primary forced to fail with `temperature: 99`, provider 400) | Switched once to `codecraft-fallback`; 1 hunk applied |
| `failover reject` (same forced fault) | Switched once; hunks rejected; nothing written |
| `auto` (real primary, then real fallback) | Real primary failure `Cannot connect to API: Headers Timeout Error`; switched once; 1 hunk applied |
| `primary` only | Earlier in the day: approve, hunk reject and deny all passed. On the last run the primary returned a real 503 (`high demand`), reported as an error with nothing written |
| `ensureAgents` | `codecraft-fallback: updated` once after the model change, then `unchanged` |
