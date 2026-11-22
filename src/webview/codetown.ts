// Code Town webview. Read-only: it renders the scene and only sends typed requests (open a file, replay) that
// the host validates. Every update goes through the same pure reducer as the host; the 3D view applies only
// what changed (TownGraph), and the 2D fallback updates only the changed cards.
import * as THREE from 'three';
import { diffScenes } from '../town/diff';
import { KIND_VISUALS, POWER_VISUALS, TEST_VISUALS } from '../town/grammar';
import { initialSceneState, sceneReducer } from '../town/reducer';
import type { Building, SceneState, TownEvent } from '../town/types';
import type { HostToTown, TownToHost } from '../town/protocol';
import { CaptionPart, TextureFactory, TownGraph } from './town/graph';
import { VIEW_MODES, ViewMode, inspect, legendFor } from '../town/view';
import { SUGGESTED, Tip, askScout, tipFor } from '../town/help';
import { Player, createPlayer, delayToNext, pause, play, positionText, seek, setSpeed, step } from '../town/replay';

declare function acquireVsCodeApi(): { postMessage(msg: TownToHost): void };
const vscode = acquireVsCodeApi();

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** codecraft.townReducedMotion: 'on' / 'off', or 'auto' (follow the OS setting). Changeable while open. */
const motionSetting = (v: string | undefined): boolean => (v === 'on' ? true : v === 'off' ? false : prefersReducedMotion);
let reducedMotion = motionSetting(document.body.dataset.reducedMotion);
/** codecraft.scout: muted hides Scout, its bubble and its tips. */
let scoutMuted = document.body.dataset.scout === 'muted';
/** With reduced motion nothing animates, so a frame is drawn only when something changed. */
let dirty = true;
let renderedFrames = 0;
let frames = 0;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvasContainer = $('canvas-container');
const fallbackView = $('fallback-view');
const fallbackContent = $('fallback-content');
const scout2d = $('scout-2d');
const btnToggleView = $<HTMLButtonElement>('btn-toggle-view');
const btnResetCam = $<HTMLButtonElement>('btn-reset-cam');
const btnReplay = $<HTMLButtonElement>('btn-replay');
const activeTag = $('active-tag');
const tooltip = $('tooltip');
const ttTitle = $('tt-title');
const ttMeta = $('tt-meta');
const ttState = $('tt-state');
const powerBadge = $('badge-power');
const STATE_KEYS = ['idle', 'planned', 'read', 'proposed', 'applied', 'rejected', 'failed', 'recovered'] as const;
const badges = Object.fromEntries(STATE_KEYS.map((k) => [k, $(`badge-${k}`)])) as Record<(typeof STATE_KEYS)[number], HTMLElement>;

let current: SceneState = initialSceneState();
let is3D = true;
let mode: ViewMode = 'journey';
let inspected: string | undefined;
const legend = $('legend');
const inspector = $('inspector');
const inspTitle = $('insp-title');
const inspPath = $('insp-path');
const inspRows = $('insp-rows');
const modeButtons = { journey: $<HTMLButtonElement>('mode-journey'), architecture: $<HTMLButtonElement>('mode-architecture') };

function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
const hasWebGL = isWebGLAvailable();

// ---------------------------------------------------------------------------
// Canvas textures: captions (bold white, one yellow keyword) and warm windows
// ---------------------------------------------------------------------------
const textures: TextureFactory = {
  caption(parts: CaptionPart[]) {
    const font = '700 44px "Segoe UI", system-ui, sans-serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = font;
    const width = Math.ceil(parts.reduce((w, p) => w + ctx.measureText(p.text).width, 0)) + 28;
    c.width = width;
    c.height = 64;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(5, 10, 28, 0.9)';
    let x = 14;
    for (const p of parts) {
      ctx.strokeText(p.text, x, 34);
      ctx.fillStyle = p.yellow ? '#facc15' : '#ffffff';
      ctx.fillText(p.text, x, 34);
      x += ctx.measureText(p.text).width;
    }
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, aspect: c.width / c.height };
  },
  glow() {
    // a soft round warm glow (Scout's lantern)
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,230,170,0.6)');
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  },
  windows() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 64, 64);
    // fixed pattern (no randomness): most windows lit warm, a few dark
    const dark = new Set([1, 6, 11]);
    let k = 0;
    for (let y = 10; y < 60; y += 18)
      for (let x = 8; x < 60; x += 16) {
        if (!dark.has(k++)) {
          ctx.fillStyle = '#ffd27a';
          ctx.fillRect(x, y, 8, 9);
        }
      }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    return t;
  },
};

// ---------------------------------------------------------------------------
// 3D view
// ---------------------------------------------------------------------------
let renderer: THREE.WebGLRenderer | undefined;
let scene3: THREE.Scene | undefined;
let camera: THREE.PerspectiveCamera | undefined;
let graph: TownGraph | undefined;
const cameraTarget = new THREE.Vector3();
const listeners: Array<() => void> = [];
// Every listener goes through on(): it is removed again on shutdown, and any input or message marks the frame dirty.
const on = (t: EventTarget, type: string, f: (e: never) => void, opts?: AddEventListenerOptions): void => {
  const g = ((e: never) => {
    dirty = true;
    f(e);
  }) as EventListener;
  t.addEventListener(type, g, opts);
  listeners.push(() => t.removeEventListener(type, g, opts));
};

function starfield(): THREE.Points {
  // deterministic sky: a small LCG instead of Math.random, so every reload looks the same
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const n = reducedMotion ? 500 : 900;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const th = rnd() * Math.PI * 2;
    const r = 120 + rnd() * 160;
    pos.set([Math.cos(th) * r, 25 + rnd() * 140, Math.sin(th) * r], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: '#e0e7ff', size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false }));
}

function init3D(): void {
  scene3 = new THREE.Scene();
  scene3.background = new THREE.Color('#0a1330');
  scene3.fog = new THREE.FogExp2('#0a1330', 0.0028);
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 2000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasContainer.appendChild(renderer.domElement);

  scene3.add(new THREE.HemisphereLight('#6d82c9', '#141a33', 1.7));
  const moon = new THREE.DirectionalLight('#dbe4ff', 1.6);
  moon.position.set(40, 80, 30);
  scene3.add(moon);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(600, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#0c1530', roughness: 1 }));
  ground.position.y = -0.32;
  scene3.add(ground, starfield());

  graph = new TownGraph(textures, reducedMotion);
  scene3.add(graph.root);
  setupControls(renderer.domElement);
  // If the GPU drops the WebGL context (driver reset, too many contexts), fall back to the 2D view.
  on(renderer.domElement, 'webglcontextlost', (e: Event) => {
    e.preventDefault();
    webglLost = true;
    setMode3D(false);
    btnToggleView.classList.add('hidden');
  });
  on(window, 'resize', () => {
    if (!renderer || !camera) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  resetCamera();
  loop();
}

let frame = 0;
const clock = new THREE.Clock();
let webglLost = false;
function loop(): void {
  frame = requestAnimationFrame(loop);
  frames++;
  if (!renderer || !scene3 || !camera || !is3D || webglLost) return;
  if (reducedMotion && !dirty && !graph?.animating) return; // render on demand (and while Scout fades)
  dirty = false;
  graph?.tick(clock.getElapsedTime());
  renderer.render(scene3, camera);
  renderedFrames++;
}

/** Read-only numbers for the frame-rate and memory check (never sent anywhere). */
(window as unknown as { __townStats?: () => unknown }).__townStats = () => ({
  frames,
  renderedFrames,
  reducedMotion,
  is3D,
  geometries: renderer?.info.memory.geometries ?? 0,
  textures: renderer?.info.memory.textures ?? 0,
  drawCalls: renderer?.info.render.calls ?? 0,
  triangles: renderer?.info.render.triangles ?? 0,
  graph: graph?.stats(),
  listeners: listeners.length,
  scout: graph ? { mode: graph.scoutMode, animating: graph.animating, at: graph.scoutWorldPosition(new THREE.Vector3()).toArray().map((v) => Math.round(v * 10) / 10) } : undefined,
  buildings: Object.keys(current.buildings).length,
});

function resetCamera(): void {
  if (!camera) return;
  const b = graph?.bounds;
  // frame the whole town plus the power plant on its east side
  const minX = b ? b.minX : -20;
  const maxX = b ? b.maxX + 18 : 20;
  const span = b ? Math.max(maxX - minX, b.maxZ - b.minZ) : 40;
  cameraTarget.set((minX + maxX) / 2, 0, b ? (b.minZ + b.maxZ) / 2 : 0);
  camera.position.set(cameraTarget.x, span * 0.58 + 8, cameraTarget.z + span * 0.72 + 10);
  camera.lookAt(cameraTarget);
}

// orbit (left drag), pan (right drag), zoom (wheel), hover tooltip, click opens the file
function setupControls(dom: HTMLCanvasElement): void {
  let drag = 0;
  let last = { x: 0, y: 0 };
  on(dom, 'mousedown', (e: MouseEvent) => {
    drag = e.button === 2 ? 2 : 1;
    last = { x: e.clientX, y: e.clientY };
  });
  on(window, 'mouseup', () => (drag = 0));
  on(dom, 'contextmenu', (e: MouseEvent) => e.preventDefault());
  on(window, 'mousemove', (e: MouseEvent) => {
    if (!camera) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    if (drag === 1) {
      const off = camera.position.clone().sub(cameraTarget);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta -= dx * 0.005;
      sph.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, sph.phi - dy * 0.005));
      camera.position.copy(cameraTarget).add(new THREE.Vector3().setFromSpherical(sph));
      camera.lookAt(cameraTarget);
    } else if (drag === 2) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const pan = right.multiplyScalar(-dx * 0.08).add(fwd.multiplyScalar(dy * 0.08));
      camera.position.add(pan);
      cameraTarget.add(pan);
    } else hover(e);
  });
  on(
    dom,
    'wheel',
    (e: WheelEvent) => {
      if (!camera) return;
      e.preventDefault();
      const dir = camera.position.clone().sub(cameraTarget).normalize();
      const dist = Math.max(8, Math.min(600, camera.position.distanceTo(cameraTarget) + e.deltaY * 0.05));
      camera.position.copy(cameraTarget).add(dir.multiplyScalar(dist));
    },
    { passive: false },
  );
  on(dom, 'click', (e: MouseEvent) => {
    const b = buildingAt(e);
    if (b) navigateTo(b.id);
  });
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
function buildingAt(e: MouseEvent): Building | undefined {
  if (!renderer || !camera || !graph) return undefined;
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const id = graph.pick(raycaster);
  return id ? current.buildings[id] : undefined;
}

function hover(e: MouseEvent): void {
  const b = buildingAt(e);
  if (!b) {
    tooltip.classList.remove('show');
    document.body.classList.remove('pointer');
    return;
  }
  tooltip.classList.add('show');
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
  ttTitle.textContent = b.path;
  ttMeta.textContent = `${KIND_VISUALS[b.kind].icon} ${KIND_VISUALS[b.kind].label} • ${b.lines} lines • ${TEST_VISUALS[b.testStatus].icon} ${TEST_VISUALS[b.testStatus].label}`;
  ttState.textContent = `${b.icon} ${b.label}${b.lastAction ? `: ${b.lastAction.detail}` : ''}`;
  ttState.style.color = b.color;
  ttState.style.borderColor = b.color;
  document.body.classList.add('pointer');
}

// ---------------------------------------------------------------------------
// 2D fallback (also incremental: one card per building, only changed cards are touched)
// ---------------------------------------------------------------------------
const cards = new Map<string, HTMLElement>();
function cardFor(b: Building): HTMLElement {
  const card = document.createElement('div');
  card.className = 'fallback-card';
  const title = document.createElement('div');
  title.className = 'fallback-card-title';
  const meta = document.createElement('div');
  meta.className = 'fallback-card-meta';
  const status = document.createElement('div');
  status.className = 'fallback-card-status';
  card.append(title, meta, status);
  card.addEventListener('click', () => navigateTo(b.id));
  return card;
}
function fillCard(card: HTMLElement, b: Building, active: boolean): void {
  const [title, meta, status] = Array.from(card.children) as HTMLElement[];
  title!.textContent = b.name;
  title!.title = b.path;
  meta!.textContent = `${KIND_VISUALS[b.kind].icon} ${KIND_VISUALS[b.kind].label} • ${b.lines} lines • ${TEST_VISUALS[b.testStatus].icon} ${TEST_VISUALS[b.testStatus].label}${b.placeholder ? ' • not in the index' : ''}`;
  status!.textContent = `${b.icon} ${b.label}`;
  status!.style.color = b.color;
  status!.style.borderColor = b.color;
  card.classList.toggle('active', active);
  card.classList.toggle('scout-target', current.scout.at.kind === 'building' && current.scout.at.id === b.id);
}
/** 2D: Scout is shown as its speech bubble plus a highlight on its target building. */
function render2DScout(s: SceneState): void {
  scout2d.textContent = `🏮 Scout: ${s.scout.bubble}`;
}

function rebuild2D(s: SceneState): void {
  render2DScout(s);
  fallbackContent.replaceChildren();
  cards.clear();
  if (!Object.keys(s.districts).length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No workspace files indexed yet.';
    fallbackContent.append(empty);
    return;
  }
  for (const d of Object.values(s.districts).sort((a, b) => a.id.localeCompare(b.id))) {
    const wrap = document.createElement('div');
    wrap.className = 'fallback-district';
    const name = document.createElement('div');
    name.className = 'fallback-district-name';
    name.textContent = `${d.name} (${d.buildingIds.length} files)${d.aggregated ? ' +' : ''}`;
    const grid = document.createElement('div');
    grid.className = 'fallback-grid';
    for (const id of d.buildingIds) {
      const b = s.buildings[id];
      if (!b) continue;
      const card = cardFor(b);
      fillCard(card, b, s.activeBuildingId === id);
      cards.set(id, card);
      grid.append(card);
    }
    wrap.append(name, grid);
    fallbackContent.append(wrap);
  }
}
function update2D(prev: SceneState | undefined, s: SceneState): void {
  const d = diffScenes(prev, s);
  if (d.rebuild || d.addedDistricts.length || d.added.length) return rebuild2D(s);
  render2DScout(s);
  const scoutId = (x: SceneState | undefined) => (x?.scout.at.kind === 'building' ? [x.scout.at.id] : []);
  const touched = new Set([...scoutId(prev), ...scoutId(s), ...d.changed, ...(prev?.activeBuildingId ? [prev.activeBuildingId] : []), ...(s.activeBuildingId ? [s.activeBuildingId] : [])]);
  for (const id of touched) {
    const card = cards.get(id);
    const b = s.buildings[id];
    if (card && b) fillCard(card, b, s.activeBuildingId === id);
  }
}

// ---------------------------------------------------------------------------
// HUD and state updates
// ---------------------------------------------------------------------------
function updateHud(s: SceneState): void {
  for (const k of STATE_KEYS) badges[k].textContent = `${badges[k].dataset.icon ?? ''} ${badges[k].dataset.label ?? k}: ${s.stats[k]}`;
  const pv = POWER_VISUALS[s.power.status];
  powerBadge.textContent = `${pv.icon} Provider: ${pv.label}${s.power.model ? ` (${s.power.model})` : ''}`;
  powerBadge.style.borderLeftColor = pv.color;
  const b = s.activeBuildingId ? s.buildings[s.activeBuildingId] : undefined;
  activeTag.textContent = b ? `• ${b.icon} ${b.label}: ${b.name}` : '';
}

// ---------------------------------------------------------------------------
// Modes, legend and inspector
// ---------------------------------------------------------------------------
function renderLegend(): void {
  legend.replaceChildren();
  for (const sec of legendFor(mode)) {
    const h = document.createElement('h5');
    h.textContent = sec.title;
    legend.append(h);
    for (const it of sec.items) {
      const row = document.createElement('div');
      row.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = it.color;
      const tx = document.createElement('span');
      tx.textContent = `${it.icon} ${it.label}`;
      row.append(sw, tx);
      legend.append(row);
    }
  }
}

function setViewMode(m: ViewMode): void {
  mode = m;
  for (const [k, b] of Object.entries(modeButtons)) b.setAttribute('aria-pressed', String(k === m));
  graph?.setMode(m);
  renderLegend();
}

function renderInspector(): void {
  const info = inspected ? inspect(current, inspected) : undefined;
  inspector.classList.toggle('hidden', !info);
  graph?.select(info ? inspected : undefined);
  if (!info) return;
  inspTitle.textContent = info.title;
  inspPath.textContent = info.path;
  inspRows.replaceChildren();
  for (const r of info.rows) {
    const dt = document.createElement('dt');
    dt.textContent = r.label;
    const dd = document.createElement('dd');
    dd.textContent = r.value;
    if (r.color) dd.style.color = r.color;
    inspRows.append(dt, dd);
  }
}

/** A click on a building or the inspector's file: Scout walks there and the file opens (the host validates and journals it). */
function navigateTo(id: string): void {
  openInspector(id);
  vscode.postMessage({ type: 'navigate', path: id });
}

/** Brings the camera close to a building (a click or the host's focus): the town stays where it is. */
function focusCamera(id: string): void {
  const p = graph?.positionOf(id);
  if (!p || !camera) return;
  cameraTarget.set(p.x, 5, p.z + 2);
  camera.position.set(p.x + 9, 24, p.z + 34);
  camera.lookAt(cameraTarget);
  dirty = true;
}

function openInspector(id: string): void {
  inspected = id;
  renderInspector();
}

function show(next: SceneState): void {
  dirty = true;
  const prev = current;
  if (!player) maybeTip(tipFor(prev, next)); // no tips during a replay
  current = next;
  updateHud(next);
  if (inspected && prev.buildings[inspected] !== next.buildings[inspected]) renderInspector();
  if (is3D) graph?.sync(next);
  else update2D(prev, next);
}

function setMode3D(want: boolean): void {
  is3D = want && hasWebGL && !webglLost;
  document.body.classList.toggle('flat', !is3D);
  btnToggleView.textContent = is3D ? 'Switch to 2D' : 'Switch to 3D';
  fallbackView.classList.toggle('show', !is3D);
  canvasContainer.classList.toggle('hidden', !is3D);
  if (is3D) graph?.sync(current);
  else rebuild2D(current);
}

// ---------------------------------------------------------------------------
// Replay of a finished run from the journal, through the same reducer (src/town/replay.ts)
// ---------------------------------------------------------------------------
/** The live scene (what the agent is doing now). While replaying, `current` shows the replay instead. */
let live: SceneState = current;
let player: Player | undefined;
let replayTimer: ReturnType<typeof setTimeout> | undefined;
const replayBar = $('replay-bar');
const rpRun = $<HTMLSelectElement>('rp-run');
const rpPlay = $<HTMLButtonElement>('rp-play');
const rpSpeed = $<HTMLSelectElement>('rp-speed');
const rpPos = $<HTMLInputElement>('rp-pos');
const rpText = $('rp-text');

function display(next: SceneState, rebuild = false): void {
  if (!rebuild) return show(next);
  current = next;
  updateHud(next);
  graph?.rebuild(next);
  if (!is3D) rebuild2D(next);
  renderInspector();
}

function renderReplayBar(): void {
  replayBar.classList.toggle('hidden', !player);
  document.body.classList.toggle('replaying', Boolean(player));
  if (!player) return;
  rpPlay.textContent = player.playing ? '⏸ Pause' : '▶ Play';
  rpPos.max = String(player.events.length);
  rpPos.value = String(player.index);
  rpText.textContent = positionText(player);
  rpSpeed.value = String(player.speed);
}

function schedule(): void {
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = undefined;
  if (!player?.playing) return;
  replayTimer = setTimeout(() => {
    if (!player) return;
    player = step(player);
    show(player.scene);
    renderReplayBar();
    schedule();
  }, delayToNext(player));
}

function startReplay(runId: string, base: SceneState, events: TownEvent[]): void {
  graph?.setReplay(true);
  player = setSpeed(play(createPlayer(runId, base, events)), Number(rpSpeed.value));
  display(player.scene, true); // the town before the run: one rebuild, then increments
  renderReplayBar();
  schedule();
}

function stopReplay(): void {
  graph?.setReplay(false);
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = undefined;
  player = undefined;
  renderReplayBar();
  display(live, true);
}

on(btnToggleView, 'click', () => setMode3D(!is3D));
on(modeButtons.journey, 'click', () => setViewMode('journey'));
on(modeButtons.architecture, 'click', () => setViewMode('architecture'));
on($('insp-close'), 'click', () => {
  inspected = undefined;
  renderInspector();
});
on($('insp-open'), 'click', () => {
  if (inspected) navigateTo(inspected);
});
for (const [k, b] of Object.entries(modeButtons)) b.title = `${VIEW_MODES[k as ViewMode]}: ${b.title}`;
on(btnResetCam, 'click', resetCamera);
const requestReplay = (): void => vscode.postMessage(rpRun.value ? { type: 'replay_run', runId: rpRun.value } : { type: 'replay_run' });
on(btnReplay, 'click', requestReplay);
on(rpRun, 'change', requestReplay);
on(rpPlay, 'click', () => {
  if (!player) return;
  const restart = !player.playing && player.index >= player.events.length;
  player = player.playing ? pause(player) : play(player);
  if (restart) display(player.scene, true);
  renderReplayBar();
  schedule();
});
on(rpSpeed, 'change', () => {
  if (!player) return;
  player = setSpeed(player, Number(rpSpeed.value));
  schedule();
});
on(rpPos, 'input', () => {
  if (!player) return;
  player = seek(pause(player), Number(rpPos.value));
  display(player.scene, true); // a jump (user action): one rebuild of the seeked scene
  renderReplayBar();
  schedule();
});
on($('rp-live'), 'click', stopReplay);

on(window, 'message', (event: MessageEvent<HostToTown>) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'scene') {
    // a full scene from the host replaces the old one: one rebuild, then only increments
    live = m.state;
    if (!player) {
      display(live, true);
      resetCamera();
    }
  } else if (m.type === 'event') {
    live = sceneReducer(live, m.event);
    if (!player) show(live); // during a replay the live town keeps updating in the background
  } else if (m.type === 'runs') {
    const keep = rpRun.value;
    rpRun.replaceChildren();
    for (const r of m.runs) {
      const o = document.createElement('option');
      o.value = r.runId;
      o.textContent = `${new Date(r.at).toISOString().slice(5, 16).replace('T', ' ')} ${r.status}: ${r.request.slice(0, 50)}`;
      rpRun.append(o);
    }
    if (keep && m.runs.some((r) => r.runId === keep)) rpRun.value = keep;
    btnReplay.disabled = m.runs.length === 0;
    btnReplay.title = m.runs.length ? 'Replay a finished run from the journal' : 'No finished run in the journal yet';
  } else if (m.type === 'replay') {
    if (rpRun.value !== m.runId) rpRun.value = m.runId;
    startReplay(m.runId, m.base, m.events);
  } else if (m.type === 'focus' && typeof m.path === 'string') {
    openInspector(m.path);
    focusCamera(m.path);
  } else if (m.type === 'settings') {
    reducedMotion = motionSetting(m.reducedMotion);
    graph?.setReducedMotion(reducedMotion);
    setScoutMuted(m.scout === 'muted');
  }
});

// Clean shutdown: stop the loop and timers, remove every listener, free GPU resources.
on(window, 'unload', () => {
  cancelAnimationFrame(frame);
  if (replayTimer) clearTimeout(replayTimer);
  for (const off of listeners.splice(0)) off();
  graph?.dispose();
  renderer?.dispose();
});

// ---------------------------------------------------------------------------
// Ask Scout (built-in help: static knowledge + the town state; no model, no network) and context tips
// ---------------------------------------------------------------------------
const ask = $('ask');
const askToggle = $<HTMLButtonElement>('ask-toggle');
const askAnswer = $('ask-answer');
const askSuggest = $('ask-suggest');
const askInput = $<HTMLInputElement>('ask-input');
const tipBox = $('tip');
const tipText = $('tip-text');
const dismissedTips = new Set<string>();
let tipShown: string | undefined;

function renderSuggestions(qs: string[]): void {
  askSuggest.replaceChildren();
  for (const q of qs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => answer(q));
    askSuggest.append(b);
  }
}

function answer(q: string): void {
  const r = askScout(q, current);
  askInput.value = q;
  askAnswer.textContent = r.answer;
  renderSuggestions(r.suggestions);
}

function maybeTip(tip: Tip | undefined): void {
  if (!tip || scoutMuted || dismissedTips.has(tip.id)) return;
  tipShown = tip.id;
  tipText.textContent = `🏮 ${tip.text}`;
  tipBox.classList.remove('hidden');
}

function setScoutMuted(muted: boolean): void {
  scoutMuted = muted;
  document.body.classList.toggle('scout-muted', muted);
  graph?.setScoutVisible(!muted);
  if (muted) tipBox.classList.add('hidden');
}

on(askToggle, 'click', () => {
  const open = ask.classList.toggle('collapsed') === false;
  askToggle.setAttribute('aria-expanded', String(open));
  if (open) askInput.focus();
});
on($('ask-form'), 'submit', (e: Event) => {
  e.preventDefault();
  if (askInput.value.trim()) answer(askInput.value.trim().slice(0, 200));
});
on($('tip-close'), 'click', () => {
  if (tipShown) dismissedTips.add(tipShown);
  tipBox.classList.add('hidden');
});
renderSuggestions(SUGGESTED);

renderLegend();
if (hasWebGL) init3D();
else btnToggleView.classList.add('hidden');
setScoutMuted(scoutMuted);
setMode3D(hasWebGL);
