export type BuildingState = 'idle' | 'read' | 'proposed' | 'applied' | 'rejected' | 'failed';

export interface StateVisual {
  color: string;
  icon: string;
  label: string;
}

export const STATE_VISUALS: Record<BuildingState, StateVisual> = {
  idle: { color: '#475569', icon: '◻', label: 'Idle' },
  read: { color: '#0284c7', icon: '👁', label: 'Read' },
  proposed: { color: '#f59e0b', icon: '✏', label: 'Proposed' },
  applied: { color: '#16a34a', icon: '✔', label: 'Applied' },
  rejected: { color: '#94a3b8', icon: '⊘', label: 'Rejected' },
  failed: { color: '#ef4444', icon: '⚠', label: 'Failed' },
};

export interface TownFileInput {
  path: string;
  lines?: number;
  size?: number;
  language?: string;
  isTest?: boolean;
}

export interface Building {
  id: string;
  path: string;
  name: string;
  district: string;
  lines: number;
  height: number;
  language: string;
  isTest: boolean;
  state: BuildingState;
  color: string;
  icon: string;
  label: string;
  lastUpdated?: number;
}

export interface District {
  id: string;
  name: string;
  path: string;
  buildingIds: string[];
}

export type TownEvent =
  | { type: 'init'; files: TownFileInput[] }
  | { type: 'file_read'; path: string; timestamp?: number }
  | { type: 'hunk_proposed'; path: string; reason?: string; timestamp?: number }
  | { type: 'hunk_decided'; path: string; decision: 'accepted' | 'rejected'; timestamp?: number }
  | { type: 'file_written'; path: string; timestamp?: number }
  | { type: 'test_run'; path?: string; passed?: boolean; timestamp?: number }
  | { type: 'model_failed'; path?: string; error?: string; timestamp?: number }
  | { type: 'run_started'; timestamp?: number }
  | { type: 'run_finished'; timestamp?: number }
  | { type: 'reset' };

export interface SceneStats {
  idle: number;
  read: number;
  proposed: number;
  applied: number;
  rejected: number;
  failed: number;
}

export interface SceneState {
  districts: Record<string, District>;
  buildings: Record<string, Building>;
  activeBuildingId?: string;
  totalBuildings: number;
  stats: SceneStats;
  lastEvent?: TownEvent;
  version: number;
}
