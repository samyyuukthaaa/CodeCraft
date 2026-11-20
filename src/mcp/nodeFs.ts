// Read-only workspace access via node:fs, confined to a root (symlinks that escape are refused).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReadFs } from './gate';
import { isDenied, normalizeRelPath } from './paths';

const MAX_FILES = 5000;

export class NodeReadFs implements ReadFs {
  private rootReal: string | undefined;

  constructor(private readonly root: string) {}

  private async realRoot(): Promise<string> {
    this.rootReal ??= await fs.realpath(this.root);
    return this.rootReal;
  }

  /** Resolves a relative path inside the root, or throws. */
  async resolve(relPath: string): Promise<string> {
    const rel = normalizeRelPath(relPath);
    const root = await this.realRoot();
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes the workspace');
    return abs;
  }

  async read(relPath: string): Promise<string | undefined> {
    const abs = await this.resolve(relPath);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      return undefined;
    }
    const root = await this.realRoot();
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('path escapes the workspace');
    try {
      return await fs.readFile(real, 'utf8');
    } catch {
      return undefined;
    }
  }

  async list(): Promise<string[]> {
    const root = await this.realRoot();
    const out: string[] = [];
    const walk = async (dirRel: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      const entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true });
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (isDenied(rel) || isDenied(`${rel}/`)) continue;
        if (e.isDirectory()) await walk(rel);
        else if (e.isFile()) out.push(rel);
        if (out.length >= MAX_FILES) return;
      }
    };
    await walk('');
    return out.sort();
  }
}
