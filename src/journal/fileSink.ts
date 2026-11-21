// Append-only JSONL file sink for the journal (kept in VS Code workspace storage, never in the repository).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JournalSink } from './journal';

export class FileSink implements JournalSink {
  constructor(private readonly file: string) {}

  async append(line: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${line}\n`, 'utf8');
  }

  async readAll(): Promise<string[]> {
    try {
      return (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
