// Minimal failover (P1): if a run on one agent ends in an error, run it on the next configured agent.
// Model calls stay inside TrueForge: each attempt is a TrueForge session bound to a registered agent.
// Error classification, retries, circuit breaking and journal-based resume are P4.
//
// Safety: a re-run cannot apply anything twice. The write gate needs a fresh read, a stale check and a new
// per-hunk decision for every write, so changes the user already accepted stay applied and are re-proposed
// only if the fallback agent reads the current file and proposes something different.
import { redact } from '../util/redact';
import { RunOptions, RunOutcome, TurnDriver, runWithApprovals } from './run';

export interface AgentAttempt {
  /** Agent name, e.g. codecraft-primary. */
  agent: string;
  /** Model name, for display only. */
  model: string;
  /** Creates (or reuses) the TrueForge session for this agent. Called lazily. */
  driver: () => Promise<TurnDriver>;
}

export interface SwitchInfo {
  from: string;
  to: string;
  reason: string;
}

export interface FailoverResult {
  outcome: RunOutcome;
  /** The agent whose outcome is reported. */
  agent: string;
  switches: SwitchInfo[];
}

export const FAILOVER_NOTE =
  'Note: a previous attempt by another model failed before finishing this request. ' +
  'Some changes may already have been applied after user review, so read files again before proposing changes.';

export async function runWithFailover(
  text: string,
  attempts: AgentAttempt[],
  opts: Omit<RunOptions, 'driver'> & { onSwitch?: (s: SwitchInfo) => void },
): Promise<FailoverResult> {
  if (attempts.length === 0) throw new Error('no agents configured');
  const switches: SwitchInfo[] = [];
  let last: FailoverResult | undefined;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i] as AgentAttempt;
    let outcome: RunOutcome;
    try {
      const driver = await a.driver();
      outcome = await runWithApprovals(i === 0 ? text : `${text}\n\n${FAILOVER_NOTE}`, { ...opts, driver });
    } catch (e) {
      if (opts.signal?.aborted) return { outcome: { status: 'cancelled', rounds: 0 }, agent: a.agent, switches };
      outcome = { status: 'error', message: redact(e instanceof Error ? e.message : String(e)), rounds: 0 };
    }
    last = { outcome, agent: a.agent, switches };
    // Only an error triggers failover. Done, cancelled (Stop Run) and unsupported are final.
    if (outcome.status !== 'error') return last;
    const next = attempts[i + 1];
    if (!next) return last;
    const s: SwitchInfo = { from: a.agent, to: next.agent, reason: outcome.message };
    switches.push(s);
    opts.onSwitch?.(s);
  }
  return last as FailoverResult;
}
