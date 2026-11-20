// Regex-based TypeScript / JavaScript extraction (the TypeScript compiler is not bundled to keep the
// extension lean). Handles classes, function declarations, const/let arrow or function expressions,
// class methods (by brace depth), comments, and import/export-from/require/dynamic-import specifiers.
// Known limits: methods are found by brace depth on code with strings blanked, so unusual formatting
// (several members on one line) can be missed; overloads are recorded once per signature line with a body.
import type { IndexedSymbol } from './types';

const CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const FUNC = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const ARROW =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const METHOD = /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{=]+)?\{?\s*$/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'with', 'else', 'do', 'try', 'new', 'await', 'typeof']);

/** Blanks out comments and string/template contents so braces and keywords inside them are ignored. */
export function stripCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1])
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

export function extractTsSymbols(text: string): IndexedSymbol[] {
  const lines = stripCode(text).split('\n');
  const out: IndexedSymbol[] = [];
  let depth = 0;
  const classes: Array<{ name: string; depth: number }> = [];
  lines.forEach((line, i) => {
    while (classes.length && depth <= (classes[classes.length - 1] as { depth: number }).depth) classes.pop();
    const inClass = classes[classes.length - 1];
    const c = CLASS.exec(line);
    const f = c ? undefined : FUNC.exec(line);
    const a = c || f ? undefined : ARROW.exec(line);
    if (c) {
      out.push({ name: c[1] as string, kind: 'class', line: i + 1 });
      classes.push({ name: c[1] as string, depth });
    } else if (f) {
      out.push({ name: f[1] as string, kind: 'function', line: i + 1 });
    } else if (a) {
      out.push({ name: a[1] as string, kind: 'function', line: i + 1, ...(inClass && depth === inClass.depth + 1 ? { parent: inClass.name } : {}) });
    } else if (inClass && depth === inClass.depth + 1) {
      const m = METHOD.exec(line);
      if (m && !NOT_METHODS.has(m[1] as string) && m[1] !== 'constructor') out.push({ name: m[1] as string, kind: 'method', line: i + 1, parent: inClass.name });
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  });
  return out;
}

export function extractTsImports(text: string): string[] {
  // Specifiers live inside strings, so match on the original text after removing comments only.
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
    /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of noComments.matchAll(re)) out.add(m[1] as string);
  return [...out];
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolves a relative specifier to a workspace file, or undefined (bare package specifiers are external). */
export function resolveTsImport(spec: string, fromPath: string, files: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') dir.pop();
    else dir.push(seg);
  }
  const base = dir.join('/');
  const noJs = base.replace(/\.(m|c)?js$/, '');
  const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => noJs + e), ...EXTS.map((e) => `${base}/index${e}`)];
  return cands.find((c) => files.has(c));
}
