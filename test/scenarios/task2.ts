// Task B (docs/TASKS.md): add a built-in `flask config` command, with no files mentioned.
// Pass criteria: the task's own verification plus checks that each stated requirement is really met.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Check, PY, ROOT, Scenario, git, pytest, sh } from './harness';

const DEMO_APP = [
  'from flask import Flask',
  '',
  'app = Flask(__name__)',
  'app.config.update(',
  '    SECRET_KEY="demo-secret-value",',
  '    DB_PASSWORD="demo-password-value",',
  '    API_TOKEN="demo-token-value",',
  '    MY_KEY="demo-key-value",',
  '    PUBLIC_SETTING="visible-value",',
  ')',
  '',
].join('\n');

export const task2: Scenario = {
  id: 'task2',
  title: 'Task B: built-in `flask config` command with masking, test and docs',
  prompt:
    'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.',
  review: 'accept',
  async verify(run) {
    const checks: Check[] = [];
    checks.push({ name: 'agent run finished', pass: run.outcome.status === 'done', detail: run.outcome.status === 'done' ? 'done' : JSON.stringify(run.outcome) });
    checks.push({ name: 'TASKS.md: the diff touches at least three files', pass: run.changed.length >= 3, detail: run.changed.join(', ') || '(nothing changed)' });

    // TASKS.md: pytest tests/test_cli.py -q passes
    const cli = await pytest(['tests/test_cli.py']);
    checks.push({ name: 'TASKS.md: pytest tests/test_cli.py -q passes', pass: cli.proc.code === 0 && cli.failed === 0 && cli.errors === 0 && cli.passed > 0, detail: cli.summary });

    // TASKS.md: run the new command against a Flask app and show the masked JSON
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codecraft-demoapp-'));
    try {
      fs.writeFileSync(path.join(dir, 'demo_app.py'), DEMO_APP);
      const out = await sh(PY, ['-m', 'flask', '--app', 'demo_app', 'config'], { cwd: dir });
      let cfg: Record<string, unknown> | undefined;
      try {
        cfg = JSON.parse(out.stdout) as Record<string, unknown>;
      } catch {
        cfg = undefined;
      }
      checks.push({ name: 'TASKS.md: `flask config` prints JSON', pass: out.code === 0 && cfg !== undefined, detail: out.code === 0 ? (cfg ? `${Object.keys(cfg).length} keys` : `not JSON: ${out.stdout.slice(0, 200)}`) : `exit ${out.code}: ${out.stderr.trim().slice(-300)}` });
      if (cfg) {
        const masked = ['SECRET_KEY', 'DB_PASSWORD', 'API_TOKEN', 'MY_KEY'];
        const notMasked = masked.filter((k) => cfg?.[k] !== '***');
        const leaked = ['demo-secret-value', 'demo-password-value', 'demo-token-value', 'demo-key-value'].filter((v) => out.stdout.includes(v));
        checks.push({ name: 'values of keys containing SECRET, PASSWORD, TOKEN or KEY are "***"', pass: notMasked.length === 0 && leaked.length === 0, detail: notMasked.length || leaked.length ? `not masked: ${notMasked.join(', ') || '-'}; leaked: ${leaked.length}` : masked.map((k) => `${k}=${JSON.stringify(cfg?.[k])}`).join(', ') });
        checks.push({ name: 'other values are shown unmasked', pass: cfg.PUBLIC_SETTING === 'visible-value', detail: `PUBLIC_SETTING=${JSON.stringify(cfg.PUBLIC_SETTING)}` });
        run.activity.push(`masked JSON sample: ${JSON.stringify(Object.fromEntries(['SECRET_KEY', 'DB_PASSWORD', 'API_TOKEN', 'MY_KEY', 'PUBLIC_SETTING', 'DEBUG'].map((k) => [k, cfg?.[k]])))}`);
      }
      // TASKS.md: it must appear in flask --help
      const help = await sh(PY, ['-m', 'flask', '--app', 'demo_app', '--help'], { cwd: dir });
      checks.push({ name: 'TASKS.md: `config` appears in flask --help', pass: help.code === 0 && /^\s+config\s/m.test(help.stdout), detail: help.stdout.split('\n').filter((l) => /^\s+\w+\s/.test(l) && /Commands:/.test(help.stdout)).map((l) => l.trim().split(/\s+/)[0]).join(', ') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Covered by a test: a changed test file exercises the config command.
    const testFiles = run.changed.filter((p) => p.startsWith('tests/'));
    let added = '';
    if (testFiles.length) {
      added = (await git('diff', '--', ...testFiles)).stdout
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .join('\n');
      const untracked = (await git('ls-files', '--others', '--exclude-standard', '--', ...testFiles)).stdout.split('\n').filter(Boolean);
      for (const p of untracked) added += `\n${fs.readFileSync(path.join(ROOT, p), 'utf8')}`;
    }
    const invokes = /["']config["']/.test(added);
    checks.push({ name: 'covered by a test (added test code invokes "config")', pass: testFiles.length > 0 && invokes, detail: testFiles.length ? `${testFiles.join(', ')}${invokes ? '' : ' (no added line invokes "config")'}` : 'no test file changed' });

    // Documented alongside the other built-in commands (docs/cli.rst documents run, shell, routes).
    const docDiff = (await git('diff', '--', 'docs/cli.rst')).stdout;
    const documented = run.changed.includes('docs/cli.rst') && /^\+.*\bconfig\b/m.test(docDiff);
    checks.push({ name: 'documented in docs/cli.rst with the other built-in commands', pass: documented, detail: run.changed.filter((p) => p.startsWith('docs/')).join(', ') || 'no docs changed' });

    // The real Flask suite still passes.
    const suite = await pytest();
    checks.push({ name: 'full Flask test suite passes (0 failed)', pass: suite.proc.code === 0 && suite.failed === 0 && suite.errors === 0 && suite.passed >= 490, detail: suite.summary });

    // Evidence for "show the TrueForge session".
    checks.push({ name: 'TrueForge session recorded', pass: run.sessions.length > 0, detail: run.sessions.map((s) => `${s.agent}: ${s.id}`).join(', ') });
    return checks;
  },
};
