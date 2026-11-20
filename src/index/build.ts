// Workspace scan + index build. Node fs only (no VS Code), confined to the root. Incremental: a file whose
// size and mtime are unchanged reuses its previous entry; import edges are re-resolved every build because
// they depend on which files exist.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDenied } from '../mcp/paths';
import { extractPythonImports, extractPythonSymbols, pythonSourceRoots, resolvePythonImport, PyImport } from './python';
import { extractTsImports, extractTsSymbols, resolveTsImport } from './tsjs';
import { INDEX_VERSION, IndexedFile, Language, RepoIndex } from './types';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.venv', 'venv', 'env', '.env', '__pycache__', '.tox', '.nox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages', '.vscode-test', 'coverage', 'htmlcov', '.next', '.turbo', '.idea',
]);
export const MAX_FILES = 20_000;
export const MAX_PARSE_BYTES = 1_000_000;

export function languageOf(p: string): Language {
  if (p.endsWith('.py')) return 'python';
  if (/\.(ts|tsx|mts|cts)$/.test(p) && !p.endsWith('.d.ts')) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(p)) return 'javascript';
  return 'other';
}

export function isTestPath(p: string): boolean {
  const name = p.split('/').pop() ?? p;
  return (
    /(^|\/)(tests?|__tests__)\//.test(p) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    name === 'conftest.py'
  );
}

interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export async function scanWorkspace(root: string): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const files: ScannedFile[] = [];
  let truncated = false;
  const walk = async (rel: string): Promise<void> => {
    if (truncated) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
        await walk(p);
      } else if (e.isFile()) {
        if (isDenied(p)) continue;
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        try {
          const st = await fs.stat(path.join(root, p));
          files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  await walk('');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

interface Parsed {
  entry: IndexedFile;
  pyImports?: PyImport[];
  tsImports?: string[];
}

async function parseFile(root: string, f: ScannedFile): Promise<Parsed> {
  const language = languageOf(f.path);
  const base: IndexedFile = { path: f.path, language, size: f.size, lines: 0, mtimeMs: f.mtimeMs, isTest: isTestPath(f.path), symbols: [], imports: [], externalImports: [] };
  if (f.size > MAX_PARSE_BYTES) return { entry: { ...base, skippedParse: true } };
  let text: string;
  try {
    text = await fs.readFile(path.join(root, f.path), 'utf8');
  } catch {
    return { entry: { ...base, skippedParse: true } };
  }
  if (text.includes('\0')) return { entry: { ...base, skippedParse: true } };
  base.lines = text === '' ? 0 : text.split('\n').length;
  if (language === 'python') return { entry: { ...base, symbols: extractPythonSymbols(text) }, pyImports: extractPythonImports(text) };
  if (language === 'typescript' || language === 'javascript') return { entry: { ...base, symbols: extractTsSymbols(text) }, tsImports: extractTsImports(text) };
  return { entry: base };
}

/** Raw (unresolved) imports kept alongside the persisted index so unchanged files need no re-read. */
type RawImports = Record<string, { py?: PyImport[]; ts?: string[] }>;

export interface BuildResult {
  index: RepoIndex;
  raw: RawImports;
}

export async function buildIndex(root: string, previous?: BuildResult): Promise<BuildResult> {
  const t0 = performance.now();
  const { files: scanned, truncated } = await scanWorkspace(root);
  const files: Record<string, IndexedFile> = {};
  const raw: RawImports = {};
  let parsed = 0;
  let reused = 0;
  const prevFiles = previous?.index.version === INDEX_VERSION ? previous.index.files : undefined;
  const BATCH = 32;
  for (let i = 0; i < scanned.length; i += BATCH) {
    await Promise.all(
      scanned.slice(i, i + BATCH).map(async (f) => {
        const old = prevFiles?.[f.path];
        if (old && old.size === f.size && old.mtimeMs === f.mtimeMs && previous) {
          files[f.path] = { ...old, imports: [], externalImports: [] };
          raw[f.path] = previous.raw[f.path] ?? {};
          reused++;
          return;
        }
        const p = await parseFile(root, f);
        files[f.path] = p.entry;
        raw[f.path] = { ...(p.pyImports ? { py: p.pyImports } : {}), ...(p.tsImports ? { ts: p.tsImports } : {}) };
        parsed++;
      }),
    );
  }

  // Resolve edges against the current file set.
  const set = new Set(Object.keys(files));
  const roots = pythonSourceRoots(set);
  let edgeCount = 0;
  let symbolCount = 0;
  for (const [p, f] of Object.entries(files)) {
    const r = raw[p] ?? {};
    const imports = new Set<string>();
    const external = new Set<string>();
    for (const imp of r.py ?? []) {
      const res = resolvePythonImport(imp, p, set, roots);
      if (res.length) res.forEach((x) => imports.add(x));
      else if (imp.level === 0) external.add(imp.module.split('.')[0] as string);
      // Follow re-exports one hop: `from flask import Flask` where flask/__init__.py does `from .app import Flask`.
      for (const target of res) {
        if (!target.endsWith('__init__.py')) continue;
        for (const name of imp.names) {
          for (const inner of raw[target]?.py ?? []) {
            if (!inner.names.includes(name)) continue;
            for (const x of resolvePythonImport(inner, target, set, roots)) if (x !== p) imports.add(x);
          }
        }
      }
    }
    for (const spec of r.ts ?? []) {
      const res = resolveTsImport(spec, p, set);
      if (res && res !== p) imports.add(res);
      else if (!spec.startsWith('.')) external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string));
    }
    f.imports = [...imports].sort();
    f.externalImports = [...external].sort();
    edgeCount += f.imports.length;
    symbolCount += f.symbols.length;
  }

  const index: RepoIndex = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    files,
    stats: { totalFiles: scanned.length, parsedFiles: parsed, reusedFiles: reused, symbolCount, edgeCount, buildMs: Math.round(performance.now() - t0), truncated },
  };
  return { index, raw };
}

export async function saveIndex(file: string, result: BuildResult): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(result), 'utf8');
  await fs.rename(tmp, file);
}

export async function loadIndex(file: string): Promise<BuildResult | undefined> {
  try {
    const r = JSON.parse(await fs.readFile(file, 'utf8')) as BuildResult;
    return r?.index?.version === INDEX_VERSION ? r : undefined;
  } catch {
    return undefined;
  }
}
