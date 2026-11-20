export function buildTownHtml(opts: { cspSource: string; nonce: string; scriptUri: string }): string {
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
<title>CodeCraft: Code Town</title>
<style nonce="${nonce}">
  :root {
    --night-sky: #070b16;
    --night-card: rgba(15, 23, 42, 0.85);
    --border-color: rgba(255, 255, 255, 0.12);
  }
  * { box-sizing: border-box; }
  body, html {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background-color: var(--night-sky);
    color: #e2e8f0;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    user-select: none;
  }
  #canvas-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  #overlay {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    z-index: 10;
    pointer-events: none;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .hud-panel {
    pointer-events: auto;
    background: var(--night-card);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px 14px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .hud-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 6px 0;
    color: #f8fafc;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stats-bar {
    display: flex;
    gap: 8px;
    font-size: 11px;
    flex-wrap: wrap;
  }
  .stat-badge {
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .stat-idle { border-left: 3px solid #475569; }
  .stat-read { border-left: 3px solid #0284c7; }
  .stat-proposed { border-left: 3px solid #f59e0b; }
  .stat-applied { border-left: 3px solid #16a34a; }
  .stat-rejected { border-left: 3px solid #94a3b8; }
  .stat-failed { border-left: 3px solid #ef4444; }
  
  .controls-group {
    display: flex;
    gap: 6px;
  }
  button {
    background: rgba(30, 41, 59, 0.9);
    color: #e2e8f0;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  button:hover {
    background: rgba(51, 65, 85, 0.9);
  }
  button:active {
    background: rgba(15, 23, 42, 1);
  }

  #tooltip {
    position: absolute;
    z-index: 20;
    pointer-events: none;
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    display: none;
    max-width: 280px;
  }
  #tooltip .title { font-weight: 600; margin-bottom: 2px; color: #fff; }
  #tooltip .meta { color: #94a3b8; font-size: 11px; }
  #tooltip .state-tag { margin-top: 4px; display: inline-block; padding: 2px 6px; border-radius: 3px; font-weight: 500; font-size: 10px; }

  /* 2D Fallback View */
  #fallback-view {
    position: absolute;
    top: 70px;
    left: 12px;
    right: 12px;
    bottom: 12px;
    background: var(--night-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    overflow-y: auto;
    z-index: 5;
    display: none;
  }
  .fallback-district {
    margin-bottom: 18px;
  }
  .fallback-district-name {
    font-weight: 600;
    font-size: 13px;
    color: #94a3b8;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .fallback-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  .fallback-card {
    background: rgba(30, 41, 59, 0.6);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    transition: transform 0.1s, border-color 0.1s;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fallback-card:hover {
    border-color: rgba(255, 255, 255, 0.4);
    background: rgba(51, 65, 85, 0.7);
  }
  .fallback-card-title {
    font-size: 12px;
    font-weight: 600;
    color: #f1f5f9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fallback-card-meta {
    font-size: 11px;
    color: #94a3b8;
    display: flex;
    justify-content: space-between;
  }
  .fallback-card-status {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    width: fit-content;
  }
</style>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="overlay">
    <div class="hud-panel">
      <div class="hud-title"><span>🏙️</span> Code Town <span id="active-tag" style="font-size:11px; font-weight:normal; opacity:0.8; margin-left:8px;"></span></div>
      <div class="stats-bar" id="stats-bar">
        <div class="stat-badge stat-idle" id="badge-idle">◻ Idle: 0</div>
        <div class="stat-badge stat-read" id="badge-read">👁 Read: 0</div>
        <div class="stat-badge stat-proposed" id="badge-proposed">✏ Proposed: 0</div>
        <div class="stat-badge stat-applied" id="badge-applied">✔ Applied: 0</div>
        <div class="stat-badge stat-rejected" id="badge-rejected">⊘ Rejected: 0</div>
        <div class="stat-badge stat-failed" id="badge-failed">⚠ Failed: 0</div>
      </div>
    </div>
    <div class="hud-panel controls-group">
      <button id="btn-replay" type="button" title="Replay the last agent run">▶ Replay</button>
      <button id="btn-toggle-view" type="button">Switch to 2D</button>
      <button id="btn-reset-cam" type="button">Reset View</button>
    </div>
  </div>

  <div id="tooltip">
    <div class="title" id="tt-title"></div>
    <div class="meta" id="tt-meta"></div>
    <div class="state-tag" id="tt-state"></div>
  </div>

  <div id="fallback-view">
    <div style="margin-bottom: 12px; font-size: 12px; color: #cbd5e1;">
      2D Town View (Click any building to open in editor)
    </div>
    <div id="fallback-content"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
