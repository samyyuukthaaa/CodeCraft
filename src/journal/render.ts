// Pure: renders journal entries as a readable Markdown edit history (newest run first). Entries are already
// redacted when written; nothing here adds file contents.
import type { JournalEntry } from './journal';

const time = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 19);

function line(e: JournalEntry): string | undefined {
  switch (e.t) {
    case 'run_started':
      return `- ${time(e.at)} run started: "${e.request.replace(/\s+/g, ' ').slice(0, 120)}"`;
    case 'plan':
      return `- ${time(e.at)} plan: ${e.summary} (${e.files.map((f) => `${f.action} ${f.path}`).join(', ')})`;
    case 'op_started':
      return undefined; // shown through op_applied; a started-but-not-applied op is flagged below
    case 'op_applied':
      return `- ${time(e.at)} **applied** operation \`${e.opId}\`: ${e.files.map((f) => `${f.path} [${f.intent}] ${f.accepted} hunk(s) accepted, ${f.rejected} rejected`).join('; ')}`;
    case 'op_rejected':
      return `- ${time(e.at)} rejected by the user: ${e.files.join(', ')} (nothing written)`;
    case 'op_refused':
      return `- ${time(e.at)} refused: ${e.reason}`;
    case 'op_undone':
      return `- ${time(e.at)} **undone** operation \`${e.opId}\`: ${e.files.join(', ')}`;
    case 'tests':
      return `- ${time(e.at)} tests ${e.passed ? 'passed' : `failed (exit ${e.exitCode})`}`;
    case 'provider_error':
      return `- ${time(e.at)} provider error: ${e.model} (${e.cls.replace(/_/g, ' ')})`;
    case 'provider_recovered':
      return `- ${time(e.at)} provider recovered: ${e.model}`;
    case 'model_switched':
      return `- ${time(e.at)} switched model: ${e.from} -> ${e.to} (${e.reason.replace(/_/g, ' ')})`;
    case 'run_finished':
      return `- ${time(e.at)} run finished: ${e.status}`;
  }
}

export function renderJournal(entries: readonly JournalEntry[], maxRuns = 50): string {
  const runs = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const k = e.runId || '(outside a run)';
    runs.set(k, [...(runs.get(k) ?? []), e]);
  }
  const ordered = [...runs.entries()].sort((a, b) => (b[1][0]?.at ?? 0) - (a[1][0]?.at ?? 0)).slice(0, maxRuns);
  const out = ['# CodeCraft edit journal', '', `${entries.length} entries, ${runs.size} run(s). Append-only; secrets are redacted when written. Newest run first.`, ''];
  for (const [runId, list] of ordered) {
    const applied = new Set(list.filter((e) => e.t === 'op_applied').map((e) => (e as { opId: string }).opId));
    const interrupted = list.filter((e) => e.t === 'op_started' && !applied.has(e.opId)) as Array<Extract<JournalEntry, { t: 'op_started' }>>;
    out.push(`## Run ${runId}`, '');
    for (const e of list) {
      const l = line(e);
      if (l) out.push(l);
    }
    for (const e of interrupted) out.push(`- ${time(e.at)} **interrupted** operation \`${e.opId}\` (started, not confirmed applied): ${e.files.map((f) => f.path).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}
