import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBuildingHeight,
  getDistrictAndName,
  initialSceneState,
  initSceneFromFiles,
  sceneReducer,
} from '../src/town/reducer';
import { STATE_VISUALS, TownFileInput } from '../src/town/types';

test('computeBuildingHeight: clamps heights between min and max', () => {
  assert.equal(computeBuildingHeight(0), 1);
  assert.equal(computeBuildingHeight(-50), 1);
  assert.equal(computeBuildingHeight(10), 1);
  assert.equal(computeBuildingHeight(20), 1);
  assert.equal(computeBuildingHeight(100), 5);
  assert.equal(computeBuildingHeight(200), 10);
  assert.equal(computeBuildingHeight(400), 20);
  assert.equal(computeBuildingHeight(10000), 20); // Clamped to max 20
});

test('getDistrictAndName: splits relative paths into district and filename', () => {
  assert.deepEqual(getDistrictAndName('src/mcp/gate.ts'), {
    district: 'src/mcp',
    name: 'gate.ts',
  });
  assert.deepEqual(getDistrictAndName('README.md'), {
    district: '.',
    name: 'README.md',
  });
  // Handles Windows backslashes
  assert.deepEqual(getDistrictAndName('src\\index\\service.ts'), {
    district: 'src/index',
    name: 'service.ts',
  });
});

test('initSceneFromFiles: folders are districts, files are buildings with states', () => {
  const files: TownFileInput[] = [
    { path: 'src/mcp/gate.ts', lines: 120, language: 'typescript' },
    { path: 'src/mcp/tools.ts', lines: 350, language: 'typescript' },
    { path: 'src/panel/AgentPanel.ts', lines: 60, language: 'typescript' },
    { path: 'README.md', lines: 90, language: 'markdown' },
  ];

  const state = initSceneFromFiles(files);

  assert.equal(state.totalBuildings, 4);
  assert.equal(Object.keys(state.districts).length, 3); // 'src/mcp', 'src/panel', '.'
  assert.ok(state.districts['src/mcp']);
  assert.deepEqual(state.districts['src/mcp'].buildingIds, ['src/mcp/gate.ts', 'src/mcp/tools.ts']);

  const gate = state.buildings['src/mcp/gate.ts'];
  assert.ok(gate);
  assert.equal(gate.name, 'gate.ts');
  assert.equal(gate.district, 'src/mcp');
  assert.equal(gate.height, 6); // 120 / 20 = 6
  assert.equal(gate.state, 'idle');
  assert.equal(gate.color, STATE_VISUALS.idle.color);
  assert.equal(gate.icon, STATE_VISUALS.idle.icon);
  assert.equal(gate.label, STATE_VISUALS.idle.label);

  assert.equal(state.stats.idle, 4);
  assert.equal(state.stats.read, 0);
});

test('sceneReducer: transitions building states correctly with icons, colors, and labels', () => {
  const files: TownFileInput[] = [
    { path: 'src/app.ts', lines: 100 },
    { path: 'src/util.ts', lines: 50 },
  ];

  let state = sceneReducer(initialSceneState(), { type: 'init', files, at: 1 });
  assert.equal(state.stats.idle, 2);

  // 1. file_read
  state = sceneReducer(state, { type: 'file_read', path: 'src/app.ts', at: 2 });
  const appRead = state.buildings['src/app.ts'];
  assert.ok(appRead);
  assert.equal(appRead.state, 'read');
  assert.equal(appRead.color, STATE_VISUALS.read.color);
  assert.equal(appRead.icon, STATE_VISUALS.read.icon);
  assert.equal(appRead.label, STATE_VISUALS.read.label);
  assert.equal(state.stats.read, 1);
  assert.equal(state.stats.idle, 1);
  assert.equal(state.activeBuildingId, 'src/app.ts');

  // 2. hunk_proposed
  state = sceneReducer(state, { type: 'hunk_proposed', path: 'src/app.ts', intent: 'refactor', hunks: 2, reason: 'refactor', at: 3 });
  const appProp = state.buildings['src/app.ts'];
  assert.ok(appProp);
  assert.equal(appProp.state, 'proposed');
  assert.equal(appProp.color, STATE_VISUALS.proposed.color);
  assert.equal(appProp.icon, STATE_VISUALS.proposed.icon);
  assert.equal(appProp.label, STATE_VISUALS.proposed.label);
  assert.equal(state.stats.proposed, 1);

  // 3. every hunk rejected
  state = sceneReducer(state, { type: 'hunk_decided', path: 'src/app.ts', accepted: 0, rejected: 2, at: 4 });
  const appRej = state.buildings['src/app.ts'];
  assert.ok(appRej);
  assert.equal(appRej.state, 'rejected');
  assert.equal(appRej.color, STATE_VISUALS.rejected.color);
  assert.equal(appRej.icon, STATE_VISUALS.rejected.icon);
  assert.equal(appRej.label, STATE_VISUALS.rejected.label);
  assert.equal(state.stats.rejected, 1);

  // 4. file_written (applied)
  state = sceneReducer(state, { type: 'file_written', path: 'src/app.ts', opId: 'op1', accepted: 1, rejected: 1, created: false, at: 5 });
  const appApp = state.buildings['src/app.ts'];
  assert.ok(appApp);
  assert.equal(appApp.state, 'applied');
  assert.equal(appApp.color, STATE_VISUALS.applied.color);
  assert.equal(appApp.icon, STATE_VISUALS.applied.icon);
  assert.equal(appApp.label, STATE_VISUALS.applied.label);
  assert.equal(state.stats.applied, 1);

  // 5. a failing test marks the building failed (provider errors never do: see town-journal tests)
  state = sceneReducer(state, { type: 'file_failed', path: 'src/util.ts', reason: 'a test that passed before now fails', at: 6 });
  const utilFailed = state.buildings['src/util.ts'];
  assert.ok(utilFailed);
  assert.equal(utilFailed.state, 'failed');
  assert.equal(utilFailed.color, STATE_VISUALS.failed.color);
  assert.equal(utilFailed.icon, STATE_VISUALS.failed.icon);
  assert.equal(utilFailed.label, STATE_VISUALS.failed.label);
  assert.equal(state.stats.failed, 1);

  // 6. reset
  state = sceneReducer(state, { type: 'reset' });
  assert.equal(state.stats.idle, 2);
  assert.ok(state.buildings['src/app.ts']);
  assert.ok(state.buildings['src/util.ts']);
  assert.equal(state.buildings['src/app.ts'].state, 'idle');
  assert.equal(state.buildings['src/util.ts'].state, 'idle');
});

test('sceneReducer: a file not in the index becomes a placeholder lot (no guessed size)', () => {
  const state = sceneReducer(initialSceneState(), { type: 'file_read', path: 'new_folder/dynamic.ts', at: 10 });

  const b = state.buildings['new_folder/dynamic.ts'];
  assert.ok(b);
  assert.equal(b.state, 'read');
  assert.equal(b.district, 'new_folder');
  assert.equal(b.name, 'dynamic.ts');
  assert.equal(b.placeholder, true);
  assert.equal(b.lines, 0);
  assert.equal(b.height, 1, 'the minimum height, not a guessed 50-line building');
  assert.equal(b.language, 'typescript');
  assert.equal(state.totalBuildings, 1);
});
