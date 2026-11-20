# TrueForge API notes (observed, v0.185.1)

Everything here was observed against a live instance on 2026-11-20, not taken from documentation.

## Endpoints used
- `GET /api/v1/models` -> `{data:[{name, model_id, provider:{name}, properties}]}`
- `POST /api/v1/sessions` body `{"agent":{"spec":{"model":{"name":"<model>"}}}}` -> `{data:{id,...}}`. Extra keys such as `title` or `agent.type` are rejected (`Unrecognized key`).
- `POST /api/v1/sessions/{id}/turns` body `{"input":[{"type":"user.message","content":"..."}]}` answers with an SSE stream (`data: {json}` lines), not a JSON turn object.
- `GET /api/v1/sessions/{id}/turns` and `/events` list past turns and events.
- Other routes seen in the UI bundle (unverified): `/agents`, `/mcp-servers`, `/capabilities`, `/settings/model-providers`, `/sessions/{id}/cancel`, `/sessions/{id}/grants`, `/sessions/{id}/turns/{turn}/subscribe`.

## Stream events observed
`turn.created`, `model.message`, `model.message.delta` (with `content` or `reasoning_content`, final delta carries `finish_reason` and `usage`), `turn.done`.
Event history also showed `mcp.initialize`.

## Error shape (real)
A provider failure does not fail the HTTP request. The stream ends with:

```json
{"type":"turn.done","state":{"status":"error","message":"[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","metrics":{"total_input_tokens":0,...}}}
```

Only the 503 (unavailable) shape has been observed so far. The shapes for invalid key, rate limit, bad output and context-too-large are UNVERIFIED and must be captured before the P4 classifier relies on them.
