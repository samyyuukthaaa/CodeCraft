// Index schema. Pure data, no VS Code or Three.js imports, so Code Town and tools can reuse it.
export type Language = 'python' | 'typescript' | 'javascript' | 'other';
export type SymbolKind = 'class' | 'function' | 'method';

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition. */
  line: number;
  /** Enclosing class (for methods) or function (for nested functions). */
  parent?: string;
}

export interface IndexedFile {
  path: string;
  language: Language;
  size: number;
  lines: number;
  mtimeMs: number;
  isTest: boolean;
  symbols: IndexedSymbol[];
  /** Workspace files this file imports (resolved, repo-relative). */
  imports: string[];
  /** Imports that did not resolve to a workspace file (packages, stdlib). */
  externalImports: string[];
  /** True when the file was too large or binary to parse; metadata only. */
  skippedParse?: boolean;
}

export interface IndexStats {
  totalFiles: number;
  parsedFiles: number;
  reusedFiles: number;
  symbolCount: number;
  edgeCount: number;
  buildMs: number;
  truncated: boolean;
}

export interface RepoIndex {
  version: number;
  builtAt: string;
  files: Record<string, IndexedFile>;
  stats: IndexStats;
}

export const INDEX_VERSION = 1;
