// Pure text helpers for the editor tools: line endings, paged reads and find/replace edits.
//
// Why: TrueForge replaces any tool response over 24,000 characters with a "Content too big" notice
// (observed live: src/flask/helpers.py at 3.1.3 is 25,640 characters as JSON, the agent never saw it and
// re-read it 34 times). Reads are therefore paged, and edits can be sent as small find/replace pairs.
export type Eol = '\r\n' | '\n';

/** TrueForge's observed per-tool-response limit, and the budget CodeCraft keeps under it. */
export const TRUEFORGE_RESPONSE_LIMIT = 24_000;
export const RESPONSE_BUDGET = 20_000;
const MAX_PAGE_LINES = 400;

export function eolOf(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf * 2 >= lf ? '\r\n' : '\n';
}

export const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
export const toEol = (text: string, eol: Eol): string => (eol === '\n' ? toLf(text) : toLf(text).replace(/\n/g, '\r\n'));

/** New content written in the file's existing line-ending style (new files keep what was sent). */
export function matchEol(current: string | undefined, newContent: string): string {
  return current === undefined ? newContent : toEol(newContent, eolOf(current));
}

export interface Page {
  startLine: number;
  endLine: number;
  totalLines: number;
  lineEndings: 'crlf' | 'lf';
  /** Present when more lines follow. */
  nextStartLine?: number;
  content: string;
}

/**
 * A page of a file (1-based inclusive lines, content shown with \n line endings). Shrinks the page until
 * its JSON encoding fits the response budget, so TrueForge never truncates it.
 */
export function pageOf(text: string, startLine = 1, endLine?: number): Page {
  const lines = toLf(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline is not a line
  const total = lines.length;
  const start = Math.min(Math.max(1, Math.floor(startLine)), Math.max(1, total));
  let end = Math.min(total, endLine !== undefined ? Math.max(start, Math.floor(endLine)) : start + MAX_PAGE_LINES - 1, start + MAX_PAGE_LINES - 1);
  const eol = eolOf(text) === '\r\n' ? 'crlf' : 'lf';
  for (;;) {
    const content = lines.slice(start - 1, end).join('\n');
    const page: Page = { startLine: start, endLine: end, totalLines: total, lineEndings: eol, ...(end < total ? { nextStartLine: end + 1 } : {}), content };
    if (JSON.stringify(page).length <= RESPONSE_BUDGET - 200 || end === start) return page;
    end = start + Math.max(0, Math.floor((end - start) / 2));
  }
}

export interface Edit {
  find: string;
  replace: string;
}

/** Applies find/replace edits; each `find` must occur exactly once (compared with \n line endings). */
export function applyEdits(current: string, edits: Edit[]): { ok: true; text: string } | { ok: false; error: string } {
  const eol = eolOf(current);
  let work = toLf(current);
  for (const [i, e] of edits.entries()) {
    const find = toLf(e.find);
    if (!find) return { ok: false, error: `edit ${i + 1}: "find" is empty` };
    const first = work.indexOf(find);
    if (first < 0) return { ok: false, error: `edit ${i + 1}: "find" text not found (it must match the current file exactly, including indentation): ${JSON.stringify(find.slice(0, 80))}` };
    if (work.indexOf(find, first + 1) >= 0) return { ok: false, error: `edit ${i + 1}: "find" text occurs more than once; include more surrounding lines so it is unique` };
    work = work.slice(0, first) + toLf(e.replace) + work.slice(first + find.length);
  }
  return { ok: true, text: toEol(work, eol) };
}
