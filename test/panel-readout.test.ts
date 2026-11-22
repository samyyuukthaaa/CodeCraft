// Agent panel context readout: budget used vs limit, the read-budget counters, and the files the agent chose and why,
// all from data the panel already receives. Context selection is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../src/panel/html';
import { budgetMeter, chosenFiles } from '../src/panel/readout';

test('budget meter: used of the limit, percent, left-out files, and over-budget flagged', () => {
  const items = [
    { path: 'a.py', reason: 'x', tokens: 100, included: true },
    { path: 'b.py', reason: 'over budget', tokens: 9000, included: false },
  ];
  const m = budgetMeter({ usedTokens: 4512, budgetTokens: 6000, items });
  assert.deepEqual({ used: m.used, limit: m.limit, percent: m.percent, over: m.over }, { used: 4512, limit: 6000, percent: 75, over: false });
  assert.equal(m.text, 'Context budget: about 4,512 of 6,000 tokens (75%); 1 file(s) left out to stay within it');
  const over = budgetMeter({ usedTokens: 7000, budgetTokens: 6000, items: [] });
  assert.equal(over.percent, 100);
  assert.equal(over.over, true);
  assert.equal(budgetMeter({ usedTokens: 0, budgetTokens: 0, items: [] }).percent, 0, 'zero budget');
});

test('files the agent chose: plan files first with action and why, marked when read; other reads after', () => {
  const plan = { files: [
    { path: 'src/flask/cli.py', action: 'edit' as const, why: 'add the command' },
    { path: 'docs/cli.rst', action: 'edit' as const, why: 'document it' },
    { path: 'tests/test_cli.py', action: 'edit' as const, why: 'test it' },
  ] };
  const rows = chosenFiles(plan, ['src/flask/cli.py', 'src/flask/app.py']);
  assert.deepEqual(rows, [
    { path: 'src/flask/cli.py', how: 'edit', why: 'add the command', read: true },
    { path: 'docs/cli.rst', how: 'edit', why: 'document it', read: false },
    { path: 'tests/test_cli.py', how: 'edit', why: 'test it', read: false },
    { path: 'src/flask/app.py', how: 'read', why: 'read by the agent (not in its plan)', read: true },
  ]);
  assert.deepEqual(chosenFiles(undefined, []), []);
  assert.equal(chosenFiles(undefined, ['x.py'])[0]!.how, 'read');
});

test('panel html: meter (ARIA), meter text, read-budget line, and the "Files the agent chose" table', () => {
  const html = buildHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<div id="ctx-meter" role="meter" aria-label="Context budget used" aria-valuemin="0"/);
  assert.match(html, /<p id="ctx-meter-text" class="muted"><\/p>/);
  assert.match(html, /<p id="read-budget" class="muted" role="status"><\/p>/);
  assert.match(html, /<h4 id="chosen-h">Files the agent chose<\/h4>/);
  assert.match(html, /<th>File<\/th><th>How<\/th><th>Why<\/th><th>Read<\/th>/);
});
