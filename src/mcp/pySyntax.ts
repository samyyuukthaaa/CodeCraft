// Python syntax check of a proposed file, in memory: the content goes to `python` on stdin and is only compiled
// (compile(..., 'exec')), never written or run. Observed live (task2 on c7c390b): an over-escaped edit wrote literal
// backslash-n into tests/test_cli.py, a SyntaxError that broke test collection. With this check such a proposal is
// refused before review with the exact error and line, so the agent can fix it and the broken file is never written.
import { spawn } from 'node:child_process';

/** Returns undefined when the content compiles (or cannot be checked), or "message (line N, column M): code". */
export type SyntaxCheck = (path: string, content: string) => Promise<string | undefined>;

export const isPython = (path: string): boolean => /\.pyi?$/i.test(path);

const SCRIPT = [
  'import sys',
  'src = sys.stdin.buffer.read().decode("utf-8", "replace")',
  'try:',
  '    compile(src, sys.argv[1], "exec")',
  'except SyntaxError as e:',
  '    text = (e.text or "").strip()',
  '    print(f"{e.msg} (line {e.lineno}, column {e.offset})" + (f": {text[:200]}" if text else ""))',
  '    sys.exit(1)',
].join('\n');

/**
 * A SyntaxCheck using the given Python executable. If Python cannot be started the check is skipped (undefined) and
 * `onUnavailable` is called once, so a machine without Python still works (the tests then catch errors instead).
 */
export function pythonSyntaxCheck(python: string, onUnavailable?: (why: string) => void): SyntaxCheck {
  let unavailable = false;
  return (path, content) =>
    new Promise((resolve) => {
      if (!isPython(path) || unavailable) return resolve(undefined);
      let out = '';
      let settled = false;
      const done = (v: string | undefined): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const child = spawn(python, ['-c', SCRIPT, path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        done(undefined);
      }, 15_000);
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(timer);
        if (!unavailable) onUnavailable?.(e.message);
        unavailable = true;
        done(undefined);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 1 && out.trim() ? out.trim() : undefined);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(content, 'utf8');
    });
}
