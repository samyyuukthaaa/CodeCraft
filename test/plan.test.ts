// Plan-before-propose (P3 step 1): the agent must submit a plan listing the files it chose and why before
// any proposal, and may only propose files the plan lists as edit or create.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteGate } from '../src/mcp/gate';
import { Plan, PlanStore, createHandlers } from '../src/mcp/tools';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, tempWorkspace } from './helpers';

const FILES = { 'src/cli.py': 'def run():\n    pass\n', 'tests/test_cli.py': 'def test_run():\n    pass\n', 'docs/cli.rst': 'CLI\n===\n' };

async function setup() {
  const ws = await tempWorkspace(FILES);
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer(acceptAll);
  const plan = new PlanStore();
  const seen: Plan[] = [];
  const h = createHandlers({ fs: ws.fs, gate: new WriteGate(ws.fs, applier, reviewer), tests: { run: async () => ({ ran: false, output: '' }) }, plan, onPlan: (p) => seen.push(p) });
  for (const p of Object.keys(FILES)) await h.read_file({ path: p });
  return { ws, applier, reviewer, plan, seen, h };
}

const CHANGE = { plan: 'add config command', groups: [{ intent: 'implement', files: [{ path: 'src/cli.py', edits: [{ find: 'pass', replace: 'print("x")' }] }] }] };

test('plan: proposing without a plan is refused and nothing reaches the reviewer', async () => {
  const { ws, applier, reviewer, h } = await setup();
  try {
    const r = await h.propose_changes(CHANGE);
    assert.equal(r.isError, true);
    assert.match(r.text, /call submit_plan first/);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(applier.calls.length, 0);
    assert.match((await h.propose_write({ path: 'src/cli.py', newContent: 'x\n', reason: 'r' })).text, /call submit_plan first/);
  } finally {
    await ws.cleanup();
  }
});

test('plan: submitted plan is reported (files, actions, reasons) and allows proposing the listed files', async () => {
  const { ws, seen, h } = await setup();
  try {
    const r = await h.submit_plan({
      summary: 'Add a config command next to the existing commands, test it and document it.',
      files: [
        { path: 'src/cli.py', action: 'edit', why: 'built-in commands live here' },
        { path: 'tests/test_cli.py', action: 'edit', why: 'CLI tests' },
        { path: 'docs/cli.rst', action: 'context', why: 'how commands are documented' },
        { path: 'docs/new.rst', action: 'create', why: 'new page' },
      ],
    });
    assert.equal(r.isError, false);
    assert.deepEqual(seen[0]?.files.map((f) => `${f.action}:${f.path}`), ['edit:src/cli.py', 'edit:tests/test_cli.py', 'context:docs/cli.rst', 'create:docs/new.rst']);
    const ok = JSON.parse((await h.propose_changes(CHANGE)).text);
    assert.equal(ok.status, 'applied');
    assert.match(await readDisk(ws.root, 'src/cli.py'), /print\("x"\)/);
  } finally {
    await ws.cleanup();
  }
});

test('plan: files outside the plan (or listed only as context) are refused; resubmitting extends it', async () => {
  const { ws, h } = await setup();
  try {
    await h.submit_plan({ summary: 's', files: [{ path: 'src/cli.py', action: 'edit', why: 'code' }, { path: 'docs/cli.rst', action: 'context', why: 'docs style' }] });
    const docs = { plan: 'p', groups: [{ intent: 'docs', files: [{ path: 'docs/cli.rst', edits: [{ find: 'CLI', replace: 'CLI tools' }] }] }] };
    const r = await h.propose_changes(docs);
    assert.match(r.text, /not in your plan as edit\/create: docs\/cli\.rst/);
    await h.submit_plan({ summary: 's', files: [{ path: 'src/cli.py', action: 'edit', why: 'code' }, { path: 'docs/cli.rst', action: 'edit', why: 'document it' }] });
    assert.equal(JSON.parse((await h.propose_changes(docs)).text).status, 'applied');
  } finally {
    await ws.cleanup();
  }
});

test('plan: actions are checked against the workspace and paths are validated', async () => {
  const { ws, plan, h } = await setup();
  try {
    assert.match((await h.submit_plan({ summary: 's', files: [{ path: 'src/missing.py', action: 'edit', why: 'x y z' }] })).text, /does not exist/);
    assert.match((await h.submit_plan({ summary: 's', files: [{ path: 'src/cli.py', action: 'create', why: 'x y z' }] })).text, /already exists/);
    assert.equal((await h.submit_plan({ summary: 's', files: [{ path: '../x.py', action: 'edit', why: 'x y z' }] })).isError, true);
    assert.equal(plan.get(), undefined, 'a rejected plan is not stored');
    plan.reset();
    assert.match((await h.propose_changes(CHANGE)).text, /submit_plan first/);
  } finally {
    await ws.cleanup();
  }
});
