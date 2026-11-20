# Editor MCP server (P1)

`src/mcp` hosts a local MCP server (streamable HTTP, stateless, `127.0.0.1`, random port, in-memory bearer token, Host and Origin checks). TrueForge connects to it; it is the only route for agent file operations.

| Tool | Approval in TrueForge | Behaviour |
|---|---|---|
| `read_file(path)` | no | Returns content (limit 200,000 chars) and records its hash so a later write can be stale-checked |
| `list_files(prefix?)` | no | Workspace files, max 500, excludes `.git`, `node_modules`, `.env*`, keys, `out/` |
| `search_text(query, prefix?)` | no | Case-insensitive plain text, max 100 matches |
| `search_symbols(query, kind?, limit?)` | no | Classes, functions and methods from the repository index (P2, see `docs/REPO_INDEX.md`) |
| `list_related(path)` | no | Imported files, importers and matching tests |
| `propose_write(path, newContent, reason)` | **yes** | Never writes by itself. See below |
| `propose_changes(plan, groups[{intent, files[{path, newContent}]}])` | **yes** | Multi-file change set grouped by intent. Never writes by itself; see "Change sets" below |
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

## Change sets (P3)
`propose_changes` carries a short plan and up to 10 groups (intent such as "implement", "update callers", "add test", "docs"), at most 20 files, each file in exactly one group. The gate refuses the WHOLE set before review if any existing file was not read or changed since it was read. Review: Accept all, Reject all, or Review by group, where each group can be accepted, rejected, or reviewed hunk by hunk (accept or reject the rest of a group at any point). Esc rejects everything not yet decided and keeps decisions already made. All accepted hunks across all files are applied in one `WorkspaceEdit` (one undo step); `Undo Last Change` reverts the whole set only if every file is still exactly what CodeCraft wrote. The result lists, per file, its group and how many hunks were accepted and rejected.

## Plan before proposing
`submit_plan(summary, files[{path, action: edit|create|context, why}])` is required before any `propose_write` / `propose_changes`; only files listed as edit or create may be proposed (the agent can resubmit). The plan is shown in the panel's **Plan** section before any change is reviewed.

## Stop Run
`CodeCraft: Stop Run` is immediate and leaves the workspace consistent: the open review quick pick is closed through its cancellation token (counts as reject), any proposal that is open or queued is refused before it writes, a running test command is killed, the stream is aborted and the TrueForge session is cancelled. Change sets are applied atomically (one `WorkspaceEdit`), so a stop never leaves a half-applied set; changes accepted before Stop stay applied and `Undo Last Change` reverts the last one in one step.

## Approval flow (verified live with the primary agent)
The model reaches these tools through TrueForge's `call_tool` system tool. When it calls `propose_write` or `run_tests`, TrueForge pauses the turn (`tool.approval_required` + `turn.update paused`). CodeCraft asks you, posts `user.tool_approval` to the paused turn with `createTurnEvents`, and resumes the same turn with `subscribeToTurn`. Approving only lets the call proceed: `propose_write` still needs your per-hunk review before anything is written.

## Known constraint: TrueForge must allow the local URL
TrueForge's SSRF guard rejects loopback MCP URLs. Start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. See `docs/TRUEFORGE_NOTES.md`.
