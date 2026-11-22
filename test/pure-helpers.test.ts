// Small pure helpers that had no direct tests: warningText, unescapeOnce, capacityFor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warningText } from '../src/trust/annotate';
import { unescapeOnce } from '../src/mcp/text';
import { capacityFor } from '../src/town/layout';

test('warningText: lists planned files and tests, with plain fallbacks when empty', () => {
  assert.equal(
    warningText({ files: ['a.py', 'b.py'], tests: ['test_a.py'] }),
    'Before any edit: this run plans to change a.py, b.py. Tests that might break: test_a.py.',
  );
  assert.equal(
    warningText({ files: [], tests: [] }),
    'Before any edit: this run plans to change no files. Tests that might break: none found by the index.',
  );
});

test('unescapeOnce: turns literal backslash sequences into real characters, once only', () => {
  assert.equal(unescapeOnce('a\\nb'), 'a\nb');
  assert.equal(unescapeOnce('x\\ty\\rz'), 'x\ty\rz');
  assert.equal(unescapeOnce('say \\"hi\\" and \\\'ok\\\''), 'say "hi" and \'ok\'');
  // A doubled backslash becomes one backslash and is not decoded a second time.
  assert.equal(unescapeOnce('\\\\n'), '\\n');
  // Unknown escapes, a trailing backslash, plain text and the empty string stay as they are.
  assert.equal(unescapeOnce('\\d'), '\\d');
  assert.equal(unescapeOnce('end\\'), 'end\\');
  assert.equal(unescapeOnce('plain'), 'plain');
  assert.equal(unescapeOnce(''), '');
});

test('capacityFor: at least 4 slots, about 25% spare room plus 2, never below the file count', () => {
  assert.equal(capacityFor(0), 4);
  assert.equal(capacityFor(1), 4);
  assert.equal(capacityFor(2), 5);
  assert.equal(capacityFor(10), 15);
  assert.equal(capacityFor(100), 127);
  for (let n = 0; n <= 200; n++) assert.ok(capacityFor(n) >= Math.max(4, n));
});