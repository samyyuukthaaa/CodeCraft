// Pure scene grammar: what each part of the workspace becomes in the town. No VS Code, no Three.js.
//   workspace -> town; folder -> district; file -> building (height clamped by lines);
//   tests -> labs; docs -> library; config and CLI files -> control centre; imports -> roads (filtered);
//   model provider -> power plant whose colour shows health.
// Every visual has a colour, an icon AND a text label (never colour alone).

export type BuildingKind = 'code' | 'lab' | 'library' | 'control';

export interface Visual {
  color: string;
  icon: string;
  label: string;
}

export const KIND_VISUALS: Record<BuildingKind, Visual> = {
  code: { color: '#cbd5e1', icon: '🏠', label: 'Code' },
  lab: { color: '#67e8f9', icon: '🧪', label: 'Lab (tests)' },
  library: { color: '#fde68a', icon: '📚', label: 'Library (docs)' },
  control: { color: '#f9a8d4', icon: '🎛', label: 'Control centre (config, CLI)' },
};

export type PowerStatusName = 'healthy' | 'retrying' | 'failed_over' | 'recovered';
export const POWER_VISUALS: Record<PowerStatusName, Visual> = {
  healthy: { color: '#22c55e', icon: '⚡', label: 'Healthy' },
  retrying: { color: '#f59e0b', icon: '⟳', label: 'Retrying' },
  failed_over: { color: '#f97316', icon: '⇄', label: 'Failed over' },
  recovered: { color: '#14b8a6', icon: '↺', label: 'Recovered' },
};

export type TestStatusName = 'unknown' | 'passed' | 'failed';
export const TEST_VISUALS: Record<TestStatusName, Visual> = {
  unknown: { color: '#64748b', icon: '·', label: 'Tests not run' },
  passed: { color: '#22c55e', icon: '✓', label: 'Tests pass' },
  failed: { color: '#ef4444', icon: '✗', label: 'Tests fail' },
};

/**
 * Warm district palette (original): wall and rooftop colours. Every district gets one deterministically from its id,
 * so the same workspace always looks the same. Idle buildings wear their district's colours; a building the agent
 * touches switches to its state colour (plus icon and text), so states stay easy to tell apart.
 */
export const DISTRICT_PALETTE: ReadonlyArray<{ wall: string; roof: string; name: string }> = [
  { name: 'terracotta', wall: '#c8734f', roof: '#7a2e1d' },
  { name: 'mustard', wall: '#d9a53f', roof: '#8a5a12' },
  { name: 'teal', wall: '#3f9e98', roof: '#16504c' },
  { name: 'plum', wall: '#9a6bb0', roof: '#4c2a63' },
  { name: 'coral', wall: '#e0806e', roof: '#8c3527' },
  { name: 'sage', wall: '#86a86b', roof: '#3d5a2a' },
  { name: 'sky', wall: '#5f9bd1', roof: '#1f4a78' },
  { name: 'rose', wall: '#d27a9c', roof: '#7a2d4b' },
  { name: 'apricot', wall: '#e3a06b', roof: '#8d4a1c' },
  { name: 'mint', wall: '#6dbf9e', roof: '#22614a' },
];

/** The district's palette entry: a stable hash of its id (no randomness). */
export function districtColors(id: string): { wall: string; roof: string; name: string } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return DISTRICT_PALETTE[h % DISTRICT_PALETTE.length]!;
}

/** Festival lantern colours over buildings whose change was applied or that recovered. */
export const LANTERN_COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff9f45', '#c77dff'] as const;

/** Rainbow accent for replays. */
export const REPLAY_RAINBOW = ['#ff5e5b', '#ffb347', '#ffe66d', '#7bd389', '#4fb3ff', '#9d7bff'] as const;

const CONTROL_NAMES = new Set([
  'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'manage.py', 'makefile', 'dockerfile', 'package.json', 'package-lock.json',
  'tsconfig.json', 'requirements.txt', 'requirements-dev.txt', '.flake8', '.editorconfig', '.pre-commit-config.yaml', 'noxfile.py', 'conftest.py',
]);
const CONTROL_EXT = /\.(toml|cfg|ini|ya?ml|json|lock|env\.example)$/i;
const CLI_NAME = /^(cli|__main__|main|cmd|command|commands)\.(py|[cm]?[jt]sx?)$/i;
const DOC_EXT = /\.(md|rst|adoc|txt)$/i;

export function kindOf(path: string, isTest: boolean): BuildingKind {
  const p = path.replace(/\\/g, '/');
  const base = (p.split('/').pop() ?? p).toLowerCase();
  if (isTest && base !== 'conftest.py') return 'lab';
  if (CONTROL_NAMES.has(base) || CLI_NAME.test(base) || CONTROL_EXT.test(base) || /^requirements.*\.txt$/.test(base) || /(^|\/)(\.github|bin|scripts|requirements)\//.test(p)) return 'control';
  if (DOC_EXT.test(base) || /(^|\/)docs?\//.test(p)) return 'library';
  return 'code';
}

/** Above this many files, districts are aggregated to their top AGGREGATE_DEPTH folder levels. */
export const AGGREGATE_THRESHOLD = 2000;
export const AGGREGATE_DEPTH = 2;

/** The district of a file: its folder, or (aggregated) the first AGGREGATE_DEPTH levels of that folder. */
export function districtOf(path: string, aggregated: boolean): string {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  if (i === -1) return '.';
  const folder = p.slice(0, i);
  return aggregated ? folder.split('/').slice(0, AGGREGATE_DEPTH).join('/') : folder;
}

export interface Road {
  /** `${from}->${to}` with from < to (undirected). */
  id: string;
  from: string;
  to: string;
  /** Number of file imports between the two districts. */
  weight: number;
}

/** At most this many roads are drawn; the heaviest district links win (ties by id, so it is deterministic). */
export const MAX_ROADS = 60;

/**
 * Imports -> roads between districts. Filtered to avoid clutter: only links between DIFFERENT districts, imports of
 * files in the town only, aggregated per district pair (undirected), heaviest MAX_ROADS kept.
 */
export function computeRoads(files: ReadonlyArray<{ path: string; imports?: readonly string[] }>, districtFor: (path: string) => string | undefined, max = MAX_ROADS): Road[] {
  const weights = new Map<string, number>();
  for (const f of files) {
    const a = districtFor(f.path);
    if (a === undefined) continue;
    for (const imp of new Set(f.imports ?? [])) {
      const b = districtFor(imp);
      if (b === undefined || b === a) continue;
      const [from, to] = a < b ? [a, b] : [b, a];
      const id = `${from}->${to}`;
      weights.set(id, (weights.get(id) ?? 0) + 1);
    }
  }
  return [...weights.entries()]
    .map(([id, weight]) => {
      const [from, to] = id.split('->') as [string, string];
      return { id, from, to, weight };
    })
    .sort((x, y) => y.weight - x.weight || x.id.localeCompare(y.id))
    .slice(0, max);
}
