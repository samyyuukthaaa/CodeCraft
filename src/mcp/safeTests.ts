// Safe run_tests (P5): validate the configured command, split it into program + arguments (no shell
// chaining or redirection), and remove secret-looking variables from the test process environment.
// Pure and unit-tested; vscodeHost.ts uses it.

export interface ParsedCommand {
  file: string;
  args: string[];
  /** What the confirmation shows; exactly what runs. */
  display: string;
}

const META = /[;&|`$<>(){}\r\n]/;
export const MAX_COMMAND_CHARS = 300;

/** Splits on whitespace, honouring "double quotes" (no escapes, no shell syntax). */
function tokenize(cmd: string): string[] | undefined {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? '');
  // an unbalanced quote leaves a stray " in a bare token
  if (out.some((t) => t.includes('"'))) return undefined;
  return out;
}

export function parseTestCommand(cmd: string): { ok: true; command: ParsedCommand } | { ok: false; error: string } {
  const c = (cmd ?? '').trim();
  if (!c) return { ok: false, error: 'codecraft.testCommand is empty' };
  if (c.length > MAX_COMMAND_CHARS) return { ok: false, error: `codecraft.testCommand is longer than ${MAX_COMMAND_CHARS} characters` };
  if (META.test(c)) return { ok: false, error: 'codecraft.testCommand may not contain shell operators (; & | ` $ < > ( ) { } or newlines); use a single test command' };
  const tokens = tokenize(c);
  if (!tokens || tokens.length === 0) return { ok: false, error: 'codecraft.testCommand could not be parsed (check the quotes)' };
  const [file, ...args] = tokens as [string, ...string[]];
  return { ok: true, command: { file, args, display: tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ') } };
}

const SECRET_ENV = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(_|$)|^AWS_|_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$/i;

/** A copy of `env` without secret-looking variables (provider keys, tokens, passwords, cloud credentials). */
export function scrubEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV.test(k)) removed.push(k);
    else out[k] = v;
  }
  return { env: out, removed: removed.sort() };
}
