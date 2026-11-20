// npm run scenario -- <task1|task2|task3...> [--runs N] [--record]
// Runs each scenario N times in a row (default 3) and prints a summary. With --record, appends the
// summary rows (real output only) to docs/RESULTS.md and the full JSON to docs/results/.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunRecord, Scenario, runScenario, summaryRow } from './harness';
import { task1 } from './task1';
import { task2 } from './task2';
import { task3Fallback, task3NoFallback } from './task3';

const SCENARIOS: Record<string, Scenario> = { task1, task2, 'task3-fallback': task3Fallback, 'task3-nofallback': task3NoFallback };
/** task3 runs both Task C variants. */
const ALIASES: Record<string, string[]> = { task3: ['task3-fallback', 'task3-nofallback'] };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 3;
  const record = args.includes('--record');
  const ids = args.filter((a, i) => !a.startsWith('--') && (runsIdx < 0 || i !== runsIdx + 1)).flatMap((a) => ALIASES[a] ?? [a]);
  if (!ids.length || ids.some((id) => !SCENARIOS[id])) {
    console.error(`usage: npm run scenario -- <${[...Object.keys(SCENARIOS), ...Object.keys(ALIASES)].join('|')}> [--runs N] [--record]`);
    process.exitCode = 2;
    return;
  }
  const all: RunRecord[] = [];
  let tlsStop = false;
  outer: for (const id of ids) {
    const s = SCENARIOS[id] as Scenario;
    for (let n = 1; n <= runs; n++) {
      console.log(`\n=== ${s.id} run ${n}/${runs}: ${s.title}`);
      const r = await runScenario(s, n, (l) => console.log(`  ${l}`));
      all.push(r);
      for (const c of r.checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
      console.log(`  outcome=${r.outcome.status} agent=${r.finalAgent} changed=${r.changed.join(',') || '-'} read=${r.filesRead.length}/${r.totalFiles} tokens=${r.tokens} lag=${r.maxEventLoopLagMs}ms ${Math.round(r.durationMs / 1000)}s`);
      console.log(`  RUN ${r.pass ? 'PASS' : 'FAIL'}`);
      // Project rule: on a TLS certificate error, stop everything and report instead of retrying.
      if (/certificate has expired|tls_error|self[- ]signed certificate|unable to verify the first certificate/i.test(JSON.stringify(r))) {
        console.log('  STOPPED: a TLS certificate error occurred (machine network/TLS problem). Not retrying; fix the network and run again.');
        tlsStop = true;
        break outer;
      }
      // "3 in a row" is already lost after a failure: stop this scenario so the root cause is fixed first.
      if (!r.pass && !process.argv.includes('--keep-going')) {
        console.log(`  ${s.id}: stopping after the first failed run (use --keep-going to continue)`);
        break;
      }
    }
  }
  console.log('\n| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of all) console.log(summaryRow(r));
  if (record) {
    const dir = path.resolve('docs/results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${ids.join('-')}-${stamp}.json`), JSON.stringify(all, null, 2));
    fs.appendFileSync(path.resolve('docs/RESULTS.md'), `\n### ${ids.join(', ')}: ${runs} run(s), ${new Date().toISOString()}\n\n| scenario | run | result | agent | files changed | context files | files read | tokens | time | max event-loop lag | failed checks |\n|---|---|---|---|---|---|---|---|---|---|---|\n${all.map(summaryRow).join('\n')}\n`);
    console.log(`recorded to docs/RESULTS.md and docs/results/`);
  }
  process.exitCode = tlsStop ? 3 : all.length > 0 && all.every((r) => r.pass) ? 0 : 1;
}
void main();
