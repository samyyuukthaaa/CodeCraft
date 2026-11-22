// Code Town webview HTML. Strict CSP: no inline script, no inline style attributes (every style is in the
// nonce'd stylesheet; dynamic colours are set through the CSSOM, which CSP allows), no remote resources.
import { STATE_VISUALS } from './types';

export function buildTownHtml(opts: { cspSource: string; nonce: string; scriptUri: string; reducedMotion?: 'on' | 'off' | 'auto'; scout?: 'on' | 'muted'; askCamera?: boolean }): string {
  const { cspSource, nonce, scriptUri } = opts;
  const motion = opts.reducedMotion ?? 'auto';
  const scout = opts.scout === 'muted' ? 'muted' : 'on';
  const askCamera = opts.askCamera === false ? 'off' : 'on';
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
  :root { --night-sky: #0b1638; --night-card: rgba(12, 21, 48, 0.86); --border-color: rgba(255, 255, 255, 0.14); --warm: #facc15; }
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
  /* 2D: the list starts right of the legend, and the 3D-only camera button is hidden */
  body.flat #fallback-view { left: 330px; }
  body.flat #btn-reset-cam { display: none; }
  /* Day: a sunny sky behind the 2D view and the canvas edges; panels stay dark cards for contrast */
  body.theme-day, body.theme-day html { background: linear-gradient(#3d9bff 0%, #8cc8ff 60%, #ffc98a 100%); }
  body.theme-day #btn-theme { background: #fde68a; color: #0a1330; font-weight: 700; }
  .fallback-intro { margin-bottom: 12px; font-size: 12px; color: #cbd5e1; }
  .fallback-district { margin-bottom: 18px; }
  .fallback-district-name { font-weight: 700; font-size: 13px; color: #ffffff; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .fallback-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
  .fallback-card { background: rgba(30, 41, 59, 0.6); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .fallback-card:hover { border-color: rgba(255, 255, 255, 0.4); }
  /* Scout docked companion (2D view and the no-WebGL fallback): always on screen, above every panel */
  #scout-dock { position: absolute; left: 12px; bottom: 12px; z-index: 30; display: none; align-items: flex-end; gap: 8px; max-width: min(460px, calc(100% - 24px)); pointer-events: none; }
  body.flat #scout-dock { display: flex; }
  body.flat #legend { bottom: 112px; }
  .scout-sprite { position: relative; width: 56px; height: 70px; flex: none; animation: scout-bob 1.6s ease-in-out infinite; }
  body.reduced-motion .scout-sprite { animation: none; }
  @keyframes scout-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
  .s-body { position: absolute; left: 6px; bottom: 6px; width: 44px; height: 42px; background: #fff1d6; border-radius: 14px; box-shadow: 0 0 10px 2px rgba(255, 213, 138, 0.7); }
  .s-cap { position: absolute; left: 13px; bottom: 46px; width: 30px; height: 12px; background: #e4572e; border-radius: 8px 8px 3px 3px; z-index: 1; }
  .s-eye { position: absolute; top: 9px; width: 13px; height: 14px; background: #ffffff; border-radius: 50%; box-shadow: inset 0 0 0 1px #e8c9a0; }
  .s-eye::after { content: ""; position: absolute; left: 4px; top: 4px; width: 6px; height: 7px; background: #1e1b2e; border-radius: 50%; }
  .s-eye.l { left: 8px; } .s-eye.r { right: 8px; }
  .s-cheek { position: absolute; top: 25px; width: 7px; height: 4px; background: #ff9eb5; border-radius: 50%; }
  .s-cheek.l { left: 5px; } .s-cheek.r { right: 5px; }
  .s-scarf { position: absolute; left: 4px; bottom: 6px; width: 48px; height: 7px; background: #f59e0b; border-radius: 4px; }
  .s-lantern { position: absolute; right: -2px; bottom: 8px; width: 11px; height: 13px; background: #ffd27a; border: 2px solid #5b3a29; border-radius: 3px; box-shadow: 0 0 12px 4px rgba(255, 210, 122, 0.8); }
  .scout-speech { pointer-events: auto; background: #ffffff; color: #0a1330; border-radius: 12px 12px 12px 2px; padding: 7px 11px; font-size: 13px; font-weight: 600; line-height: 1.35; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); }
  .scout-speech b { color: #b45309; margin-right: 6px; }
  .fallback-card.scout-target { outline: 2px dashed #facc15; outline-offset: 2px; }
  #ask { position: absolute; right: 12px; bottom: 12px; z-index: 13; width: 340px; font-size: 12px; }
  body.replaying #ask { bottom: 64px; }
  #ask.collapsed .ask-body { display: none; }
  #ask-toggle { width: 100%; font-weight: 800; background: #facc15; color: #0a1330; border: 0; }
  .ask-body { margin-top: 8px; }
  #ask-answer { white-space: pre-wrap; line-height: 1.45; color: #ffffff; margin-bottom: 8px; }
  #ask-answer:empty { display: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .chips button { font-size: 11px; padding: 3px 8px; border-radius: 12px; }
  #ask-form { display: flex; gap: 6px; }
  #ask-input { flex: 1; background: rgba(30, 41, 59, 0.92); color: #e2e8f0; border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 8px; font-size: 12px; }
  #tip { position: absolute; top: 112px; left: 50%; transform: translateX(-50%); z-index: 12; display: flex; gap: 10px; align-items: flex-start; max-width: 520px; font-size: 12px; border-color: rgba(250, 204, 21, 0.6); }
  #tip button { padding: 2px 8px; }
  /* Ask Scout: the answer in a speech bubble above Scout (3D: follows his screen position; 2D: above the docked Scout) */
  #scout-talk { position: absolute; z-index: 25; left: 50%; top: 40%; transform: translate(-50%, calc(-100% - 14px)); width: min(360px, calc(100% - 24px));
    background: rgba(6, 12, 32, 0.9); border: 2px solid #facc15; border-radius: 14px; padding: 10px 34px 10px 14px; box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
    color: #ffffff; font-size: 14px; font-weight: 700; line-height: 1.4; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); pointer-events: auto; }
  #scout-talk::after { content: ''; position: absolute; left: 50%; bottom: -10px; margin-left: -9px; border: 9px solid transparent; border-bottom: 0; border-top-color: #facc15; }
  #scout-talk .talk-q { font-size: 11px; font-weight: 600; color: #cbd5e1; margin-bottom: 4px; }
  #scout-talk .talk-q::before { content: '🏮 Scout · '; color: #facc15; }
  #scout-talk .kw { color: #facc15; }
  #scout-talk.expanded .talk-text { max-height: min(38vh, 260px); overflow-y: auto; padding-right: 4px; }
  #scout-talk .talk-next { font-size: 11px; font-weight: 600; color: #fde68a; margin-top: 6px; }
  #scout-talk .talk-next:empty { display: none; }
  #talk-more { margin-top: 6px; background: #facc15; color: #0a1330; border: 0; font-weight: 800; }
  #talk-close { position: absolute; top: 6px; right: 6px; padding: 2px 7px; background: transparent; color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.3); }
  body.flat #scout-talk { left: 12px; top: auto; bottom: 96px; transform: none; }
  body.flat #scout-talk::after { left: 30px; }
  body.flat.scout-talking #scout-dock .scout-speech { display: none; }
  body.scout-muted #scout-talk, body.scout-muted #tip, body.scout-muted #scout-dock, body.scout-muted .scout-ctl, body.flat .scout-ctl { display: none !important; }
  #btn-follow-scout[aria-pressed="true"] { background: #facc15; color: #0a1330; font-weight: 700; }
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
  #replay-bar { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 11; display: flex; align-items: center; gap: 8px; font-size: 12px; }
  #replay-bar select, #replay-bar input { background: rgba(30, 41, 59, 0.92); color: #e2e8f0; border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 6px; font-size: 12px; }
  #replay-bar button, #replay-bar label { white-space: nowrap; }
  /* rainbow accent for replays */
  #replay-bar { border: 2px solid transparent; background: linear-gradient(rgba(12, 21, 48, 0.92), rgba(12, 21, 48, 0.92)) padding-box, linear-gradient(90deg, #ff5e5b, #ffb347, #ffe66d, #7bd389, #4fb3ff, #9d7bff) border-box; }
  #rp-pos { width: 220px; padding: 0; accent-color: #facc15; }
  #rp-text { min-width: 150px; font-variant-numeric: tabular-nums; }
  .replay-tag { display: none; color: #0a1330; background: linear-gradient(90deg, #ff5e5b, #ffb347, #ffe66d, #7bd389, #4fb3ff, #9d7bff); border-radius: 4px; padding: 1px 6px; font-weight: 800; font-size: 11px; }
  body.replaying .replay-tag { display: inline; }
  body.replaying #legend { bottom: 64px; }
  .fallback-card-status { font-size: 11px; padding: 2px 6px; border-radius: 3px; border: 1px solid; width: fit-content; font-weight: 600; }
</style>
</head>
<body data-reduced-motion="${motion}" data-scout="${scout}" data-ask-camera="${askCamera}">
  <div id="canvas-container"></div>
  <div id="overlay">
    <div class="hud-panel">
      <div class="hud-title"><span>🏙️</span> Code <span class="keyword">Town</span><span class="replay-tag">REPLAY</span><span id="active-tag"></span></div>
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
      <button id="btn-replay" type="button" title="Replay a finished run from the journal" disabled>▶ Replay</button>
      <button id="btn-toggle-view" type="button">Switch to 2D</button>
      <button id="btn-theme" type="button" title="Now Night; switch to Day" aria-label="Night view. Switch to Day">🌙 Night</button>
      <button id="btn-reset-cam" type="button">Reset View</button>
      <button id="btn-find-scout" class="scout-ctl" type="button" title="Fly the camera to Scout">🏮 Find Scout</button>
      <button id="btn-follow-scout" class="scout-ctl" type="button" aria-pressed="false" title="The camera follows Scout (off by default)">Follow Scout</button>
    </div>
  </div>

  <div id="legend" class="hud-panel" aria-label="Legend"></div>

  <div id="scout-dock" role="status" aria-live="polite" aria-label="Scout">
    <div class="scout-sprite" aria-hidden="true"><div class="s-cap"></div><div class="s-body"><span class="s-eye l"></span><span class="s-eye r"></span><span class="s-cheek l"></span><span class="s-cheek r"></span><div class="s-scarf"></div></div><div class="s-lantern"></div></div>
    <div class="scout-speech"><b>Scout</b><span id="scout-dock-text"></span></div>
  </div>

  <div id="scout-talk" class="hidden" role="group" aria-label="Scout's answer (the full text is in the Ask Scout panel)">
    <button id="talk-close" type="button" aria-label="Close Scout's answer (Esc)">✕</button>
    <div id="talk-q" class="talk-q"></div>
    <div id="talk-text" class="talk-text" aria-hidden="true"></div>
    <div id="talk-next" class="talk-next" role="status"></div>
    <button id="talk-more" type="button" class="hidden">Show more</button>
  </div>

  <div id="replay-bar" class="hud-panel hidden" role="group" aria-label="Replay controls">
    <label class="muted" for="rp-run">Run</label>
    <select id="rp-run" aria-label="Finished run to replay"></select>
    <button id="rp-play" type="button">⏸ Pause</button>
    <label class="muted" for="rp-speed">Speed</label>
    <select id="rp-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select>
    <input id="rp-pos" type="range" min="0" max="0" value="0" aria-label="Replay position">
    <span id="rp-text">0 / 0</span>
    <button id="rp-live" type="button">Back to live</button>
  </div>

  <aside id="inspector" class="hud-panel hidden" aria-label="Building inspector">
    <div class="insp-head"><b id="insp-title"></b><button id="insp-close" type="button" aria-label="Close the inspector">✕</button></div>
    <div id="insp-path" class="muted"></div>
    <dl id="insp-rows"></dl>
    <button id="insp-open" type="button">Open file</button>
  </aside>

  <aside id="ask" class="hud-panel collapsed" aria-label="Ask Scout">
    <button id="ask-toggle" type="button" aria-expanded="false">🏮 Ask Scout</button>
    <div class="ask-body">
      <div id="ask-answer" role="status" aria-live="polite"></div>
      <div id="ask-suggest" class="chips" aria-label="Suggested questions"></div>
      <form id="ask-form"><input id="ask-input" type="text" maxlength="200" placeholder="Ask about CodeCraft…" aria-label="Your question"><button type="submit">Ask</button></form>
      <p class="muted">Answers come from a built-in guide and the town; no model is called.</p>
    </div>
  </aside>

  <div id="tip" class="hud-panel hidden" role="status" aria-live="polite"><span id="tip-text"></span><button id="tip-close" type="button" aria-label="Dismiss this tip">✕</button></div>

  <div id="tooltip" role="tooltip">
    <div class="title" id="tt-title"></div>
    <div class="meta" id="tt-meta"></div>
    <div class="state-tag" id="tt-state"></div>
  </div>

  <div id="fallback-view">
    <div class="fallback-intro">2D town view: click a building to send Scout there and open the file</div>
    <div id="fallback-content"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
