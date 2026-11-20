// The scenarios must use the fixed task wording EXACTLY as docs/TASKS.md states it (never paraphrased).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { task1 } from './scenarios/task1';
import { task2 } from './scenarios/task2';
import { task3Fallback, task3NoFallback } from './scenarios/task3';

const TASKS = fs.readFileSync('docs/TASKS.md', 'utf8').replace(/\r\n/g, '\n');

/** The text between the first `instruct: "` and the closing `."` (the quoted instruction) of a task section. */
function quotedInstruction(section: string): string {
  const start = section.indexOf('instruct: "');
  assert.ok(start >= 0, 'no instruction found');
  const body = section.slice(start + 'instruct: "'.length);
  const end = body.search(/"\s+(Review|Show)/);
  return body.slice(0, end);
}

const section = (name: string): string => {
  const s = TASKS.indexOf(`## ${name}`);
  const e = TASKS.indexOf('\n## ', s + 3);
  return TASKS.slice(s, e < 0 ? undefined : e);
};

test('task1 and task3 use Task A wording verbatim', () => {
  const a = quotedInstruction(section('Task A'));
  assert.equal(task1.prompt, a);
  assert.equal(task3Fallback.prompt, a);
  assert.equal(task3NoFallback.prompt, a);
});

test('task2 uses Task B wording verbatim', () => {
  assert.equal(task2.prompt, quotedInstruction(section('Task B')));
});
