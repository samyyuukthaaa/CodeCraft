// Bundles the extension host (node, cjs), the webview script (browser, iife) and, with --tests,
// each test file (node, cjs) into out/. Typechecking is separate: `npm run typecheck`.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const tests = process.argv.includes('--tests');
const scenarios = process.argv.includes('--scenarios');
const vscodeTests = process.argv.includes('--vscode');

if (vscodeTests) {
  await build({ ...common, entryPoints: ['test/vscode/suite.ts'], outfile: 'out/vscode/suite.js', platform: 'node', format: 'cjs', external: ['vscode'] });
  await build({ ...common, entryPoints: ['test/vscode/run.ts'], outfile: 'out/vscode/run.js', platform: 'node', format: 'cjs', external: ['vscode', '@vscode/test-electron'] });
} else if (scenarios) {
  for (const name of ['run', 'probe', 'failure-table', 'capture-errors', 'ask-user', 'town-preview', 'town-perf']) {
    await build({ ...common, entryPoints: [`test/scenarios/${name}.ts`], outfile: `out/scenarios/${name}.js`, platform: 'node', format: 'cjs', external: ['vscode'] });
  }
} else if (tests) {
  const entries = readdirSync('test')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `test/${f}`);
  await build({
    ...common,
    entryPoints: entries,
    outdir: 'out/test',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
} else {
  await build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  });
  await build({
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'out/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
  await build({
    ...common,
    entryPoints: ['src/webview/codetown.ts'],
    outfile: 'out/codetown.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
}
