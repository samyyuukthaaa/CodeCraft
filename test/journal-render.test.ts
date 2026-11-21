import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, MemorySink } from '../src/journal/journal';
import { renderJournal } from '../src/journal/render';

test('edit journal view: runs newest first, applied/undone ops with IDs, interrupted ops flagged, secrets stay redacted', async () => {
  let t = Date.UTC(2026, 10, 21, 9, 0, 0);
  const j = new Journal(new MemorySink(), () => (t += 1000));
  j.runId = 'run-a';
  await j.append({ t: 'run_started', request: 'Treat off and n as false' });
  await j.append({ t: 'plan', summary: 'edit helpers', files: [{ path: 'src/flask/helpers.py', action: 'edit' }] });
  await j.append({ t: 'op_started', opId: 'aaaa', files: [{ path: 'src/flask/helpers.py', intent: 'implement' }] });
  await j.append({ t: 'op_applied', opId: 'aaaa', files: [{ path: 'src/flask/helpers.py', intent: 'implement', before: 'h1', after: 'h2', accepted: 2, rejected: 1 }] });
  await j.append({ t: 'tests', passed: true, exitCode: 0 });
  await j.append({ t: 'op_undone', opId: 'aaaa', files: ['src/flask/helpers.py'] });
  await j.append({ t: 'run_finished', status: 'done' });
  j.runId = 'run-b';
  await j.append({ t: 'run_started', request: `with key ${'AIza' + 'Q'.repeat(35)}` });
  await j.append({ t: 'provider_error', model: 'p/m', cls: 'invalid_or_revoked_key' });
  await j.append({ t: 'model_switched', from: 'p/m', to: 'q/m', reason: 'invalid_or_revoked_key' });
  await j.append({ t: 'op_started', opId: 'bbbb', files: [{ path: 'a.py', intent: 'edit' }] });

  const md = renderJournal(j.all());
  assert.ok(md.indexOf('## Run run-b') < md.indexOf('## Run run-a'), 'newest run first');
  assert.match(md, /\*\*applied\*\* operation `aaaa`: src\/flask\/helpers\.py \[implement\] 2 hunk\(s\) accepted, 1 rejected/);
  assert.match(md, /\*\*undone\*\* operation `aaaa`/);
  assert.match(md, /tests passed/);
  assert.match(md, /switched model: p\/m -> q\/m \(invalid or revoked key\)/);
  assert.match(md, /\*\*interrupted\*\* operation `bbbb` \(started, not confirmed applied\): a\.py/);
  assert.ok(!md.includes('Q'.repeat(35)), 'the key was redacted when written and stays out of the view');
  assert.match(md, /^# CodeCraft edit journal\n\n11 entries, 2 run\(s\)/);
});
