// Context budget: picks which files to put in front of the agent, and records why. Pure except for the
// injected reader. Token counts are ESTIMATES: ceil(characters / 4). No tokenizer is bundled.
import { redact } from '../util/redact';
import { listRelated, searchSymbols } from './query';
import type { RepoIndex } from './types';

export interface ContextRef {
  kind: 'file' | 'symbol';
  value: string;
}

export interface ContextItem {
  path: string;
  reason: string;
  tokens: number;
  included: boolean;
}

export interface ContextReport {
  budgetTokens: number;
  usedTokens: number;
  totalFiles: number;
  items: ContextItem[];
  /** @file / @symbol references that did not match anything. */
  unresolved: string[];
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const REF = /@(file|symbol):([^\s,;'"`]+)/g;

export function parseRefs(text: string): ContextRef[] {
  const out: ContextRef[] = [];
  for (const m of text.matchAll(REF)) {
    const value = (m[2] as string).replace(/[).:!?]+$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (value) out.push({ kind: m[1] as 'file' | 'symbol', value });
  }
  return out;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'into', 'file', 'files', 'make', 'have', 'should', 'when', 'what', 'where', 'which', 'there', 'their', 'then', 'than', 'them', 'they', 'will', 'would', 'could', 'please', 'change', 'update', 'test', 'tests', 'code', 'function', 'class', 'method', 'return', 'returns', 'value', 'add', 'fix', 'the', 'and', 'for', 'use', 'using', 'other', 'others', 'must', 'appear', 'appears', 'covered', 'documented', 'alongside', 'loaded', 'containing', 'prints', 'values', 'built', 'treat', 'treated', 'well', 'every', 'list', 'instruct', 'select', 'open', 'values', 'also', 'each', 'like', 'some', 'only', 'such']);

// Three-letter words are kept (e.g. "CLI"), minus common ones.
const STOP3 = new Set(['all', 'any', 'are', 'can', 'its', 'new', 'not', 'one', 'out', 'own', 'set', 'two', 'was', 'way', 'who', 'why', 'yes', 'key', 'get', 'per', 'via', 'see']);

function keywords(text: string): string[] {
  const words = text.replace(REF, ' ').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => !STOP.has(w) && !(w.length === 3 && STOP3.has(w))))].slice(0, 24);
}

const MAX_OUTLINE_ENTRIES = 80;
/** Largest share of the budget one non-explicit file may take whole. */
const PER_FILE_SHARE = 0.35;
const MAX_KEYWORD_EXCERPT_LINES = 80;

/** Section headings of a reStructuredText or Markdown document with line numbers, or undefined. */
function docOutline(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heads: string[] = [];
  for (let i = 0; i < lines.length && heads.length < MAX_OUTLINE_ENTRIES; i++) {
    const l = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (/^#{1,4}\s+\S/.test(l)) heads.push(`L${i + 1} ${l.trim()}`);
    else if (l.trim() && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(next) && next.trim().length >= l.trim().length) heads.push(`L${i + 1} ${l.trim()}`);
  }
  return heads.length ? `${lines.length} lines; sections (read with read_file(path, startLine, endLine)):\n${heads.join('\n')}` : undefined;
}

/** "L531 class FlaskGroup" lines for a file's symbols (methods indented), or undefined if it has none. */
function outlineOf(index: RepoIndex, path: string): string | undefined {
  const f = index.files[path];
  if (!f || f.symbols.length === 0) return undefined;
  const lines = f.symbols
    .slice(0, MAX_OUTLINE_ENTRIES)
    .map((s) => `${s.parent ? '    ' : ''}L${s.line} ${s.kind} ${s.parent ? `${s.parent}.` : ''}${s.name}`);
  const more = f.symbols.length > MAX_OUTLINE_ENTRIES ? `\n... ${f.symbols.length - MAX_OUTLINE_ENTRIES} more` : '';
  return `${f.lines} lines; read sections with read_file(path, startLine, endLine)\n${lines.join('\n')}${more}`;
}

const isDoc = (p: string): boolean => /\.(rst|md)$/i.test(p);
const stemOf = (p: string): string => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '').toLowerCase();

interface Candidate {
  path: string;
  priority: number;
  reason: string;
  /** 1-based inclusive line range to use as an excerpt when the whole file does not fit. */
  excerpt?: { start: number; end: number };
  /** Use only the excerpt, even if the whole file would fit (editor selections). */
  excerptOnly?: boolean;
}

const MAX_EXCERPT_LINES = 200;

/** Lines of a definition: from its line to just before the next symbol with the same parent (capped). */
function symbolRange(index: RepoIndex, path: string, line: number, parent: string | undefined): { start: number; end: number } {
  const f = index.files[path];
  const next = f?.symbols.filter((s) => s.line > line && s.parent === parent).sort((a, b) => a.line - b.line)[0];
  const end = Math.min(next ? next.line - 1 : line + MAX_EXCERPT_LINES - 1, line + MAX_EXCERPT_LINES - 1, f?.lines ?? line);
  return { start: line, end: Math.max(line, end) };
}

/** The user's editor selection (1-based inclusive lines), included first as an excerpt. */
export interface EditorSelection {
  path: string;
  startLine: number;
  endLine: number;
}

export interface SelectOptions {
  index: RepoIndex;
  text: string;
  budgetTokens: number;
  read: (path: string) => Promise<string | undefined>;
  selection?: EditorSelection;
}

export async function selectContext(opts: SelectOptions): Promise<{ report: ContextReport; contextText: string }> {
  const { index, text } = opts;
  const cands = new Map<string, Candidate>();
  const add = (path: string, priority: number, reason: string, excerpt?: { start: number; end: number }): void => {
    const f = index.files[path];
    if (!f || f.skippedParse) return;
    const prev = cands.get(path);
    if (!prev || priority < prev.priority) cands.set(path, { path, priority, reason, ...(excerpt ? { excerpt } : {}) });
  };
  const unresolved: string[] = [];

  // 0: the editor selection (always an excerpt of exactly the selected lines)
  const anchors: string[] = [];
  const sel = opts.selection && index.files[opts.selection.path] ? opts.selection : undefined;
  if (sel) {
    const start = Math.max(1, Math.min(sel.startLine, sel.endLine));
    const end = Math.max(sel.startLine, sel.endLine);
    const label = `selected in the editor (lines ${start}-${end})`;
    cands.set(sel.path, { path: sel.path, priority: -1, reason: label, excerpt: { start, end }, excerptOnly: true });
    anchors.push(sel.path);
  }

  // 1-2: explicit references
  for (const ref of parseRefs(text)) {
    if (ref.kind === 'file') {
      if (index.files[ref.value]) {
        add(ref.value, 0, 'referenced with @file');
        anchors.push(ref.value);
      } else unresolved.push(`@file:${ref.value}`);
    } else {
      const hits = searchSymbols(index, ref.value, { limit: 50 }).filter((h) => {
        const want = ref.value.toLowerCase().split('.').pop();
        return h.name.toLowerCase() === want;
      });
      if (!hits.length) unresolved.push(`@symbol:${ref.value}`);
      for (const h of hits.slice(0, 3)) {
        add(h.path, 1, `defines @symbol:${ref.value} (${h.kind}, line ${h.line})`, symbolRange(index, h.path, h.line, h.parent));
        anchors.push(h.path);
      }
    }
  }

  // 3: keywords that name a symbol or a file
  let kwAdded = 0;
  for (const kw of keywords(text)) {
    if (kwAdded >= 8) break;
    // Symbols defined in tests (e.g. a local `class Flask` inside a test) are not anchors; tests arrive as "test for X".
    const exact = searchSymbols(index, kw, { limit: 20 }).filter((h) => h.name.toLowerCase() === kw && !index.files[h.path]?.isTest);
    for (const h of exact.slice(0, 2)) {
      if (!cands.has(h.path)) kwAdded++;
      add(h.path, 2, `defines "${h.name}" mentioned in the request`, symbolRange(index, h.path, h.line, h.parent));
    }
    // File names count only for source code and documentation, not data/config files
    // (e.g. .github/ISSUE_TEMPLATE/config.yml or tests/static/config.json for the word "config").
    for (const f of Object.values(index.files)) {
      if (f.isTest || !(f.language !== 'other' || isDoc(f.path))) continue;
      if (stemOf(f.path) === kw && !cands.has(f.path)) {
        add(f.path, isDoc(f.path) ? 3 : 2, isDoc(f.path) ? `documentation page named "${kw}"` : `file name matches "${kw}"`);
        kwAdded++;
      }
    }
  }
  // Without explicit references, the code files found by keywords become the anchors.
  if (!anchors.length) for (const c of [...cands.values()].sort((x, y) => x.priority - y.priority)) if (c.priority === 2 && !isDoc(c.path)) anchors.push(c.path);

  // 4: neighbours of the anchors: their tests, their documentation page, and the files they import
  const docsByStem = new Map<string, string[]>();
  for (const f of Object.values(index.files)) if (isDoc(f.path)) docsByStem.set(stemOf(f.path), [...(docsByStem.get(stemOf(f.path)) ?? []), f.path]);
  for (const a of [...new Set(anchors)].slice(0, 4)) {
    const rel = listRelated(index, a);
    if (!rel) continue;
    for (const t of rel.tests.slice(0, 2)) add(t, 3, `test for ${a}`);
    for (const d of (docsByStem.get(stemOf(a)) ?? []).slice(0, 1)) add(d, 3, `documentation for ${a}`);
    for (const i of rel.imports.slice(0, 3)) add(i, 4, `imported by ${a}`);
  }

  // Greedy fill in priority order.
  const ordered = [...cands.values()].sort((x, y) => x.priority - y.priority || x.path.localeCompare(y.path));
  const items: ContextItem[] = [];
  const parts: string[] = [];
  let used = 0;
  // Explicit choices (selection, @file, @symbol: priority <= 1) may use the whole remaining budget; any
  // other single file is capped so one big file cannot crowd out the others (it gets an excerpt or outline).
  const perFileCap = Math.max(200, Math.floor(opts.budgetTokens * PER_FILE_SHARE));
  for (const c of ordered) {
    const content = await opts.read(c.path);
    if (content === undefined) continue;
    const safe = redact(content);
    const block = `### ${c.path} (${c.reason})\n\`\`\`\n${safe}\n\`\`\`\n`;
    const tokens = estimateTokens(block);
    const cap = c.priority <= 1 ? Infinity : perFileCap;
    if (!c.excerptOnly && tokens <= cap && used + tokens <= opts.budgetTokens) {
      used += tokens;
      items.push({ path: c.path, reason: c.reason, tokens, included: true });
      parts.push(block);
      continue;
    }
    if (c.excerpt) {
      const start = c.excerpt.start;
      const end = c.priority <= 1 ? c.excerpt.end : Math.min(c.excerpt.end, start + MAX_KEYWORD_EXCERPT_LINES - 1);
      const lines = safe.split('\n').slice(start - 1, end).join('\n');
      const reason = c.excerptOnly ? c.reason : `${c.reason}; excerpt lines ${start}-${end} (whole file ~${tokens} tokens is over budget)`;
      const ex = `### ${c.path} lines ${start}-${end} (${reason})\n\`\`\`\n${lines}\n\`\`\`\n`;
      const exTokens = estimateTokens(ex);
      if (exTokens <= cap && used + exTokens <= opts.budgetTokens) {
        used += exTokens;
        items.push({ path: c.path, reason, tokens: exTokens, included: true });
        parts.push(ex);
        continue;
      }
    }
    // Last resort within the budget: an outline (classes and functions with line numbers), so the agent
    // knows where to page with read_file(startLine) instead of not knowing the file at all.
    const outline = outlineOf(index, c.path) ?? docOutline(safe);
    if (outline) {
      const reason = `${c.reason}; outline only (whole file ~${tokens} tokens is over budget)`;
      const ob = `### ${c.path} outline (${reason})\n${outline}\n`;
      const obTokens = estimateTokens(ob);
      if (used + obTokens <= opts.budgetTokens) {
        used += obTokens;
        items.push({ path: c.path, reason, tokens: obTokens, included: true });
        parts.push(ob);
        continue;
      }
    }
    items.push({ path: c.path, reason: `${c.reason}; left out: over budget`, tokens, included: false });
  }
  const header = parts.length
    ? 'Context selected by CodeCraft (a read-only snapshot taken before this request; call read_file before proposing changes to any file):\n\n'
    : '';
  return {
    report: { budgetTokens: opts.budgetTokens, usedTokens: used, totalFiles: index.stats.totalFiles, items, unresolved },
    contextText: header + parts.join('\n'),
  };
}

/** The prompt actually sent: selected context (if any) followed by the user's request. */
export function composePrompt(contextText: string, request: string): string {
  return contextText ? `${contextText}\nRequest:\n${request}` : request;
}
