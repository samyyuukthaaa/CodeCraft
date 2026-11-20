import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Applier, Decision, ReviewRequest, Reviewer, hunkKey } from '../src/mcp/gate';
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
  /** One entry per applyAll call (= one undo step). */
  readonly calls: Array<Array<{ path: string; text: string | undefined }>> = [];
  constructor(private readonly root: string) {}
  /** Flattened list of written files (deletions excluded), for older single-file assertions. */
  get writes(): Array<{ path: string; text: string }> {
    return this.calls.flat().filter((c): c is { path: string; text: string } => c.text !== undefined);
  }
  get removed(): string[] {
    return this.calls.flat().filter((c) => c.text === undefined).map((c) => c.path);
  }
  async applyAll(changes: Array<{ path: string; text: string | undefined }>): Promise<void> {
    this.calls.push(changes.map((c) => ({ ...c })));
    for (const c of changes) {
      const abs = path.join(this.root, c.path);
      if (c.text === undefined) {
        await fs.rm(abs, { force: true });
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, c.text, 'utf8');
      }
    }
  }
}

/** Reviewer whose answer is scripted by the test. */
export class ScriptedReviewer implements Reviewer {
  readonly requests: ReviewRequest[] = [];
  constructor(private readonly answer: (req: ReviewRequest) => Record<string, Decision>) {}
  async review(req: ReviewRequest): Promise<Record<string, Decision>> {
    this.requests.push(req);
    return this.answer(req);
  }
}

const every = (req: ReviewRequest, d: Decision): Record<string, Decision> =>
  Object.fromEntries(req.groups.flatMap((g) => g.files.flatMap((f) => f.hunks.map((h) => [hunkKey(f.path, h.id), d]))));
export const acceptAll = (req: ReviewRequest): Record<string, Decision> => every(req, 'accept');
export const rejectAll = (req: ReviewRequest): Record<string, Decision> => every(req, 'reject');

/** Decide whole groups by intent: groups not listed are rejected. */
export const byGroup =
  (accepted: string[]) =>
  (req: ReviewRequest): Record<string, Decision> =>
    Object.fromEntries(req.groups.flatMap((g) => g.files.flatMap((f) => f.hunks.map((h) => [hunkKey(f.path, h.id), accepted.includes(g.intent) ? 'accept' : 'reject'] as const))));

/** The hunks of the first file in the first group, for single-file tests. */
export const firstHunks = (req: ReviewRequest) => {
  const f = req.groups[0]!.files[0]!;
  return { path: f.path, hunks: f.hunks };
};

export async function readDisk(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}
