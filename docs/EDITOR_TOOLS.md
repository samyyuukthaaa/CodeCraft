# Editor MCP server (P1)

`src/mcp` hosts a local MCP server (streamable HTTP, stateless, `127.0.0.1`, random port, in-memory bearer token, Host and Origin checks). TrueForge connects to it; it is the only route for agent file operations.

| Tool | Approval in TrueForge | Behaviour |
|---|---|---|
| `read_file(path)` | no | Returns content (limit 200,000 chars) and records its hash so a later write can be stale-checked |
| `list_files(prefix?)` | no | Workspace files, max 500, excludes `.git`, `node_modules`, `.env*`, keys, `out/` |
| `search_text(query, prefix?)` | no | Case-insensitive plain text, max 100 matches |
| `propose_write(path, newContent, reason)` | **yes** | Never writes by itself. See below |
| `run_tests()` | **yes** | Runs `codecraft.testCommand` (default `npm test`) in the workspace after a modal confirmation; reports the real exit code |

The spec said "propose_write and run_command"; there is no `run_command` tool (an arbitrary-command tool was deliberately not added), so the approval list is `propose_write` and `run_tests`.

## propose_write and the write gate (`src/mcp/gate.ts`)
1. Path must be workspace-relative (no `..`, absolute paths, `.git`, `.env*`, keys).
2. An existing file must have been read with `read_file`, and must be unchanged since (stale check). New files need no prior read.
3. Hunks are computed (`src/mcp/diff.ts`); the user sees a VS Code diff and decides per hunk (accept, reject, accept all, reject all). Esc or closing means reject.
4. `WriteGate.applyApproved(path, newContent)` is the only writer. It refuses without a stored decision for that exact path and content hash, refuses if the file changed after the proposal, and decisions are single use.
5. Only accepted hunks are applied, in one `WorkspaceEdit` (one undo step), then saved. A file with unsaved editor changes is refused.
6. The tool result states what was applied: `applied`, `partially_applied`, `rejected` or an error. A proposal is never reported as a write.

`CodeCraft: Undo Last Change` reverts the last applied change only if the file is still exactly what CodeCraft wrote. `CodeCraft: Stop Run` aborts the stream and cancels the session.

## Known constraint: TrueForge must allow the local URL
TrueForge's SSRF guard rejects loopback MCP URLs. Start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. See `docs/TRUEFORGE_NOTES.md`.
