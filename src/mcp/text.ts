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

/**
 * Decodes one level of backslash escaping (\n, \t, \r, \\, \", \'). Used ONLY as a fallback for text that
 * a model over-escaped: observed live, gemini-3-1-flash-lite sent find strings containing the two characters
 * backslash and n instead of newlines in 30 consecutive proposals, so every edit was "not found".
 */
export function unescapeOnce(s: string): string {
  return s.replace(/\\([ntr\\"'])/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" })[c] as string);
}

/** File types whose proposed text is decoded when a model over-escaped it (code, docs, config). */
export const DECODE_EXT = /\.(py|pyi|rst|md|txt|cfg|ini|toml|ya?ml|json)$/i;

/**
 * Replacement or new-file text that a model over-escaped: no real newline at all, but at least two literal
 * backslash-n sequences (a single one may be an intentional "\n" inside a string). Observed live (task2 on c7c390b,
 * gemini-3-5-flash-lite): every replacement came as one line with literal \n, so tests/test_cli.py got a
 * SyntaxError. Decoded once, only for code, docs and config files.
 */
export function decodeOverEscaped(path: string, text: string): string {
  if (!DECODE_EXT.test(path) || text.includes('\n') || (text.match(/\\n/g) ?? []).length < 2) return text;
  return unescapeOnce(text);
}

const count = (hay: string, needle: string): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/** Applies find/replace edits; each `find` must occur exactly once (compared with \n line endings). */
export function applyEdits(current: string, edits: Edit[], path?: string): { ok: true; text: string } | { ok: false; error: string } {
  const eol = eolOf(current);
  let work = toLf(current);
  for (const [i, e] of edits.entries()) {
    let find = toLf(e.find);
    let replace = toLf(e.replace);
    if (!find) return { ok: false, error: `edit ${i + 1}: "find" is empty` };
    // Exact text first. Only if it is not found AND it has no real newline, try it as over-escaped text; the
    // decoded form must then match exactly once. The replacement is decoded too only if it also has no real
    // newline (so intentional escapes such as "a\nb" inside a code string stay as written).
    if (count(work, find) === 0 && !find.includes('\n') && /\\[ntr\\"']/.test(find)) {
      const decoded = unescapeOnce(find);
      if (count(work, decoded) === 1) {
        find = decoded;
        if (!replace.includes('\n')) replace = unescapeOnce(replace);
      }
    }
    // The find matched as written, but the replacement may still be over-escaped (see decodeOverEscaped).
    if (path) replace = decodeOverEscaped(path, replace);
    const n = count(work, find);
    if (n === 0) return { ok: false, error: `edit ${i + 1}: "find" text not found (it must match the current file exactly, including indentation, with real newlines): ${JSON.stringify(find.slice(0, 80))}` };
    if (n > 1) return { ok: false, error: `edit ${i + 1}: "find" text occurs more than once; include more surrounding lines so it is unique` };
    const first = work.indexOf(find);
    work = work.slice(0, first) + replace + work.slice(first + find.length);
  }
  return { ok: true, text: toEol(work, eol) };
}
