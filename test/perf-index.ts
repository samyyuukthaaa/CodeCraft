// Index performance measurement (not part of `npm test`): npm run perf-index [-- <root>]
// Prints real timings for a cold build, a warm (incremental, nothing changed) build and a save/load cycle.
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIndex, loadIndex, saveIndex } from '../src/index/build';
import { listRelated, searchSymbols } from '../src/index/query';

async function main(): Promise<void> {
  const root = path.resolve(process.argv[2] ?? 'fixtures/flask');
  const runs = 5;
  const cold: number[] = [];
  let last = await buildIndex(root);
  for (let i = 0; i < runs; i++) {
    const r = await buildIndex(root);
    cold.push(r.index.stats.buildMs);
    last = r;
  }
  const warm: number[] = [];
  for (let i = 0; i < runs; i++) warm.push((await buildIndex(root, last)).index.stats.buildMs);
  const file = path.join(os.tmpdir(), `codecraft-perf-${process.pid}.json`);
  const t0 = performance.now();
  await saveIndex(file, last);
  const t1 = performance.now();
  const loaded = await loadIndex(file);
  const t2 = performance.now();
  const s = last.index.stats;
  const byLang: Record<string, number> = {};
  for (const f of Object.values(last.index.files)) byLang[f.language] = (byLang[f.language] ?? 0) + 1;
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(JSON.stringify({ root: path.basename(root), node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length }));
  console.log(`files=${s.totalFiles} byLanguage=${JSON.stringify(byLang)} symbols=${s.symbolCount} edges=${s.edgeCount} tests=${Object.values(last.index.files).filter((f) => f.isTest).length} truncated=${s.truncated}`);
  console.log(`cold build ms (${runs} runs): ${cold.join(', ')} median=${median(cold)}`);
  console.log(`warm build ms, nothing changed (${runs} runs): ${warm.join(', ')} median=${median(warm)}`);
  console.log(`save ms=${(t1 - t0).toFixed(1)} load ms=${(t2 - t1).toFixed(1)} loaded=${Boolean(loaded)} json bytes=${JSON.stringify(last).length}`);
  if (process.argv.includes('--sample')) {
    console.log('search Flask:', JSON.stringify(searchSymbols(last.index, 'Flask', { limit: 4 })));
    console.log('search Flask.route:', JSON.stringify(searchSymbols(last.index, 'App.route', { limit: 3 })));
    const app = Object.keys(last.index.files).find((p) => p.endsWith('flask/app.py')) ?? '';
    console.log('related', app, JSON.stringify(listRelated(last.index, app)));
    console.log('external of', app, JSON.stringify(last.index.files[app]?.externalImports));
    const t = Object.keys(last.index.files).find((p) => p.endsWith('tests/test_blueprints.py')) ?? '';
    console.log('imports of', t, JSON.stringify(last.index.files[t]?.imports));
  }
}
void main();
