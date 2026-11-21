// The write-up PDF script waits for the browser to finish writing the file, then counts pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countPdfPages, waitForStableFile } from '../scripts/wait-file.mjs';

test('waitForStableFile: waits for a file that appears late and keeps growing, then returns its final size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codecraft-wait-'));
  const f = path.join(dir, 'out.pdf');
  try {
    // like Edge: the file appears after the launcher has returned, and is written in parts
    setTimeout(() => fs.writeFileSync(f, 'a'.repeat(100)), 300);
    setTimeout(() => fs.appendFileSync(f, 'b'.repeat(100)), 500);
    const size = await waitForStableFile(f, 10_000, 250);
    assert.equal(size, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForStableFile: fails clearly when nothing is written in time; an empty file never counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codecraft-wait-'));
  try {
    await assert.rejects(waitForStableFile(path.join(dir, 'never.pdf'), 400, 50), /never\.pdf was not written within 0 s/);
    const empty = path.join(dir, 'empty.pdf');
    fs.writeFileSync(empty, '');
    await assert.rejects(waitForStableFile(empty, 400, 50), /not written/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countPdfPages: counts page objects, not the page tree; the real write-up fits in 3 pages', () => {
  const fake = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page /Parent 1 0 R >>\n3 0 obj <</Type/Page/Parent 1 0 R>>\n', 'latin1');
  assert.equal(countPdfPages(fake), 2);
  const real = path.join(__dirname, '..', '..', 'docs', 'WRITEUP.pdf');
  const pages = countPdfPages(fs.readFileSync(real));
  assert.ok(pages >= 1 && pages <= 3, `docs/WRITEUP.pdf has ${pages} pages`);
});
