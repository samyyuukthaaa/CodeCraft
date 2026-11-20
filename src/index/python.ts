// Line-based Python extraction (no interpreter needed). Handles classes, def/async def, methods,
// nested functions, decorators, docstrings that contain "def", and multi-line / relative imports.
// Known limits: definitions created dynamically (exec, setattr) and conditional imports are still recorded
// as written; string literals that are not triple-quoted are not tracked across lines.
import type { IndexedSymbol } from './types';

export interface PyImport {
  /** Module path as written, without leading dots ("" for `from . import x`). */
  module: string;
  /** Number of leading dots (0 = absolute). */
  level: number;
  /** Names after `from x import ...` ("*" allowed); empty for `import x`. */
  names: string[];
}

const DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CLASS = /^(\s*)class\s+([A-Za-z_]\w*)\s*[(:]/;

/** Replaces the inside of triple-quoted strings with blanks so their content is never parsed. */
function stripTripleStrings(text: string): string {
  return text.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, ' '));
}

export function extractPythonSymbols(text: string): IndexedSymbol[] {
  const lines = stripTripleStrings(text).split('\n');
  const out: IndexedSymbol[] = [];
  const stack: Array<{ indent: number; name: string; kind: 'class' | 'function' }> = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\t/g, '    ');
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    while (stack.length && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const c = CLASS.exec(line);
    if (c) {
      out.push({ name: c[2] as string, kind: 'class', line: i + 1, ...(parent ? { parent: parent.name } : {}) });
      stack.push({ indent, name: c[2] as string, kind: 'class' });
      return;
    }
    const d = DEF.exec(line);
    if (d) {
      const kind = parent?.kind === 'class' ? 'method' : 'function';
      out.push({ name: d[2] as string, kind, line: i + 1, ...(parent ? { parent: parent.name } : {}) });
      stack.push({ indent, name: d[2] as string, kind: 'function' });
    }
  });
  return out;
}

/** Joins parenthesised and backslash-continued import statements into single logical lines. */
function logicalLines(text: string): string[] {
  const src = stripTripleStrings(text)
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''));
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const l of src) {
    buf += (buf ? ' ' : '') + l.trim();
    for (const ch of l) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if (depth > 0 || buf.endsWith('\\')) {
      buf = buf.replace(/\\$/, '');
      continue;
    }
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

export function extractPythonImports(text: string): PyImport[] {
  const out: PyImport[] = [];
  for (const line of logicalLines(text)) {
    const from = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const names = (from[3] as string)
        .replace(/[()]/g, '')
        .split(',')
        .map((n) => n.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter(Boolean);
      out.push({ module: from[2] as string, level: (from[1] as string).length, names });
      continue;
    }
    const imp = /^import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of (imp[1] as string).split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (mod && /^[\w.]+$/.test(mod)) out.push({ module: mod, level: 0, names: [] });
      }
    }
  }
  return out;
}

/** Directories that act as import roots: the workspace root plus common source dirs that exist. */
export function pythonSourceRoots(files: ReadonlySet<string>): string[] {
  const roots = [''];
  for (const r of ['src', 'lib']) {
    for (const f of files) {
      if (f.startsWith(`${r}/`) && f.endsWith('/__init__.py')) {
        roots.push(r);
        break;
      }
    }
  }
  return roots;
}

function moduleFile(base: string, files: ReadonlySet<string>): string | undefined {
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
    const p = cand.replace(/^\//, '');
    if (files.has(p)) return p;
  }
  return undefined;
}

/** Resolves one import to workspace files. Returns [] for external modules. */
export function resolvePythonImport(imp: PyImport, fromPath: string, files: ReadonlySet<string>, roots: string[]): string[] {
  const modPath = imp.module.replace(/\./g, '/');
  const bases: string[] = [];
  if (imp.level > 0) {
    const dir = fromPath.split('/').slice(0, -1);
    const up = dir.slice(0, Math.max(0, dir.length - (imp.level - 1)));
    bases.push([...up, ...(modPath ? [modPath] : [])].join('/'));
  } else {
    for (const r of roots) bases.push(r ? `${r}/${modPath}` : modPath);
  }
  const out = new Set<string>();
  for (const base of bases) {
    const own = base ? moduleFile(base, files) : undefined;
    // `from pkg import sub` may import a submodule file rather than a name
    let subs = 0;
    for (const n of imp.names) {
      if (n === '*') continue;
      const sub = moduleFile(base ? `${base}/${n}` : n, files);
      if (sub) {
        out.add(sub);
        subs++;
      }
    }
    // `from . import cli` is about the submodule; an edge to the package __init__ would only add noise
    if (own && !(imp.module === '' && imp.level > 0 && subs > 0)) out.add(own);
    if (out.size) break;
    // `import a.b.c` where only a/b.py exists: fall back to the longest resolvable prefix
    if (imp.level === 0 && imp.names.length === 0) {
      const parts = base.split('/');
      for (let k = parts.length - 1; k > 0 && !out.size; k--) {
        const pre = moduleFile(parts.slice(0, k).join('/'), files);
        if (pre) out.add(pre);
      }
      if (out.size) break;
    }
  }
  out.delete(fromPath);
  return [...out];
}
