import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Applier, Decision, ReviewRequest, Reviewer } from '../src/mcp/gate';
import { NodeReadFs } from '../src/mcp/nodeFs';

export async function tempWorkspace(files: Record<string, string>): Promise<{ root: string; fs: NodeReadFs; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codecraft-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return { root, fs: new NodeReadFs(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Test applier: writes straight to disk and records every call so tests can prove what was (not) written. */
export class DiskApplier implements Applier {
  readonly writes: Array<{ path: string; text: string }> = [];
  readonly removed: string[] = [];
  constructor(private readonly root: string) {}
  async apply(rel: string, text: string): Promise<void> {
    this.writes.push({ path: rel, text });
    const abs = path.join(this.root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  }
  async remove(rel: string): Promise<void> {
    this.removed.push(rel);
    await fs.rm(path.join(this.root, rel), { force: true });
  }
}

/** Reviewer whose answer is scripted by the test. */
export class ScriptedReviewer implements Reviewer {
  readonly requests: ReviewRequest[] = [];
  constructor(private readonly answer: (req: ReviewRequest) => Record<number, Decision>) {}
  async review(req: ReviewRequest): Promise<Record<number, Decision>> {
    this.requests.push(req);
    return this.answer(req);
  }
}

export const acceptAll = (req: ReviewRequest): Record<number, Decision> =>
  Object.fromEntries(req.hunks.map((h) => [h.id, 'accept' as const]));
export const rejectAll = (req: ReviewRequest): Record<number, Decision> =>
  Object.fromEntries(req.hunks.map((h) => [h.id, 'reject' as const]));

export async function readDisk(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}
