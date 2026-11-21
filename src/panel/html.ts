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
</style>
</head>
<body>
  <h3>CodeCraft Agent</h3>
  <label for="prompt">Prompt</label>
  <textarea id="prompt" maxlength="8000">Say hello.</textarea>
  <div><button id="send" type="button">Send</button> <span id="status" role="status" aria-live="polite">idle</span></div>
  <div id="answer" aria-live="polite"></div>
  <section id="health" aria-labelledby="health-h">
    <h4 id="health-h">Provider health</h4>
    <p class="muted">Status of the configured models. Keys are managed in TrueForge Settings and are never shown here.</p>
    <table><thead><tr><th>Role</th><th>Model</th><th>Status</th><th>Last error</th><th>When</th></tr></thead><tbody id="health-rows"></tbody></table>
    <div><button id="test-providers" type="button">Test providers</button> <span id="health-note" class="muted" role="status" aria-live="polite"></span></div>
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
    <table><thead><tr><th>File</th><th>Reason</th><th class="num">Tokens (est.)</th></tr></thead><tbody id="context-rows"></tbody></table>
  </section>
  <h4>Event stream</h4>
  <ul id="events" aria-label="Live event stream"></ul>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
