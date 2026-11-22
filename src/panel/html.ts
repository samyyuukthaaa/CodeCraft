// Pure HTML builder for the agent panel. Strict CSP: no inline script, nonce-gated script and style,
// no remote resources.
export function buildHtml(opts: { cspSource: string; nonce: string; scriptUri: string }): string {
  const { cspSource, nonce, scriptUri } = opts;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeCraft Agent</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; }
  #prompt { width: 100%; box-sizing: border-box; min-height: 64px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  button { margin: 6px 0; padding: 4px 12px; color: var(--vscode-button-foreground);
    background: var(--vscode-button-background); border: 0; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #answer { white-space: pre-wrap; padding: 6px; margin: 6px 0; border-left: 3px solid var(--vscode-focusBorder); }
  #events { font-family: var(--vscode-editor-font-family); font-size: 12px; list-style: none; padding: 0; }
  #events li.failed { color: var(--vscode-errorForeground); }
  #status { font-size: 12px; opacity: .8; }
  #context table { border-collapse: collapse; font-size: 12px; width: 100%; }
  #context td, #context th { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  #context td.num, #context th.num { text-align: right; }
  #context tr.excluded { opacity: .6; }
  #plan table, #health table { border-collapse: collapse; font-size: 12px; width: 100%; }
  #health td, #health th { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  #health td.paused { color: var(--vscode-errorForeground); }
  #plan table { border-collapse: collapse; font-size: 12px; width: 100%; }
  #plan td, #plan th { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .muted { font-size: 12px; opacity: .8; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  #tasks button { margin-right: 4px; }
  #question { padding: 6px 8px; margin: 6px 0; border: 1px solid var(--vscode-focusBorder); }
  #question-input { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  #warn { padding: 4px 8px; border-left: 3px solid var(--vscode-editorWarning-foreground, orange); font-size: 12px; }
  #groups { list-style: none; padding: 0; font-size: 12px; }
  #groups li { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .tag { display: inline-block; padding: 0 6px; border-radius: 3px; font-weight: 600; margin-right: 6px; }
  .tag.sure { background: var(--vscode-testing-iconPassed, green); color: var(--vscode-editor-background); }
  .tag.check { background: var(--vscode-editorWarning-foreground, orange); color: var(--vscode-editor-background); }
  .tag.risky { background: var(--vscode-errorForeground, red); color: var(--vscode-editor-background); }
  #metrics dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 12px; margin: 0; }
  #metrics dd { margin: 0; }
</style>
</head>
<body>
  <h3>CodeCraft Agent</h3>
  <div id="tasks" role="group" aria-label="Task templates">
    <button type="button" class="secondary" data-task="fix">Fix this bug</button>
    <button type="button" class="secondary" data-task="rename">Rename across files</button>
    <button type="button" class="secondary" data-task="tests">Add tests</button>
  </div>
  <label for="prompt">Prompt</label>
  <textarea id="prompt" maxlength="8000">Say hello.</textarea>
  <div><button id="send" type="button">Send</button> <span id="status" role="status" aria-live="polite">idle</span></div>
  <section id="question" hidden aria-labelledby="question-h">
    <h4 id="question-h">The agent has a question</h4>
    <p id="question-text"></p>
    <div id="question-options" role="group" aria-label="Suggested answers"></div>
    <label for="question-input" class="muted">Or type your answer</label>
    <input id="question-input" type="text" maxlength="2000">
    <button id="question-send" type="button">Answer</button>
  </section>
  <div id="answer" aria-live="polite"></div>
  <section id="changes" aria-labelledby="changes-h">
    <h4 id="changes-h">Changes</h4>
    <p id="warn" hidden></p>
    <ul id="groups" aria-label="Change groups"></ul>
    <p class="muted">Confidence: <b>sure</b> = small, planned, covered by tests; <b>check this</b> = larger, untested or used elsewhere; <b>risky</b> = outside the plan, very large, widely used, or tests broke. Rules: docs/TRUST.md.</p>
    <div><button id="rollback" type="button" class="secondary">Roll back…</button> <button id="export-report" type="button" class="secondary">Export report</button></div>
  </section>
  <section id="metrics" aria-labelledby="metrics-h">
    <h4 id="metrics-h">Cost and speed</h4>
    <dl>
      <dt>Model</dt><dd id="m-model">-</dd>
      <dt>Tokens</dt><dd id="m-tokens">-</dd>
      <dt>Elapsed</dt><dd id="m-elapsed">-</dd>
      <dt>Files read</dt><dd id="m-files">-</dd>
    </dl>
  </section>
  <section id="health" aria-labelledby="health-h">
    <h4 id="health-h">Provider health</h4>
    <p class="muted">Status of the configured models. Keys are managed in TrueForge Settings and are never shown here.</p>
    <table><thead><tr><th>Role</th><th>Model</th><th>Status</th><th>Last error</th><th>When</th></tr></thead><tbody id="health-rows"></tbody></table>
    <div><button id="test-providers" type="button">Test providers</button> <button id="inject-fault" type="button" title="Testing: make the next run fail on purpose to exercise retries and failover">Inject fault…</button> <span id="health-note" class="muted" role="status" aria-live="polite"></span></div>
  </section>
  <section id="plan" aria-labelledby="plan-h">
    <h4 id="plan-h">Plan</h4>
    <p id="plan-summary" class="muted">The agent shows its plan here before proposing any change.</p>
    <table><thead><tr><th>File</th><th>Action</th><th>Why</th></tr></thead><tbody id="plan-rows"></tbody></table>
  </section>
  <section id="context" aria-labelledby="context-h">
    <h4 id="context-h">Context used</h4>
    <p id="context-summary" class="muted">No request yet.</p>
    <p id="reads" class="muted"></p>
    <p id="read-budget" class="muted" role="status"></p>
    <table><thead><tr><th>File</th><th>Reason</th><th class="num">Tokens (est.)</th></tr></thead><tbody id="context-rows"></tbody></table>
  </section>
  <h4>Event stream</h4>
  <ul id="events" aria-label="Live event stream"></ul>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
