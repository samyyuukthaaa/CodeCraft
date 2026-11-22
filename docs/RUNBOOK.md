# Runbook: the 3-in-a-row scenario runs

For teammates running the three fixed tasks live. Windows PowerShell, from the repository root. All runs must use **one commit**: do not pull or commit between them.

## 1. Prerequisites (once)
- Node.js 22 or newer, Git, Python 3.12.
- `npm install` in the repository root.
- The Flask fixture and its virtual environment, exactly as in [FIXTURE.md](FIXTURE.md) (clone tag 3.1.3, create `fixtures/flask/.venv`, install the pinned packages). Check: `git -C fixtures/flask rev-parse HEAD` prints `22d924701a6ae2e4cd01e9a15bbaf3946094af65`.

## 2. Start TrueForge (keep this window open)
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
```
It serves http://localhost:8790. Without `OUTBOUND_URL_ALLOWED_HOSTS` TrueForge cannot reach CodeCraft's editor tools.

## 3. Add the Gemini key (only in TrueForge)
Open http://localhost:8790 → **Settings → Model providers**, add the Google Gemini provider with the key. **Never put a key in this repository**, in a file, a command or a chat message.

## 4. Confirm both models answer (2–7 requests each)
```powershell
npm run probe -- --agent primary
npm run probe -- --agent fallback
```
- Primary (`google-gemini/gemini-3-5-flash-lite`): must end with `probe: PASS`.
- Fallback (`google-gemini/gemini-3-1-flash-lite`): look at `editor tool calls that reached CodeCraft`. It is fine if real `list_files` calls are listed, even when the probe says FAIL because it went over 6 requests.
- Stop and report if either shows a 429 with "per day", or a certificate / TLS error.

Use a stable network (no VPN switching, no sleep). The free tier allows 15 requests per minute and 500 per day per model; a passing Task B uses about 20–25 requests.

## 5. The runs (3 each, stop at the first failure)
```powershell
git rev-parse --short HEAD   # note this commit; it must not change until the end
foreach ($t in 'task2', 'task1', 'task3') {
  npm run scenario -- $t --runs 3 --record 2>&1 | Tee-Object -FilePath "out\run-$t.log"
  if ($LASTEXITCODE -ne 0) { Write-Host "STOP: $t failed (exit code $LASTEXITCODE). Do not re-run; report it."; break }
}
```
`task3` runs both variants (fallback and no fallback), 3 runs each. Each scenario already stops after its first failed run. Exit code 3 means a TLS certificate error: fix the network, do not retry blindly.

## 6. What a pass looks like
Every run ends with `RUN PASS`, every check line starts with `[PASS]`, and the summary table at the end shows `PASS` in every row:

| column | meaning |
|---|---|
| result | PASS or FAIL for the whole run |
| agent | the agent that finished; `(failover x1)` means the fallback took over |
| files changed | what was written to the fixture (Task C: must be none) |
| files read | files the agent read / files in the index |
| tokens, time | cost of the run |
| failed checks | empty on a pass; otherwise the names of the failed checks |

`--record` also appends the table to `docs/RESULTS.md` and the full JSON to `docs/results/`.

## 7. On a failure, paste back
1. The commit from `git rev-parse --short HEAD`.
2. The last 40 lines of `out\run-<task>.log` (the `[FAIL]` lines, `outcome=…`, any `RETRY`, `FAILOVER`, `AUTO-ANSWER` or `TIME LIMIT` lines and the session URLs).
3. Whether TrueForge's window showed an error.

Never paste anything that contains a key.

## 8. After all of task2, task1 and task3 pass 3 in a row on the same commit
```powershell
git add docs/RESULTS.md docs/results
git commit -m "Results: task1, task2, task3 pass 3 in a row on <commit>"
git push origin main
git tag -a submission-safe -m "All three tasks pass 3 in a row on <commit>"
git push origin submission-safe
```
Tag only if every run passed. If anything failed, commit the results honestly and do not tag.
