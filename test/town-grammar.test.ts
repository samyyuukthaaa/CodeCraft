// Code Town step 2: scene grammar (kinds, districts, roads, power plant, every state with colour + icon + text,
// aggregation above ~2,000 files). Pure: no VS Code, no Three.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGGREGATE_THRESHOLD, KIND_VISUALS, MAX_ROADS, POWER_VISUALS, TEST_VISUALS, computeRoads, districtOf, kindOf } from '../src/town/grammar';
import { initSceneFromFiles, sceneReducer } from '../src/town/reducer';
import { BUILDING_STATES, STATE_VISUALS, TownFileInput } from '../src/town/types';

test('kinds: tests are labs, docs are the library, config and CLI files are the control centre, the rest is code', () => {
  const cases: Array<[string, boolean, string]> = [
    ['tests/test_cli.py', true, 'lab'],
    ['src/app.test.ts', true, 'lab'],
    ['tests/conftest.py', true, 'control'],
    ['docs/cli.rst', false, 'library'],
    ['README.md', false, 'library'],
    ['CHANGES.rst', false, 'library'],
    ['pyproject.toml', false, 'control'],
    ['package.json', false, 'control'],
    ['.github/workflows/tests.yaml', false, 'control'],
    ['src/flask/cli.py', false, 'control'],
    ['src/flask/__main__.py', false, 'control'],
    ['requirements/dev.txt', false, 'control'],
    ['requirements-dev.txt', false, 'control'],
    ['src/flask/app.py', false, 'code'],
    ['src/index/service.ts', false, 'code'],
  ];
  for (const [p, isTest, want] of cases) assert.equal(kindOf(p, isTest), want, p);
});

test('visuals: every building state, kind, power status and test status has a colour, an icon and a text label', () => {
  const all = [...Object.values(STATE_VISUALS), ...Object.values(KIND_VISUALS), ...Object.values(POWER_VISUALS), ...Object.values(TEST_VISUALS)];
  for (const v of all) {
    assert.match(v.color, /^#[0-9a-f]{6}$/i);
    assert.ok(v.icon.length > 0 && v.label.length > 2, JSON.stringify(v));
  }
  assert.deepEqual(BUILDING_STATES, ['idle', 'planned', 'read', 'proposed', 'applied', 'rejected', 'failed', 'recovered']);
  assert.equal(new Set(BUILDING_STATES.map((s) => STATE_VISUALS[s].color)).size, BUILDING_STATES.length, 'states are distinguishable by colour');
  assert.equal(new Set(BUILDING_STATES.map((s) => STATE_VISUALS[s].icon)).size, BUILDING_STATES.length, '...and by icon');
  assert.deepEqual(Object.keys(POWER_VISUALS), ['healthy', 'retrying', 'failed_over', 'recovered']);
});

test('buildings: folder -> district, clamped height, kind; placeholder lots keep their kind', () => {
  const s = initSceneFromFiles([
    { path: 'src/flask/cli.py', lines: 1100 },
    { path: 'tests/test_cli.py', lines: 5, isTest: true },
    { path: 'docs/index.rst', lines: 200 },
  ]);
  assert.deepEqual([s.buildings['src/flask/cli.py']!.height, s.buildings['tests/test_cli.py']!.height, s.buildings['docs/index.rst']!.height], [20, 1, 10]);
  assert.deepEqual(Object.values(s.buildings).map((b) => [b.district, b.kind]), [['src/flask', 'control'], ['tests', 'lab'], ['docs', 'library']]);
  const t = sceneReducer(s, { type: 'file_written', path: 'tests/test_new.py', opId: 'o', accepted: 1, rejected: 0, created: true, at: 1 });
  assert.equal(t.buildings['tests/test_new.py']!.kind, 'lab');
  assert.equal(t.buildings['tests/test_new.py']!.placeholder, true);
});

test('roads: imports between different districts only, aggregated per district pair, heaviest first, capped', () => {
  const files = [
    { path: 'src/a/x.py', imports: ['src/b/y.py', 'src/a/z.py', 'missing/q.py'] },
    { path: 'src/a/z.py', imports: ['src/b/y.py'] },
    { path: 'src/b/y.py', imports: ['src/a/x.py', 'src/c/w.py'] },
    { path: 'src/c/w.py', imports: [] },
  ];
  const d = (p: string) => (p.startsWith('missing') ? undefined : districtOf(p, false));
  assert.deepEqual(computeRoads(files, d), [
    { id: 'src/a->src/b', from: 'src/a', to: 'src/b', weight: 3 },
    { id: 'src/b->src/c', from: 'src/b', to: 'src/c', weight: 1 },
  ]);
  assert.equal(computeRoads(files, d, 1).length, 1);
  const many = Array.from({ length: 200 }, (_, i) => ({ path: `d${i}/f.py`, imports: [`d${i + 1}/f.py`] }));
  assert.equal(computeRoads(many, (p) => districtOf(p, false)).length, MAX_ROADS);
  const scene = initSceneFromFiles(files.map((f) => ({ ...f, lines: 10 })));
  assert.deepEqual(scene.roads.map((r) => r.id), ['src/a->src/b', 'src/b->src/c']);
});

test('aggregation: above ~2,000 files, nested folders merge into their top-level districts', () => {
  const small: TownFileInput[] = [{ path: 'a/b/c/d.py' }, { path: 'a/b/e.py' }];
  assert.equal(initSceneFromFiles(small).aggregated, false);
  assert.deepEqual(Object.keys(initSceneFromFiles(small).districts).sort(), ['a/b', 'a/b/c']);
  const big: TownFileInput[] = Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => ({ path: `pkg/mod${i % 40}/sub${i % 7}/f${i}.py`, lines: 10 }));
  const s = initSceneFromFiles(big);
  assert.equal(s.aggregated, true);
  assert.equal(s.totalBuildings, AGGREGATE_THRESHOLD + 1, 'every file is still a building');
  assert.equal(Object.keys(s.districts).length, 40, '280 folders become 40 districts');
  const b = s.buildings['pkg/mod3/sub3/f3.py']!;
  assert.deepEqual([b.district, b.folder], ['pkg/mod3', 'pkg/mod3/sub3']);
  assert.equal(s.districts['pkg/mod3']!.aggregated, true);
});

test('purity: the town model files import neither vscode nor three', () => {
  for (const f of ['types.ts', 'reducer.ts', 'grammar.ts', 'fromJournal.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'town', f), 'utf8');
    assert.doesNotMatch(src, /from ['"](vscode|three)['"]|require\(['"](vscode|three)['"]\)/, f);
  }
});
