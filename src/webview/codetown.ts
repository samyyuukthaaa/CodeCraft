import * as THREE from 'three';
import { Building, SceneState, TownEvent } from '../town/types';
import { HostToTown, TownToHost } from '../town/protocol';
import { initialSceneState, sceneReducer } from '../town/reducer';

declare function acquireVsCodeApi(): { postMessage(msg: TownToHost): void };
const vscode = acquireVsCodeApi();

// Check for reduced motion preference
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// DOM Elements
const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
const fallbackView = document.getElementById('fallback-view') as HTMLElement;
const fallbackContent = document.getElementById('fallback-content') as HTMLElement;
const btnToggleView = document.getElementById('btn-toggle-view') as HTMLButtonElement;
const btnResetCam = document.getElementById('btn-reset-cam') as HTMLButtonElement;
const btnReplay = document.getElementById('btn-replay') as HTMLButtonElement;
const activeTag = document.getElementById('active-tag') as HTMLElement;
const tooltip = document.getElementById('tooltip') as HTMLElement;
const ttTitle = document.getElementById('tt-title') as HTMLElement;
const ttMeta = document.getElementById('tt-meta') as HTMLElement;
const ttState = document.getElementById('tt-state') as HTMLElement;

const badges = {
  idle: document.getElementById('badge-idle') as HTMLElement,
  read: document.getElementById('badge-read') as HTMLElement,
  proposed: document.getElementById('badge-proposed') as HTMLElement,
  applied: document.getElementById('badge-applied') as HTMLElement,
  rejected: document.getElementById('badge-rejected') as HTMLElement,
  failed: document.getElementById('badge-failed') as HTMLElement,
  planned: document.getElementById('badge-planned') as HTMLElement,
  recovered: document.getElementById('badge-recovered') as HTMLElement,
};
const powerBadge = document.getElementById('badge-power') as HTMLElement;
const POWER_TEXT = { healthy: 'healthy', retrying: 'retrying', failed_over: 'failed over', recovered: 'recovered' } as const;

let currentState: SceneState = initialSceneState();
let is3DMode = true;

// WebGL availability check
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

const hasWebGL = isWebGLAvailable();
if (!hasWebGL) {
  is3DMode = false;
  btnToggleView.style.display = 'none';
  fallbackView.style.display = 'block';
  canvasContainer.style.display = 'none';
}

// ---------------------------------------------------------------------------
// 2D Fallback Rendering
// ---------------------------------------------------------------------------
function render2D(state: SceneState): void {
  fallbackContent.innerHTML = '';
  const districts = Object.values(state.districts);
  if (districts.length === 0) {
    fallbackContent.innerHTML = '<div style="color:#64748b; font-size:12px;">No workspace files indexed yet.</div>';
    return;
  }

  for (const dist of districts) {
    const distDiv = document.createElement('div');
    distDiv.className = 'fallback-district';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'fallback-district-name';
    nameDiv.textContent = `📁 ${dist.name} (${dist.buildingIds.length} files)`;
    distDiv.appendChild(nameDiv);

    const gridDiv = document.createElement('div');
    gridDiv.className = 'fallback-grid';

    for (const bId of dist.buildingIds) {
      const b = state.buildings[bId];
      if (!b) continue;

      const card = document.createElement('div');
      card.className = 'fallback-card';
      if (state.activeBuildingId === b.id) {
        card.style.borderColor = '#38bdf8';
        card.style.boxShadow = '0 0 10px rgba(56, 189, 248, 0.4)';
      }

      const title = document.createElement('div');
      title.className = 'fallback-card-title';
      title.textContent = b.name;
      title.title = b.path;

      const meta = document.createElement('div');
      meta.className = 'fallback-card-meta';
      meta.textContent = `${b.language} • ${b.lines} lines`;

      const status = document.createElement('div');
      status.className = 'fallback-card-status';
      status.style.backgroundColor = b.color + '33';
      status.style.color = b.color;
      status.style.border = `1px solid ${b.color}`;
      status.textContent = `${b.icon} ${b.label}`;

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(status);

      card.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_file', path: b.path });
      });

      gridDiv.appendChild(card);
    }

    distDiv.appendChild(gridDiv);
    fallbackContent.appendChild(distDiv);
  }
}

// ---------------------------------------------------------------------------
// Three.js 3D Night Scene
// ---------------------------------------------------------------------------
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let townGroup: THREE.Group;
let stars: THREE.Points;
const buildingMeshes = new Map<string, THREE.Group>();

function createNightWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  // Building wall background
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, 64, 64);

  // Warm glowing windows
  ctx.fillStyle = '#fef08a';
  for (let x = 8; x < 60; x += 16) {
    for (let y = 8; y < 60; y += 16) {
      if (Math.random() > 0.25) {
        ctx.fillRect(x, y, 8, 8);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

const windowTexture = hasWebGL ? createNightWindowTexture() : null;

function init3D(): void {
  if (!hasWebGL) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b16);
  scene.fog = new THREE.FogExp2(0x070b16, 0.015);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 1000);
  camera.position.set(0, 35, 55);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasContainer.appendChild(renderer.domElement);

  // Lighting: Low-poly night moonlight + ambient
  const ambientLight = new THREE.AmbientLight(0x1e293b, 1.2);
  scene.add(ambientLight);

  const moonLight = new THREE.DirectionalLight(0xc8d6e5, 1.8);
  moonLight.position.set(30, 60, 40);
  scene.add(moonLight);

  const softFill = new THREE.DirectionalLight(0x38bdf8, 0.6);
  softFill.position.set(-40, 20, -30);
  scene.add(softFill);

  // Starfield
  const starGeo = new THREE.BufferGeometry();
  const starCount = prefersReducedMotion ? 400 : 800;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount * 3; i += 3) {
    starPos[i] = (Math.random() - 0.5) * 300;
    starPos[i + 1] = Math.random() * 120 + 20;
    starPos[i + 2] = (Math.random() - 0.5) * 300;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.2,
    transparent: true,
    opacity: 0.8,
  });
  stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  townGroup = new THREE.Group();
  scene.add(townGroup);

  setupControls();
  window.addEventListener('resize', onWindowResize);
  animate();
}

// ---------------------------------------------------------------------------
// Camera Controls (Simple Orbit + Pan + Zoom)
// ---------------------------------------------------------------------------
let isDragging = false;
let isRightDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let cameraTarget = new THREE.Vector3(0, 0, 0);

function setupControls(): void {
  const dom = renderer.domElement;

  dom.addEventListener('mousedown', (e) => {
    if (e.button === 0) isDragging = true;
    if (e.button === 2) isRightDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    isRightDragging = false;
  });

  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;

      const rotSpeed = 0.005;
      const radius = camera.position.distanceTo(cameraTarget);
      const theta = Math.atan2(camera.position.x - cameraTarget.x, camera.position.z - cameraTarget.z) - deltaX * rotSpeed;
      let phi = Math.atan2(Math.sqrt((camera.position.x - cameraTarget.x) ** 2 + (camera.position.z - cameraTarget.z) ** 2), camera.position.y - cameraTarget.y) - deltaY * rotSpeed;
      phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi));

      camera.position.x = cameraTarget.x + radius * Math.sin(phi) * Math.sin(theta);
      camera.position.y = cameraTarget.y + radius * Math.cos(phi);
      camera.position.z = cameraTarget.z + radius * Math.sin(phi) * Math.cos(theta);
      camera.lookAt(cameraTarget);
    } else if (isRightDragging) {
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;
      const panSpeed = 0.08;

      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3();
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      const panOffset = right.clone().multiplyScalar(-deltaX * panSpeed).add(forward.clone().multiplyScalar(deltaY * panSpeed));
      camera.position.add(panOffset);
      cameraTarget.add(panOffset);
    } else {
      handleRaycast(e);
    }
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY * 0.05;
    const dir = new THREE.Vector3().subVectors(camera.position, cameraTarget).normalize();
    const dist = camera.position.distanceTo(cameraTarget);
    const newDist = Math.max(10, Math.min(150, dist + zoomFactor));
    camera.position.copy(cameraTarget).add(dir.multiplyScalar(newDist));
  }, { passive: false });

  dom.addEventListener('click', (e) => {
    const b = getBuildingUnderMouse(e);
    if (b) {
      vscode.postMessage({ type: 'open_file', path: b.path });
    }
  });
}

function resetCamera(): void {
  cameraTarget.set(0, 0, 0);
  camera.position.set(0, 35, 55);
  camera.lookAt(0, 0, 0);
}

function onWindowResize(): void {
  if (!renderer || !camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Raycasting & Tooltips
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
function getBuildingUnderMouse(e: MouseEvent): Building | undefined {
  if (!renderer || !camera) return undefined;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(townGroup.children, true);

  for (const hit of intersects) {
    let curr: THREE.Object3D | null = hit.object;
    while (curr && curr !== townGroup) {
      if (curr.userData?.building) {
        return curr.userData.building as Building;
      }
      curr = curr.parent;
    }
  }
  return undefined;
}

function handleRaycast(e: MouseEvent): void {
  const b = getBuildingUnderMouse(e);
  if (b) {
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
    ttTitle.textContent = b.name;
    ttMeta.textContent = `${b.district} • ${b.lines} lines • ${b.language}`;
    ttState.textContent = `${b.icon} ${b.label}`;
    ttState.style.backgroundColor = b.color + '33';
    ttState.style.color = b.color;
    ttState.style.border = `1px solid ${b.color}`;
    document.body.style.cursor = 'pointer';
  } else {
    tooltip.style.display = 'none';
    document.body.style.cursor = 'default';
  }
}

// ---------------------------------------------------------------------------
// Town 3D Builder
// ---------------------------------------------------------------------------
function buildTown3D(state: SceneState): void {
  if (!hasWebGL) return;

  // Clear existing
  while (townGroup.children.length > 0) {
    const obj = townGroup.children[0];
    if (obj) townGroup.remove(obj);
  }
  buildingMeshes.clear();

  const districts = Object.values(state.districts);
  if (districts.length === 0) return;

  // Lay out districts on a grid
  const distCols = Math.ceil(Math.sqrt(districts.length));
  const distSpacing = 28;

  districts.forEach((dist, dIdx) => {
    const col = dIdx % distCols;
    const row = Math.floor(dIdx / distCols);
    const centerX = (col - (distCols - 1) / 2) * distSpacing;
    const centerZ = (row - (distCols - 1) / 2) * distSpacing;

    const bCount = dist.buildingIds.length;
    const bCols = Math.ceil(Math.sqrt(bCount || 1));
    const bSpacing = 4.5;
    const distWidth = Math.max(8, bCols * bSpacing + 4);
    const distDepth = Math.max(8, Math.ceil(bCount / bCols) * bSpacing + 4);

    // District ground slab (dark asphalt with neon edge)
    const slabGeo = new THREE.BoxGeometry(distWidth, 0.4, distDepth);
    const slabMat = new THREE.MeshLambertMaterial({ color: 0x0f172a });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(centerX, -0.2, centerZ);
    townGroup.add(slab);

    // District border outline
    const borderGeo = new THREE.EdgesGeometry(slabGeo);
    const borderMat = new THREE.LineBasicMaterial({ color: 0x334155, linewidth: 1 });
    const border = new THREE.LineSegments(borderGeo, borderMat);
    border.position.copy(slab.position);
    townGroup.add(border);

    // Buildings inside district
    dist.buildingIds.forEach((bId, bIdx) => {
      const b = state.buildings[bId];
      if (!b) return;

      const bx = (bIdx % bCols - (bCols - 1) / 2) * bSpacing;
      const bz = (Math.floor(bIdx / bCols) - (Math.ceil(bCount / bCols) - 1) / 2) * bSpacing;

      const bGroup = new THREE.Group();
      bGroup.position.set(centerX + bx, 0, centerZ + bz);
      bGroup.userData = { building: b };

      const bHeight = Math.max(1.2, b.height * 0.9);
      const bWidth = 2.4;
      const bDepth = 2.4;

      // Building geometry
      const bGeo = new THREE.BoxGeometry(bWidth, bHeight, bDepth);

      // Building material: state color + window pattern
      const stateColor = new THREE.Color(b.color);
      const bMat = new THREE.MeshLambertMaterial({
        color: stateColor,
        map: windowTexture,
        emissive: stateColor,
        emissiveIntensity: b.state === 'idle' ? 0.05 : 0.4,
      });

      const bMesh = new THREE.Mesh(bGeo, bMat);
      bMesh.position.y = bHeight / 2;
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;
      bGroup.add(bMesh);

      // Rooftop Beacon / Status Glow
      const beaconGeo = new THREE.SphereGeometry(0.4, 8, 8);
      const beaconMat = new THREE.MeshBasicMaterial({
        color: stateColor,
      });
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = bHeight + 0.4;
      bGroup.add(beacon);

      // Highlight ring if active
      if (state.activeBuildingId === b.id) {
        const ringGeo = new THREE.RingGeometry(1.6, 1.9, 16);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        bGroup.add(ring);
      }

      townGroup.add(bGroup);
      buildingMeshes.set(b.id, bGroup);
    });
  });
}

// ---------------------------------------------------------------------------
// Animation Loop
// ---------------------------------------------------------------------------
let clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);

  const time = clock.getElapsedTime();

  // Subtle starfield twinkling if motion is enabled
  if (stars && !prefersReducedMotion) {
    stars.rotation.y = time * 0.01;
  }

  // Active building beacon pulse
  if (currentState.activeBuildingId && !prefersReducedMotion) {
    const activeMesh = buildingMeshes.get(currentState.activeBuildingId);
    if (activeMesh) {
      const beacon = activeMesh.children[1];
      if (beacon) {
        const s = 1.0 + Math.sin(time * 6) * 0.25;
        beacon.scale.set(s, s, s);
      }
    }
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ---------------------------------------------------------------------------
// State Updates & UI Sync
// ---------------------------------------------------------------------------
function updateUI(state: SceneState): void {
  badges.idle.textContent = `◻ Idle: ${state.stats.idle}`;
  badges.read.textContent = `👁 Read: ${state.stats.read}`;
  badges.proposed.textContent = `✏ Proposed: ${state.stats.proposed}`;
  badges.applied.textContent = `✔ Applied: ${state.stats.applied}`;
  badges.rejected.textContent = `⊘ Rejected: ${state.stats.rejected}`;
  badges.failed.textContent = `⚠ Failed: ${state.stats.failed}`;
  badges.planned.textContent = `☐ Planned: ${state.stats.planned}`;
  badges.recovered.textContent = `↺ Recovered: ${state.stats.recovered}`;
  powerBadge.textContent = `⚡ Provider: ${POWER_TEXT[state.power.status]}${state.power.model ? ` (${state.power.model})` : ''}`;

  if (state.activeBuildingId) {
    const b = state.buildings[state.activeBuildingId];
    if (b) {
      activeTag.textContent = `• Active: ${b.name} (${b.icon} ${b.label})`;
      activeTag.style.color = b.color;
    }
  } else {
    activeTag.textContent = '';
  }

  if (is3DMode) {
    buildTown3D(state);
  } else {
    render2D(state);
  }
}

// ---------------------------------------------------------------------------
// Event Handlers & VS Code Message Dispatch
// ---------------------------------------------------------------------------
let recordedJournal: TownEvent[] = [];
let replayTimer: ReturnType<typeof setInterval> | null = null;

function replayJournal(): void {
  if (recordedJournal.length === 0) return;
  if (replayTimer) clearInterval(replayTimer);

  // Reset to idle
  currentState = sceneReducer(currentState, { type: 'reset' });
  updateUI(currentState);

  let step = 0;
  if (btnReplay) btnReplay.disabled = true;

  replayTimer = setInterval(() => {
    if (step >= recordedJournal.length) {
      if (replayTimer) clearInterval(replayTimer);
      replayTimer = null;
      if (btnReplay) btnReplay.disabled = false;
      return;
    }
    const ev = recordedJournal[step] as TownEvent;
    currentState = sceneReducer(currentState, ev);
    updateUI(currentState);
    step++;
  }, prefersReducedMotion ? 50 : 250);
}

btnToggleView.addEventListener('click', () => {
  if (!hasWebGL) return;
  is3DMode = !is3DMode;
  if (is3DMode) {
    btnToggleView.textContent = 'Switch to 2D';
    fallbackView.style.display = 'none';
    canvasContainer.style.display = 'block';
    buildTown3D(currentState);
  } else {
    btnToggleView.textContent = 'Switch to 3D';
    fallbackView.style.display = 'block';
    canvasContainer.style.display = 'none';
    render2D(currentState);
  }
});

btnResetCam.addEventListener('click', resetCamera);
if (btnReplay) {
  btnReplay.addEventListener('click', () => {
    vscode.postMessage({ type: 'replay_run' });
    replayJournal();
  });
}

window.addEventListener('message', (event: MessageEvent<HostToTown>) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;

  if (m.type === 'scene') {
    currentState = m.state;
    updateUI(currentState);
  } else if (m.type === 'journal') {
    recordedJournal = m.events;
  } else if (m.type === 'event') {
    if (m.event.type !== 'reset' && m.event.type !== 'init') {
      recordedJournal.push(m.event);
    }
    currentState = sceneReducer(currentState, m.event);
    updateUI(currentState);
  } else if (m.type === 'focus') {
    currentState = {
      ...currentState,
      activeBuildingId: m.path,
    };
    updateUI(currentState);
  }
});

// Start Three.js
init3D();
