// Code Town webview HTML. Strict CSP: no inline script, no inline style attributes (every style is in the
// nonce'd stylesheet; dynamic colours are set through the CSSOM, which CSP allows), no remote resources.
import { STATE_VISUALS } from './types';

export function buildTownHtml(opts: { cspSource: string; nonce: string; scriptUri: string }): string {
  const { cspSource, nonce, scriptUri } = opts;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');
  const badges = Object.entries(STATE_VISUALS)
    .map(([k, v]) => `<div class="stat-badge stat-${k}" id="badge-${k}" data-icon="${v.icon}" data-label="${v.label}">${v.icon} ${v.label}: 0</div>`)
    .join('\n        ');
  const stateRules = Object.entries(STATE_VISUALS)
    .map(([k, v]) => `  .stat-${k} { border-left: 3px solid ${v.color}; }`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeCraft: Code Town</title>
<style nonce="${nonce}">
  :root { --night-sky: #0a1330; --night-card: rgba(12, 21, 48, 0.86); --border-color: rgba(255, 255, 255, 0.14); --warm: #facc15; }
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: var(--night-sky); color: #e2e8f0;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif); user-select: none; }
  body.pointer { cursor: pointer; }
  .hidden { display: none !important; }
  .muted { color: #94a3b8; font-size: 12px; }
  #canvas-container { position: absolute; inset: 0; z-index: 1; }
  canvas { display: block; width: 100%; height: 100%; }
  #overlay { position: absolute; top: 12px; left: 12px; right: 12px; z-index: 10; pointer-events: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .hud-panel { pointer-events: auto; background: var(--night-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45); }
  .hud-title { font-size: 15px; font-weight: 800; margin: 0 0 6px 0; color: #ffffff; display: flex; align-items: center; gap: 6px; }
  .hud-title .keyword { color: var(--warm); }
  #active-tag { font-size: 11px; font-weight: 400; opacity: 0.85; margin-left: 8px; }
  .stats-bar { display: flex; gap: 6px; font-size: 11px; flex-wrap: wrap; }
  .stat-badge { padding: 2px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.08); }
${stateRules}
  .stat-power { border-left: 3px solid #22c55e; font-weight: 600; }
  .controls-group { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .controls-group button { white-space: nowrap; }
  button { background: rgba(30, 41, 59, 0.92); color: #e2e8f0; border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: rgba(51, 65, 85, 0.92); }
  button:disabled { opacity: 0.5; cursor: default; }
  #tooltip { position: absolute; z-index: 20; pointer-events: none; background: rgba(12, 21, 48, 0.96); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px;
    padding: 8px 12px; font-size: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); display: none; max-width: 340px; }
  #tooltip.show { display: block; }
  #tooltip .title { font-weight: 700; margin-bottom: 2px; color: #fff; word-break: break-all; }
  #tooltip .meta { color: #94a3b8; font-size: 11px; }
  #tooltip .state-tag { margin-top: 4px; display: inline-block; padding: 2px 6px; border-radius: 3px; border: 1px solid; font-weight: 600; font-size: 11px; }
  #fallback-view { position: absolute; top: 96px; left: 12px; right: 12px; bottom: 12px; background: var(--night-card); border: 1px solid var(--border-color);
    border-radius: 10px; padding: 16px; overflow-y: auto; z-index: 5; display: none; }
  #fallback-view.show { display: block; }
  .fallback-intro { margin-bottom: 12px; font-size: 12px; color: #cbd5e1; }
  .fallback-district { margin-bottom: 18px; }
  .fallback-district-name { font-weight: 700; font-size: 13px; color: #ffffff; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .fallback-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
  .fallback-card { background: rgba(30, 41, 59, 0.6); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .fallback-card:hover { border-color: rgba(255, 255, 255, 0.4); }
  .fallback-card.active { border-color: var(--warm); box-shadow: 0 0 10px rgba(250, 204, 21, 0.35); }
  .fallback-card-title { font-size: 12px; font-weight: 700; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fallback-card-meta { font-size: 11px; color: #94a3b8; }
  .mode-switch { display: flex; gap: 0; }
  .mode-switch button { border-radius: 0; }
  .mode-switch button:first-child { border-radius: 6px 0 0 6px; }
  .mode-switch button:last-child { border-radius: 0 6px 6px 0; }
  .mode-switch button[aria-pressed="true"] { background: #facc15; color: #0a1330; font-weight: 700; }
  #legend { position: absolute; left: 12px; bottom: 12px; z-index: 10; font-size: 11px; max-width: 300px; }
  #legend h5 { margin: 6px 0 3px; font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.04em; }
  #legend h5:first-child { margin-top: 0; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  #inspector { position: absolute; right: 12px; top: 96px; z-index: 12; width: 320px; max-height: calc(100% - 120px); overflow-y: auto; font-size: 12px; }
  .insp-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .insp-head b { font-size: 14px; color: #ffffff; word-break: break-all; }
  .insp-head button { padding: 2px 8px; }
  #insp-path { margin: 2px 0 8px; word-break: break-all; }
  #insp-rows { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 0 0 10px; }
  #insp-rows dt { color: #94a3b8; }
  #insp-rows dd { margin: 0; word-break: break-word; }
  .fallback-card-status { font-size: 11px; padding: 2px 6px; border-radius: 3px; border: 1px solid; width: fit-content; font-weight: 600; }
</style>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="overlay">
    <div class="hud-panel">
      <div class="hud-title"><span>🏙️</span> Code <span class="keyword">Town</span><span id="active-tag"></span></div>
      <div class="stats-bar" id="stats-bar">
        ${badges}
        <div class="stat-badge stat-power" id="badge-power">⚡ Provider: Healthy</div>
      </div>
    </div>
    <div class="hud-panel controls-group">
      <div class="mode-switch" role="group" aria-label="View mode">
        <button id="mode-journey" type="button" aria-pressed="true" title="The path the agent took in this run">Agent Journey</button>
        <button id="mode-architecture" type="button" aria-pressed="false" title="Districts, roads (imports) and building kinds">Architecture</button>
      </div>
      <button id="btn-replay" type="button" title="Replay the last agent run">▶ Replay</button>
      <button id="btn-toggle-view" type="button">Switch to 2D</button>
      <button id="btn-reset-cam" type="button">Reset View</button>
    </div>
  </div>

  <div id="legend" class="hud-panel" aria-label="Legend"></div>

  <aside id="inspector" class="hud-panel hidden" aria-label="Building inspector">
    <div class="insp-head"><b id="insp-title"></b><button id="insp-close" type="button" aria-label="Close the inspector">✕</button></div>
    <div id="insp-path" class="muted"></div>
    <dl id="insp-rows"></dl>
    <button id="insp-open" type="button">Open file</button>
  </aside>

  <div id="tooltip" role="tooltip">
    <div class="title" id="tt-title"></div>
    <div class="meta" id="tt-meta"></div>
    <div class="state-tag" id="tt-state"></div>
  </div>

  <div id="fallback-view">
    <div class="fallback-intro">2D town view (click a building to open the file)</div>
    <div id="fallback-content"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
