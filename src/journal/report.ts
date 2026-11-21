// Pure: a run report from the journal (P5 "one-click report export"): what changed, why, what failed, how it
// recovered and which models were used. Everything comes from journal entries, which are redacted when written.
import type { JournalEntry } from './journal';

type Of<T extends JournalEntry['t']> = Extract<JournalEntry, { t: T }>;

const time = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 19);
const words = (s: string): string => s.replace(/_/g, ' ');

/** The most recent run in the journal (by its run_started entry). */
export function latestRunId(entries: readonly JournalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.t === 'run_started') return entries[i]!.runId;
  return undefined;
}

export function renderRunReport(all: readonly JournalEntry[], runId: string): string {
  const es = all.filter((e) => e.runId === runId);
  const of = <T extends JournalEntry['t']>(t: T): Array<Of<T>> => es.filter((e): e is Of<T> => e.t === t);
  const started = of('run_started')[0];
  const finished = of('run_finished').at(-1);
  const models = of('run_models')[0];
  const out: string[] = ['# CodeCraft run report', ''];
  out.push(`- Run: \`${runId}\``);
  if (started) out.push(`- Started: ${time(started.at)} UTC`, `- Request: "${started.request.replace(/\s+/g, ' ').slice(0, 300)}"`);
  out.push(`- Result: ${finished ? finished.status : 'not finished (interrupted or still running)'}`, '');

  // What changed
  out.push('## What changed', '');
  const undone = new Set(of('op_undone').map((e) => e.opId));
  const applied = of('op_applied');
  const groups = of('change_group');
  if (!applied.length) out.push('Nothing was written to your files in this run.');
  for (const op of applied) {
    out.push(`- Operation \`${op.opId}\`${undone.has(op.opId) ? ' (later undone or rolled back)' : ''}: ${op.files.map((f) => `${f.path} [${f.intent}] ${f.accepted} hunk(s) accepted${f.rejected ? `, ${f.rejected} rejected` : ''}`).join('; ')}`);
    for (const g of groups.filter((x) => x.opId === op.opId)) {
      out.push(`  - [${g.intent}] **${g.confidence}**: ${g.plain} Tests: ${g.tests}.${g.why.length ? ` Deciding rule: ${g.why.join('; ')}.` : ''}`);
    }
  }
  for (const r of of('op_rejected')) out.push(`- Rejected by you (nothing written): ${r.files.join(', ')}`);
  out.push('');

  // Why
  out.push('## Why', '');
  const plans = of('plan');
  const plan = plans.at(-1);
  if (plan) {
    out.push(`Plan: ${plan.summary}`, '');
    for (const f of plan.files) out.push(`- ${f.action} ${f.path}`);
  } else out.push('No plan was submitted in this run.');
  const reasons = groups.filter((g) => g.reason);
  if (reasons.length) {
    out.push('', 'Per change group:');
    for (const g of reasons) out.push(`- [${g.intent}] ${g.files.join(', ')}: ${g.reason}`);
  }
  const warn = of('warn_list')[0];
  if (warn) out.push('', `Warned before editing: will change ${warn.files.join(', ') || '(nothing)'}; tests that might break: ${warn.tests.join(', ') || '(none found)'}.`);
  const questions = of('question');
  if (questions.length) {
    out.push('', 'Questions the agent asked:');
    for (const q of questions) out.push(`- "${q.question}" Answer: "${q.answer}"`);
  }
  out.push('');

  // What failed
  out.push('## What failed', '');
  const failed: string[] = [];
  for (const e of of('provider_error')) failed.push(`- ${time(e.at)} provider error on ${e.model}: ${words(e.cls)}`);
  for (const e of of('tests')) if (!e.passed) failed.push(`- ${time(e.at)} tests${e.phase && e.phase !== 'agent' ? ` (${words(e.phase)})` : ''} failed (exit ${e.exitCode})${e.failing?.length ? `: ${e.failing.slice(0, 10).join(', ')}` : ''}`);
  for (const e of of('regression')) failed.push(`- ${time(e.at)} tests that passed before now fail: ${e.tests.join(', ')}`);
  for (const e of of('op_refused')) failed.push(`- ${time(e.at)} refused: ${e.reason}`);
  if (finished && finished.status !== 'done') failed.push(`- the run ended as "${finished.status}"`);
  out.push(...(failed.length ? failed : ['Nothing failed.']), '');

  // How it recovered
  out.push('## How it recovered', '');
  const rec: string[] = [];
  for (const e of of('model_switched')) rec.push(`- ${time(e.at)} switched from ${e.from} to ${e.to} (${words(e.reason)})`);
  for (const e of of('provider_recovered')) rec.push(`- ${time(e.at)} ${e.model} worked again`);
  for (const e of of('turn_position')) if (e.reason === 'cut') rec.push(`- ${time(e.at)} the stream was cut; the same turn was resumed after event ${e.lastEventId ?? '(start)'}`);
  for (const e of of('autofix')) rec.push(`- ${time(e.at)} automatic fix: ${words(e.status)}${e.detail ? ` (${e.detail})` : ''}`);
  for (const e of of('rollback')) rec.push(`- ${time(e.at)} rolled back to "${e.checkpoint}": ${e.files.join(', ')}`);
  for (const e of of('fault_injected')) rec.push(`- ${time(e.at)} (testing) a ${words(e.fault)} fault was injected on purpose`);
  out.push(...(rec.length ? rec : ['No recovery was needed.']), '');

  // Models used
  out.push('## Models used', '');
  const used = new Set<string>();
  if (models) out.push(`- Configured: primary ${models.primary}, fallback ${models.fallback}`);
  for (const e of of('model_switched')) used.add(e.to);
  for (const e of of('metrics')) used.add(e.model);
  if (used.size) out.push(`- Answered by: ${[...used].join(', ')}`);
  if (!models && !used.size) out.push('- (not recorded)');
  const m = of('metrics').at(-1);
  if (m) {
    out.push('', '## Cost and speed', '');
    out.push(`- Tokens: ${m.inputTokens ?? 'not reported'} input, ${m.outputTokens ?? 'not reported'} output${m.costUsd !== undefined ? `; estimated cost $${m.costUsd.toFixed(4)}` : ''}`);
    out.push(`- Elapsed: ${(m.elapsedMs / 1000).toFixed(1)} s`, `- Files read: ${m.filesRead} of ${m.filesTotal}`);
  }
  out.push('', '_Generated by CodeCraft from its append-only journal; secrets are redacted when the journal is written._', '');
  return out.join('\n');
}
