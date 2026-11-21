// Code Town scene model. Pure data: no VS Code, no Three.js. The scene is laid out from the repository index and
// changed ONLY by town events, which are a projection of the append-only journal (src/town/fromJournal.ts).
import type { BuildingKind, Road } from './grammar';

export type BuildingState = 'idle' | 'planned' | 'read' | 'proposed' | 'applied' | 'rejected' | 'failed' | 'recovered';

/** Real test status of a building (from real test runs in the journal). */
export type TestStatus = 'unknown' | 'passed' | 'failed';

export interface StateVisual {
  color: string;
  icon: string;
  label: string;
}

export const STATE_VISUALS: Record<BuildingState, StateVisual> = {
  idle: { color: '#475569', icon: '◻', label: 'Idle' },
  planned: { color: '#a78bfa', icon: '☐', label: 'Planned' },
  read: { color: '#0284c7', icon: '👁', label: 'Read' },
  proposed: { color: '#f59e0b', icon: '✏', label: 'Proposed' },
  applied: { color: '#16a34a', icon: '✔', label: 'Applied' },
  rejected: { color: '#94a3b8', icon: '⊘', label: 'Rejected' },
  failed: { color: '#ef4444', icon: '⚠', label: 'Failed' },
  recovered: { color: '#14b8a6', icon: '↺', label: 'Recovered' },
};

export const BUILDING_STATES = Object.keys(STATE_VISUALS) as BuildingState[];

export interface TownFileInput {
  path: string;
  lines?: number;
  size?: number;
  language?: string;
  isTest?: boolean;
  /** Workspace-relative paths this file imports (from the index): roads. */
  imports?: string[];
}

/** What the agent last did to a building (for the inspector). */
export interface LastAction {
  type: TownEvent['type'];
  at: number;
  detail: string;
}

export interface Building {
  id: string;
  path: string;
  name: string;
  /** The district (the folder, or its top levels when the town is aggregated). */
  district: string;
  /** The real folder. */
  folder: string;
  /** Code, lab (tests), library (docs) or control centre (config, CLI). */
  kind: BuildingKind;
  lines: number;
  height: number;
  language: string;
  isTest: boolean;
  state: BuildingState;
  testStatus: TestStatus;
  color: string;
  icon: string;
  label: string;
  /** True for a file that is not in the index (e.g. created during the run): drawn as a small lot. */
  placeholder: boolean;
  /** Why the agent touched it (plan or change group), when the journal says. */
  reason?: string;
  /** The change group's plain-English sentence and confidence tag (P5), when applied. */
  plain?: string;
  confidence?: string;
  lastAction?: LastAction;
  lastUpdated?: number;
}

export interface District {
  id: string;
  name: string;
  path: string;
  buildingIds: string[];
  /** True when nested folders were merged into this district (large workspaces). */
  aggregated?: boolean;
}

/** The model provider "power plant". */
export type PowerStatus = 'healthy' | 'retrying' | 'failed_over' | 'recovered';

export interface PowerPlant {
  status: PowerStatus;
  /** Model currently serving the run, when known. */
  model?: string;
  detail?: string;
  at?: number;
}

/** One stop of the agent's journey. */
export interface JourneyStep {
  path: string;
  type: TownEvent['type'];
  at: number;
}

/** Every event carries its own timestamp (`at`, epoch ms); the reducer never reads the clock. */
export type TownEvent =
  | { type: 'init'; files: TownFileInput[]; at: number }
  | { type: 'run_started'; runId: string; request?: string; at: number }
  | { type: 'run_finished'; status: string; at: number }
  | { type: 'file_planned'; path: string; action: 'edit' | 'create'; why?: string; at: number }
  | { type: 'file_read'; path: string; at: number }
  | { type: 'hunk_proposed'; path: string; intent: string; hunks: number; reason?: string; at: number }
  | { type: 'hunk_decided'; path: string; accepted: number; rejected: number; at: number }
  | { type: 'file_written'; path: string; opId: string; accepted: number; rejected: number; created: boolean; at: number }
  | { type: 'file_reverted'; path: string; opId: string; at: number }
  | { type: 'test_run'; passed: boolean; failing: string[]; phase: string; at: number }
  | { type: 'file_failed'; path: string; reason: string; at: number }
  | { type: 'provider'; status: PowerStatus; model?: string; detail?: string; at: number }
  | { type: 'file_note'; path: string; reason: string; plain: string; confidence: string; at: number }
  | { type: 'reset' };

export type SceneStats = Record<BuildingState, number>;

export interface SceneState {
  districts: Record<string, District>;
  buildings: Record<string, Building>;
  activeBuildingId?: string;
  totalBuildings: number;
  stats: SceneStats;
  power: PowerPlant;
  /** Import links between districts (filtered), from the index. */
  roads: Road[];
  /** True above AGGREGATE_THRESHOLD files: districts are the top folder levels. */
  aggregated: boolean;
  /** The run the scene shows. */
  runId?: string;
  /** The path the agent took through the town in this run (Agent Journey mode), in order. */
  journey: JourneyStep[];
  /** Last real test run of the run. */
  tests?: { passed: boolean; failing: string[]; phase: string; at: number };
  lastEvent?: TownEvent;
  version: number;
}
