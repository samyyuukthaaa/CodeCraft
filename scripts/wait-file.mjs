// Helpers for scripts that drive headless Edge/Chrome. On Windows the launched browser hands the work to another
// process and exits before the output file is written, so a script must wait for the file, not for the process.
import { existsSync, statSync } from 'node:fs';

/**
 * Resolves with the file size once `path` exists, is non-empty and its size is unchanged between two checks
 * `intervalMs` apart; rejects after `timeoutMs`.
 */
export async function waitForStableFile(path, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const size = existsSync(path) ? statSync(path).size : -1;
    if (size > 0 && size === last) return size;
    last = size;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${path} was not written within ${Math.round(timeoutMs / 1000)} s`);
}

/** Number of pages in a PDF (page objects; "/Type /Pages" tree nodes are not counted). */
export function countPdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
