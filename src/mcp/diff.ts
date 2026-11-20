// Pure line diff. Hunks are non-overlapping changed regions expressed in OLD-file coordinates, so any
// subset of them can be applied independently.
export interface Hunk {
  id: number;
  /** Index into the old file's lines where this change starts. */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

const MAX_DP_CELLS = 25_000_000;

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];

  const ops: Array<'=' | '-' | '+'> = [];
  const aLines: string[] = [];
  const bLines: string[] = [];
  if (am.length * bm.length > MAX_DP_CELLS) {
    // Too large for LCS: treat the whole middle as one replacement.
    return [{ id: 0, oldStart: pre, oldLines: am, newLines: bm }];
  }
  // LCS table over the middle section.
  const n = am.length;
  const m = bm.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        am[i] === bm[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push('=');
      aLines.push(am[i] as string);
      bLines.push(bm[j] as string);
      i++;
      j++;
    } else if (j < m && (i === n || (dp[i * w + j + 1] as number) >= (dp[(i + 1) * w + j] as number))) {
      ops.push('+');
      bLines.push(bm[j] as string);
      j++;
    } else {
      ops.push('-');
      aLines.push(am[i] as string);
      i++;
    }
  }

  const hunks: Hunk[] = [];
  let oldPos = pre;
  let ai = 0;
  let bi = 0;
  let cur: Hunk | undefined;
  for (const op of ops) {
    if (op === '=') {
      cur = undefined;
      oldPos++;
      ai++;
      bi++;
      continue;
    }
    if (!cur) {
      cur = { id: hunks.length, oldStart: oldPos, oldLines: [], newLines: [] };
      hunks.push(cur);
    }
    if (op === '-') {
      cur.oldLines.push(aLines[ai++] as string);
      oldPos++;
    } else {
      cur.newLines.push(bLines[bi++] as string);
    }
  }
  return hunks;
}

/** Applies only the accepted hunks to oldText. Rejected hunks leave the old lines untouched. */
export function applyHunks(oldText: string, hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const a = splitLines(oldText);
  const out: string[] = [];
  let pos = 0;
  for (const h of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    while (pos < h.oldStart) out.push(a[pos++] as string);
    if (accepted.has(h.id)) {
      out.push(...h.newLines);
    } else {
      out.push(...h.oldLines);
    }
    pos = h.oldStart + h.oldLines.length;
  }
  while (pos < a.length) out.push(a[pos++] as string);
  return out.join('');
}
