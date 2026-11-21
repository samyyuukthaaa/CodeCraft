// Content-addressed copies of file contents (by sha256) in VS Code workspace storage, never in the repository.
// Used to restore files when rolling back to a checkpoint (P5). Contents are kept exactly (a restore must be
// byte-identical), so this directory is local machine data like VS Code's own local history.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContentStore } from '../mcp/gate';

export class FileContentStore implements ContentStore {
  constructor(private readonly dir: string) {}

  private file(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid content hash');
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  async put(hash: string, content: string): Promise<void> {
    if (createHash('sha256').update(content).digest('hex') !== hash) throw new Error('content does not match its hash');
    const f = this.file(hash);
    try {
      await fs.access(f);
      return; // already stored
    } catch {
      // not stored yet
    }
    await fs.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, f);
  }

  async get(hash: string): Promise<string | undefined> {
    try {
      const text = await fs.readFile(this.file(hash), 'utf8');
      return createHash('sha256').update(text).digest('hex') === hash ? text : undefined;
    } catch {
      return undefined;
    }
  }
}
