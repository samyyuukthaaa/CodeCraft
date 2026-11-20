// Pure queries over a RepoIndex.
import type { IndexedSymbol, RepoIndex, SymbolKind } from './types';

export interface SymbolHit extends IndexedSymbol {
  path: string;
}

/** Case-insensitive search: exact name, then prefix, then substring; shorter paths first on ties. */
export function searchSymbols(index: RepoIndex, query: string, opts: { kind?: SymbolKind; limit?: number } = {}): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // "Class.method" narrows to methods of that class
  const [owner, member] = q.includes('.') ? (q.split('.', 2) as [string, string]) : [undefined, q];
  const hits: Array<SymbolHit & { score: number }> = [];
  for (const f of Object.values(index.files)) {
    for (const s of f.symbols) {
      if (opts.kind && s.kind !== opts.kind) continue;
      if (owner !== undefined && s.parent?.toLowerCase() !== owner) continue;
      const n = s.name.toLowerCase();
      const score = n === member ? 0 : n.startsWith(member) ? 1 : n.includes(member) ? 2 : -1;
      if (score >= 0) hits.push({ ...s, path: f.path, score: score * 10 + (f.isTest ? 5 : 0) });
    }
  }
  hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, opts.limit ?? 50).map(({ score: _s, ...h }) => h);
}

export interface Related {
  path: string;
  imports: string[];
  importedBy: string[];
  tests: string[];
}

function stem(p: string): string {
  const name = p.split('/').pop() ?? p;
  return name.replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/_test$/, '');
}

/** A file NAMED like a test (not merely located under tests/, which also holds fixtures and helpers). */
function isTestFileName(p: string): boolean {
  const name = p.split('/').pop() ?? p;
  return /^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

/** Importers, imported files and matching tests (by name convention or because the test imports it). */
export function listRelated(index: RepoIndex, path: string): Related | undefined {
  const f = index.files[path];
  if (!f) return undefined;
  const importedBy: string[] = [];
  const tests = new Set<string>();
  const s = stem(path);
  for (const other of Object.values(index.files)) {
    if (other.path === path) continue;
    const importsIt = other.imports.includes(path);
    if (importsIt) importedBy.push(other.path);
    // Fixture apps and conftest.py under tests/ still show up in importedBy, but are not "tests" of this file.
    if (!f.isTest && isTestFileName(other.path) && (importsIt || (s.length > 2 && stem(other.path) === s))) tests.add(other.path);
  }
  return { path, imports: [...f.imports], importedBy: importedBy.sort(), tests: [...tests].sort() };
}
