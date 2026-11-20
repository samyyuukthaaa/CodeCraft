# TrueForge notes

Server: TrueForge 0.185.1 standalone at `http://localhost:8790`. SDK: `@truefoundry/trueforge-sdk` 0.185.0 (pinned; Node >= 22; ESM package with a CJS build; Fern-generated).
Legend: VERIFIED-RUN = executed against the live server on 2026-11-20. VERIFIED-DOCS = read in the SDK README, `reference.md` or `.d.ts` types. UNVERIFIED = assumption.

## Docs situation
- https://trueforge.dev/llms.txt lists the doc pages. There are no dedicated pages for turns, events or errors, and no error reference. The OpenAPI spec is said to be served at `/api/v1/docs` on the server (UNVERIFIED: `GET /api/v1/docs` was not fetched; `/docs` and `/openapi.json` return 404).
- The SDK README shows only `createTurnStream` and `TrueForgeError`. Everything else below came from `reference.md`, the type definitions or running it.

## SDK calls used
| Call | Status |
|---|---|
| `new TrueForge({ baseUrl, token? })` | VERIFIED-RUN (no token needed on this server; `auth/me` returns the default admin) |
| `client.agents.list({ agentName, limit })` -> async-iterable page | VERIFIED-RUN (used by `ensureAgent`) |
| `client.agents.create({ name, description, manifest })` | VERIFIED-RUN. Fails if the name exists; name is immutable |
| `client.agents.update(agentId, { description, manifest })` | VERIFIED-DOCS and unit-tested with a fake; not run live (live runs never needed an update) |
| `client.sessions.create({ agent: { name } })` -> `{ data: { id, ... } }` | VERIFIED-RUN |
| `client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content }] }, { abortSignal })` | VERIFIED-RUN (`abortSignal` typechecks; aborting was not exercised) |
| `TrueForgeError` (`statusCode`, `message`, `body`) | VERIFIED-RUN: unknown session -> `NotFoundError`, 404, body `{"error":{"message":"Session not found: nonexistent"}}` |

## Agent manifest
`AgentSpec`: `model {name, params?}`, `instructions?`, `mcpServers? [{name, enableTools?, disableTools?, preload?, requireApprovalForTools?}]`, `messages?`, `skills?`, `responseFormat?`, `config?` (VERIFIED-DOCS types).
CodeCraft registers `codecraft-primary` and `codecraft-fallback` with identical instructions and different models; this was created then reported `unchanged` on a second run (VERIFIED-RUN).

## Stream events
Union (VERIFIED-DOCS): `turn.created`, `turn.done`, `turn.update`, `model.message`, `model.message.delta`, `tool.approval_required`, `tool.response_required`, `tool.response`, `mcp.initialize`, `mcp.auth_required`, `sandbox.created`, `thread.created`, `thread.done`, thread context compaction started/finished, user approval/response/auth events.
Seen in a plain hello turn (VERIFIED-RUN): `turn.created`, `model.message`, `model.message.delta`, `turn.done`.
- The wire format is snake_case; the SDK deserializes to camelCase (VERIFIED-RUN: `turnId`, `previousTurnId`, `createdAt`, `threadId`, `reasoningContent`).
- `turn.created`: `{id, turnId, previousTurnId, input, state:{status:'running'}, createdAt, threadId}`.
- `model.message.delta`: `content?` (answer text) or `reasoningContent?`; the last delta carries `finishReason` and `usage`.
- `turn.done`: `state` is one of `done` (`output`, `requiredActions`), `error` (`message`), `cancelled`, `paused`, `running`.
- `tool.response_required` / `tool.approval_required`: `{id, threadId, toolCalls:[{id, sourceEventId}]}`. These look like the hook for host-side tools and approvals (needed in P1). The exact round trip is UNVERIFIED: see `sessions.createTurnEvents` and the `user.tool_response` / `user.tool_approval` events, not yet exercised.
- The SDK also exports `isEventDelta` and `mergeEventDelta` for assembling deltas (not yet used).

## Real error text observed
A provider failure does NOT make the HTTP request or the SDK call throw. The stream ends normally with `turn.done` whose state is an error. Observed twice on 2026-11-20 (about 13:26 UTC) from `google-gemini/gemini-3-1-flash-lite`, via the raw HTTP stream before the SDK was adopted:

```
turn.done  state.status = "error"
state.message = "[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."
state.metrics  total_input_tokens = 0, total_output_tokens = 0
```

More real error texts observed on 2026-11-20 (all as `turn.done` with `state.status: "error"`, none thrown):

| Text | Source | Likely class (P4) |
|---|---|---|
| `[Model Error] Request failed (503): This model is currently experiencing high demand. ...` | gemini-3-1-flash-lite, natural, several times | unavailable_or_timeout |
| `[Model Error] Cannot connect to API: Headers Timeout Error` | gemini-3-1-flash-lite, natural | unavailable_or_timeout |
| `[Model Error] Request failed (200): Failed to process successful response: ... terminated: read ECONNRESET` | groq/gpt-oss-120b, natural, once | unavailable_or_timeout |
| `[Model Error] Request failed (400): * GenerateContentRequest.generation_config.temperature: temperature must be in the range [0.0, 2.0].` | forced in the live test (`temperature: 99`) | bad request (not one of the five classes) |
| `[Model Error] Request failed (400): 'messages.2' : ... property 'reasoning_content' is unsupported` | groq/gpt-oss-120b on tool use | provider incompatibility |

Thrown at session creation (HTTP 422 from TrueForge, before any turn): `Unknown model "<ref>" — not configured on provider`, and `Reasoning effort "<x>" is not supported by model "<ref>"`.

Not yet observed (UNVERIFIED, needed before P4's classifier): invalid or revoked key, rate limit (and any retry hint), bad output, context too large.

## Fallback model history (why candidates were dropped)
| Candidate | Status | Evidence |
|---|---|---|
| `groq/gpt-oss-120b` | Dropped | VERIFIED-RUN by CodeCraft: answers single turns, but every tool-using turn fails on the second model call with HTTP 400 `property 'reasoning_content' is unsupported` (TrueForge echoes the reasoning back to Groq). The params `include_reasoning:false`, `reasoning_format:"hidden"` and `reasoningEffort:"low"` did not help; `reasoningEffort:"none"` is rejected by Groq. Details below. |
| `groq` `llama-3.3-70b-versatile` | Dropped | Reported by the project owner: Groq retired this model on 16 Aug 2026. Not tested by CodeCraft. |
| `groq` `qwen/qwen3.6-27b` | Dropped | Reported by the project owner: returns 404 on the project's Groq key. Not tested by CodeCraft. |
| `google-gemini/gemini-3-5-flash-lite` | **Current fallback** | VERIFIED-RUN: tool use, approval pause/resume, approve and hunk reject, and failover from a failing primary (forced and natural) all pass. See `docs/MODELS.md`. |

Consequence: primary and fallback now share the `google-gemini` provider, so failover covers per-model failures (overload, timeouts, bad requests) but not a Gemini-wide outage or a revoked Gemini key.

## MCP registration and approvals (P1)
- `client.settings.mcpServers.createOrUpdate({ manifest: { type: 'remote', name, description, url, auth?: { type: 'header', headers } } })` is the registration call (VERIFIED-DOCS types). Agents then mount it with `manifest.mcpServers: [{ name, requireApprovalForTools: [...] }]`; selectors are `@all`, `@write`, `@destructive` or tool names (VERIFIED-DOCS types).
- VERIFIED-RUN: TrueForge REJECTS the registration of any loopback or private URL: HTTP 400 `Outbound URL blocked for host "127.0.0.1"`; the same for `localhost`, `[::1]`, `0.0.0.0`, `host.docker.internal` and `192.168.1.5`. This is TrueForge's SSRF guard (`trueforge-core/dist/core/util/ssrfGuard.js`).
- The override found in the TrueForge package source (`dist/main.js`) is the environment variable `OUTBOUND_URL_ALLOWED_HOSTS`, a JSON string array; `NETWORK_POLICY_ENABLED=false` disables the guard entirely. VERIFIED-RUN: with TrueForge restarted with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`, registration succeeds and TrueForge connects (`mcp.initialize` event, transport `streamable-http`).
- VERIFIED-RUN: the server stores agent manifests with defaults filled in (`enableTools:["@all"]`, `disableTools:[]`, `preloadTools:[]`, `preload:false`, a full `config` block). `ensureAgent` therefore compares only the fields CodeCraft sets (model, instructions, MCP server names and approval lists); live runs then report `unchanged`.

### How MCP tools reach the model (VERIFIED-RUN, primary agent)
- The model does not see `propose_write` directly. TrueForge exposes system tools (`toolInfo.type: "truefoundry-system"`): `list_tools {mcp_server}`, `get_tool_info {mcp_server, tool_name}` and `call_tool {mcp_server, tool_name, input}`. A typical run calls `list_tools`, `get_tool_info` twice, then `call_tool` for `read_file` and `propose_write`.
- So `function.name` is `call_tool`, and the real tool and its arguments are inside `function.arguments`. CodeCraft unwraps this (`resolveCall`) and shows `codecraft-editor/propose_write` with only path and reason.
- Tool calls arrive ONLY in streamed `model.message.delta` events: the first fragment carries `index`, `id`, `type`, `toolInfo` and `function.name` with empty arguments; later fragments carry only `index` and `function.arguments` pieces. No final `model.message` lists the calls. CodeCraft assembles them by message id + index.

### Approval pause and resume (VERIFIED-RUN, primary agent)
- The pause is `tool.approval_required {threadId:"main", toolCalls:[{id, sourceEventId}]}` followed by `turn.update {state:{status:"paused"}}`. The stream then stays OPEN and no `turn.done` arrives; a client waiting for `turn.done` hangs (observed before the fix).
- Resume that works: `sessions.createTurnEvents(sessionId, turnId, { events: [{ type:'user.tool_approval', threadId, toolCallId, approval:{status:'allow'} | {status:'deny', reason} }] })`, then `sessions.subscribeToTurn(sessionId, turnId, { afterEventId: <id of the turn.update> })`. The resumed stream shows `user.tool_approval`, `turn.update running`, `tool.response`, `model.message`, `turn.done`. It is the SAME turn, not a new one.
- Deny: TrueForge does not call the tool; the model receives `{"error":"User denied tool call: <reason>"}` as the tool response.
- The "new turn with `user.tool_approval` input" route is kept only for a turn that ENDS with `turn.done` + `requiredActions`; that shape was not observed live.
- `client.sessions.cancel(sessionId, {})` exists (VERIFIED-DOCS); not exercised live.

### Fallback model cannot complete tool-using turns (VERIFIED-RUN)
- `groq/gpt-oss-120b` (custom OpenAI-compatible provider `groq`) answers single turns, but every turn with a tool call fails on the second model call: `[Model Error] Request failed (400): 'messages.2' : for 'role:assistant' the following must be satisfied[('messages.2' : property 'reasoning_content' is unsupported)]`. TrueForge echoes the model's `reasoning_content` back in the assistant message and Groq rejects it.
- Tried as agent model params, all still fail: `{"include_reasoning":false}`, `{"reasoning_format":"hidden"}` (same 400; reasoning deltas still streamed, so the params are not forwarded or are ignored), `{"reasoningEffort":"low"}` (same 400), `{"reasoningEffort":"none"}` (Groq: `reasoning_effort must be one of low, medium, or high`).
- The custom provider manifest (`type: custom`, `baseUrl`, `models`, `auth`) has no option to drop reasoning from history. This needs a change in TrueForge or a different fallback model; it cannot be fixed in the extension.
- Also seen once, on a plain turn: `[Model Error] Request failed (200): Failed to process successful response: ... terminated: read ECONNRESET` (transient).

## Other assumptions
- The webview and extension host were not run inside VS Code in this session (no GUI); see the P0 report.
- A new session is created per extension-host session and per settings change; sessions are not deleted.
- TrueForge standalone is documented as localhost-only; `codecraft.baseUrl` is rejected unless it is loopback.
