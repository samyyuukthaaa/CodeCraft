// Task C (docs/TASKS.md): TrueForge configured with an invalid key, then repeat Task A.
// Two variants, both required by the project owner:
//   task3-fallback   : the second configured model (codecraft-fallback) takes over automatically.
//   task3-nofallback : no fallback, the user gets a clear message.
// In both, git status must be clean and the editor (here: the extension-host event loop) responsive.
// The invalid key lives only in a TEST-ONLY provider/agent (see testProvider.ts); real providers are untouched.
import { classifyError } from '../../src/trueforge/errors';
import { FALLBACK_AGENT_NAME } from '../../src/trueforge/config';
import { Check, Scenario } from './harness';
import { task1 } from './task1';
import { DUMMY_KEY, TEST_AGENT_NAME, TEST_MODEL_REF, ensureTestAgent, ensureTestProvider } from './testProvider';

const MAX_LAG_MS = 250;

function common(run: Parameters<Scenario['verify']>[0]): Check[] {
  const everything = JSON.stringify(run);
  return [
    { name: 'TASKS.md: git status shows no files changed', pass: run.changed.length === 0, detail: run.changed.join(', ') || 'clean' },
    { name: `TASKS.md: editor stays responsive (max event-loop lag < ${MAX_LAG_MS} ms)`, pass: run.maxEventLoopLagMs < MAX_LAG_MS, detail: `${run.maxEventLoopLagMs} ms` },
    { name: 'the dummy key never appears in any message, banner, log or result', pass: !everything.includes(DUMMY_KEY), detail: everything.includes(DUMMY_KEY) ? 'LEAKED' : 'not present' },
  ];
}

export const task3Fallback: Scenario = {
  id: 'task3-fallback',
  title: 'Task C (fallback configured): invalid primary key, second model takes over automatically',
  prompt: task1.prompt,
  selection: task1.selection,
  // The scripted user rejects the fallback's proposal so that, as Task C requires, no file changes.
  review: 'reject',
  async agents({ client, cfg, real }) {
    await ensureTestProvider(client);
    await ensureTestAgent(client);
    return [real(TEST_AGENT_NAME, TEST_MODEL_REF), real(FALLBACK_AGENT_NAME, cfg.fallbackModel)];
  },
  async verify(run) {
    const sw = run.switches[0];
    const snap = run.atSwitch[0];
    const banner = run.banners[0] ?? '';
    const checks: Check[] = [
      { name: 'exactly one automatic switch, from the invalid-key agent to codecraft-fallback', pass: run.switches.length === 1 && sw?.from === TEST_AGENT_NAME && sw?.to === FALLBACK_AGENT_NAME, detail: run.switches.map((s) => `${s.from} -> ${s.to}`).join(', ') || 'no switch' },
      { name: 'the switch was caused by the rejected key (HTTP 401)', pass: !!sw && classifyError(sw.reason).cls === 'invalid_or_revoked_key' && classifyError(sw.reason).status === 401, detail: sw?.reason.slice(0, 200) ?? '-' },
      { name: 'no user action before the takeover (0 approvals, 0 reviews) and nothing written at that moment', pass: !!snap && snap.approvalsBefore === 0 && snap.reviewsBefore === 0 && snap.changed.length === 0, detail: snap ? `approvals ${snap.approvalsBefore}, reviews ${snap.reviewsBefore}, changed ${snap.changed.join(', ') || 'none'}` : 'no snapshot' },
      { name: 'banner says in plain words that the primary key was rejected and the fallback took over', pass: banner.startsWith('Provider key rejected: update it in TrueForge Settings.') && banner.includes('(HTTP 401)') && banner.includes('google-gemini/gemini-3-5-flash-lite') && /switched to the fallback model .* automatically/.test(banner), detail: banner || 'no banner' },
      { name: 'TASKS.md: the second configured model took over (run finished on codecraft-fallback)', pass: run.outcome.status === 'done' && run.finalAgent === FALLBACK_AGENT_NAME, detail: `${run.outcome.status} on ${run.finalAgent}` },
      { name: 'the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user)', pass: run.review.some((r) => r.groups.some((g) => g.includes('src/flask/helpers.py'))), detail: run.review.map((r) => r.groups.join(' | ')).join(' || ') || 'no proposal' },
      ...common(run),
    ];
    return checks;
  },
};

export const task3NoFallback: Scenario = {
  id: 'task3-nofallback',
  title: 'Task C (no fallback): invalid key, clear message, nothing changed',
  prompt: task1.prompt,
  selection: task1.selection,
  review: 'reject',
  async agents({ client, real }) {
    await ensureTestProvider(client);
    await ensureTestAgent(client);
    return [real(TEST_AGENT_NAME, TEST_MODEL_REF)];
  },
  async verify(run) {
    const msg = run.failureMessage ?? '';
    return [
      { name: 'the run fails (no fallback configured) without asking the user anything', pass: run.outcome.status === 'error' && run.switches.length === 0 && run.approvals.length === 0 && run.review.length === 0, detail: `${run.outcome.status}, switches ${run.switches.length}, approvals ${run.approvals.length}, reviews ${run.review.length}` },
      { name: 'TASKS.md: the user sees a clear message (key rejected, where to fix it, nothing changed)', pass: msg === `Provider key rejected (HTTP 401) for ${TEST_MODEL_REF}: update it in TrueForge Settings. Nothing was changed in your files.`, detail: msg || 'no message' },
      ...common(run),
    ];
  },
};
