// Task A (docs/TASKS.md): select get_debug_flag in src/flask/helpers.py and instruct the change.
// Pass criteria: the task's own verification, a value table, the docstring, the full Flask suite.
import { Check, PY, Scenario, pytest, sh } from './harness';

const FALSE_VALUES = ['0', 'false', 'no', 'off', 'n'];

export const task1: Scenario = {
  id: 'task1',
  title: "Task A: treat 'off' and 'n' as false in get_debug_flag",
  prompt: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
  review: 'accept',
  selection: (index) => {
    const f = index.files['src/flask/helpers.py'];
    const s = f?.symbols.find((x) => x.name === 'get_debug_flag');
    if (!f || !s) throw new Error('get_debug_flag not found in src/flask/helpers.py');
    const next = f.symbols.filter((x) => x.line > s.line && !x.parent).sort((a, b) => a.line - b.line)[0];
    return { path: 'src/flask/helpers.py', startLine: s.line, endLine: next ? next.line - 1 : s.line + 15 };
  },
  async verify(run) {
    const checks: Check[] = [];
    checks.push({ name: 'agent run finished', pass: run.outcome.status === 'done', detail: run.outcome.status === 'done' ? 'done' : JSON.stringify(run.outcome) });
    // Scope: helpers.py must change; added or updated tests are allowed, nothing else.
    const outOfScope = run.changed.filter((p) => p !== 'src/flask/helpers.py' && !p.startsWith('tests/'));
    checks.push({ name: 'src/flask/helpers.py changed; nothing else except tests', pass: run.changed.includes('src/flask/helpers.py') && outOfScope.length === 0, detail: run.changed.join(', ') || '(nothing changed)' });

    // The task's own verification, exactly: FLASK_DEBUG=off python -c "...print(get_debug_flag())" shows False
    const own = await sh(PY, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], { env: { FLASK_DEBUG: 'off' } });
    checks.push({ name: 'TASKS.md check: FLASK_DEBUG=off prints False', pass: own.code === 0 && own.stdout.trim() === 'False', detail: `exit ${own.code}, stdout ${JSON.stringify(own.stdout.trim())}${own.stderr ? `, stderr ${own.stderr.trim().slice(-200)}` : ''}` });

    // Case-insensitive behaviour across old and new values, and values that must stay true.
    const table = await sh(PY, ['-c', [
      'import os, json',
      'from flask.helpers import get_debug_flag',
      'out = {}',
      "for v in ['off','OFF','Off','n','N','0','false','False','no','NO','','1','true','yes','on','y','debug']:",
      "    os.environ['FLASK_DEBUG'] = v",
      '    out[v] = get_debug_flag()',
      "os.environ.pop('FLASK_DEBUG', None)",
      "out['<unset>'] = get_debug_flag()",
      'print(json.dumps(out))',
    ].join('\n')]);
    let values: Record<string, boolean> = {};
    try {
      values = JSON.parse(table.stdout.trim()) as Record<string, boolean>;
    } catch {
      /* reported below */
    }
    const wantFalse = ['off', 'OFF', 'Off', 'n', 'N', '0', 'false', 'False', 'no', 'NO', '', '<unset>'];
    const wantTrue = ['1', 'true', 'yes', 'on', 'y', 'debug'];
    const wrong = [...wantFalse.filter((v) => values[v] !== false), ...wantTrue.filter((v) => values[v] !== true)];
    checks.push({ name: 'false for off/n/0/false/no (any case), empty and unset; true otherwise', pass: table.code === 0 && wrong.length === 0, detail: table.code === 0 ? (wrong.length ? `wrong for ${wrong.map((w) => JSON.stringify(w)).join(', ')}` : 'all 18 values correct') : table.stderr.trim().slice(-300) });

    // Docstring lists every value treated as false.
    const doc = await sh(PY, ['-c', 'import inspect; from flask.helpers import get_debug_flag; print(inspect.getdoc(get_debug_flag) or "")']);
    const text = doc.stdout;
    const missing = FALSE_VALUES.filter((v) => !new RegExp(`(["'\`])${v}\\1`, 'i').test(text));
    checks.push({ name: 'docstring lists every false value (0, false, no, off, n)', pass: doc.code === 0 && missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')} in: ${JSON.stringify(text.slice(0, 400))}` : JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 300)) });

    // The real Flask suite: no failures or errors, nothing lost.
    const suite = await pytest();
    checks.push({ name: 'full Flask test suite passes (>= 490 passed, 0 failed)', pass: suite.proc.code === 0 && suite.failed === 0 && suite.errors === 0 && suite.passed >= 490, detail: suite.summary });
    return checks;
  },
};
