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

const STOP = new Set(['this', 'that', 'with', 'from', 'into', 'file', 'files', 'make', 'have', 'should', 'when', 'what', 'where', 'which', 'there', 'their', 'then', 'than', 'them', 'they', 'will', 'would', 'could', 'please', 'change', 'update', 'test', 'tests', 'code', 'function', 'class', 'method', 'return', 'returns', 'value', 'add', 'fix', 'the', 'and', 'for', 'use', 'using']);

function keywords(text: string): string[] {
  const words = text.replace(REF, ' ').match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))].slice(0, 20);
}

interface Candidate {
  path: string;
  priority: number;
  reason: string;
  /** 1-based inclusive line range to use as an excerpt when the whole file does not fit. */
  excerpt?: { start: number; end: number };
}

const MAX_EXCERPT_LINES = 200;

/** Lines of a definition: from its line to just before the next symbol with the same parent (capped). */
function symbolRange(index: RepoIndex, path: string, line: number, parent: string | undefined): { start: number; end: number } {
  const f = index.files[path];
  const next = f?.symbols.filter((s) => s.line > line && s.parent === parent).sort((a, b) => a.line - b.line)[0];
  const end = Math.min(next ? next.line - 1 : line + MAX_EXCERPT_LINES - 1, line + MAX_EXCERPT_LINES - 1, f?.lines ?? line);
  return { start: line, end: Math.max(line, end) };
}

export interface SelectOptions {
  index: RepoIndex;
  text: string;
  budgetTokens: number;
  read: (path: string) => Promise<string | undefined>;
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

  // 1-2: explicit references
  const anchors: string[] = [];
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
    const exact = searchSymbols(index, kw, { limit: 10 }).filter((h) => h.name.toLowerCase() === kw);
    for (const h of exact.slice(0, 2)) {
      if (!cands.has(h.path)) kwAdded++;
      add(h.path, 2, `defines "${h.name}" mentioned in the request`, symbolRange(index, h.path, h.line, h.parent));
    }
    for (const f of Object.values(index.files)) {
      const stem = (f.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
      if (stem === kw && !cands.has(f.path)) {
        add(f.path, 2, `file name matches "${kw}"`);
        kwAdded++;
      }
    }
    if (!anchors.length) for (const c of cands.values()) if (c.priority === 2) anchors.push(c.path);
  }

  // 4: neighbours of the anchors
  for (const a of [...new Set(anchors)].slice(0, 4)) {
    const rel = listRelated(index, a);
    if (!rel) continue;
    for (const t of rel.tests.slice(0, 2)) add(t, 3, `test for ${a}`);
    for (const i of rel.imports.slice(0, 3)) add(i, 4, `imported by ${a}`);
  }

  // Greedy fill in priority order.
  const ordered = [...cands.values()].sort((x, y) => x.priority - y.priority || x.path.localeCompare(y.path));
  const items: ContextItem[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const c of ordered) {
    const content = await opts.read(c.path);
    if (content === undefined) continue;
    const safe = redact(content);
    const block = `### ${c.path} (${c.reason})\n\`\`\`\n${safe}\n\`\`\`\n`;
    const tokens = estimateTokens(block);
    if (used + tokens <= opts.budgetTokens) {
      used += tokens;
      items.push({ path: c.path, reason: c.reason, tokens, included: true });
      parts.push(block);
      continue;
    }
    if (c.excerpt) {
      const { start, end } = c.excerpt;
      const lines = safe.split('\n').slice(start - 1, end).join('\n');
      const reason = `${c.reason}; excerpt lines ${start}-${end} (whole file ~${tokens} tokens is over budget)`;
      const ex = `### ${c.path} lines ${start}-${end} (${reason})\n\`\`\`\n${lines}\n\`\`\`\n`;
      const exTokens = estimateTokens(ex);
      if (used + exTokens <= opts.budgetTokens) {
        used += exTokens;
        items.push({ path: c.path, reason, tokens: exTokens, included: true });
        parts.push(ex);
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
