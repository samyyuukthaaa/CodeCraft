// Keeps one index per workspace: loads the persisted copy, rebuilds incrementally on demand (unchanged
// files are reused by size + mtime), and persists after each build. Builds are serialized.
import { BuildResult, buildIndex, loadIndex, saveIndex } from './build';
import type { RepoIndex } from './types';

export class IndexService {
  private last: BuildResult | undefined;
  private loaded = false;
  private running: Promise<RepoIndex> | undefined;

  constructor(
    private readonly root: string,
    /** Where the index is persisted (outside the workspace, e.g. VS Code workspace storage). */
    private readonly storeFile: string | undefined,
  ) {}

  /** Returns a fresh index (incremental rebuild). Concurrent callers share one build. */
  get(): Promise<RepoIndex> {
    this.running ??= this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The last built index without rebuilding, if any. */
  peek(): RepoIndex | undefined {
    return this.last?.index;
  }

  private async refresh(): Promise<RepoIndex> {
    if (!this.loaded && this.storeFile) {
      this.last = await loadIndex(this.storeFile);
      this.loaded = true;
    }
    this.last = await buildIndex(this.root, this.last);
    if (this.storeFile) await saveIndex(this.storeFile, this.last);
    return this.last.index;
  }
}
