// Failover with bounded retries. Model calls stay inside TrueForge: each attempt is a TrueForge session
// bound to a registered agent.
//
// For each agent: run; on a transient error (rate limit, unavailable/timeout) wait (honouring the server's
// retry hint, capped) and CONTINUE in the same session, at most MAX_RETRIES times; on any other error, or
// when retries are used up, fail over to the next configured agent. Done, cancelled (Stop Run) and
// unsupported are final. An invalid key is never retried: it fails over at once.
//
// Safety: a retry or a re-run cannot apply anything twice. The write gate needs a fresh read, a stale check
// and a new per-hunk decision for every write, so accepted changes stay applied and are re-proposed only if
// the agent reads the current file and proposes something different.
import { redact } from '../util/redact';
import { CircuitBreaker, providerOf } from './breaker';
import { ErrorClass, MAX_RATE_LIMIT_WAITS, classifyError, retryDelayMs } from './errors';
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
  fromModel: string;
  toModel: string;
  reason: string;
  /** True when the first agent was skipped because its provider's circuit breaker is open. */
  circuitOpen?: boolean;
}

export interface ProviderErrorInfo {
  agent: string;
  model: string;
  cls: ErrorClass;
  message: string;
}

export interface RetryInfo {
  agent: string;
  model: string;
  /** 1-based retry number for this agent. */
  retry: number;
  delayMs: number;
  reason: string;
}

export interface FailoverResult {
  outcome: RunOutcome;
  /** The agent whose outcome is reported. */
  agent: string;
  switches: SwitchInfo[];
  retries: RetryInfo[];
}

export const FAILOVER_NOTE =
  'Note: a previous attempt by another model failed before finishing this request. ' +
  'Some changes may already have been applied after user review, so read files again before proposing changes.';

export const CONTINUE_PROMPT =
  'The previous step was interrupted by a temporary provider error. Continue the same task from where you stopped. ' +
  'Changes already applied after review stay applied; read files again before proposing further changes.';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runWithFailover(
  text: string,
  attempts: AgentAttempt[],
  opts: Omit<RunOptions, 'driver'> & {
    onSwitch?: (s: SwitchInfo) => void;
    onRetry?: (r: RetryInfo) => void;
    /**
     * Context too large: returns a smaller prompt (e.g. the request with a halved context budget), or
     * undefined when nothing can be trimmed. The retry then runs once in a fresh session.
     */
    trimPrompt?: (prompt: string) => string | undefined | Promise<string | undefined>;
    /** Checkpoint resume: what this run already completed (from the journal), added to failover/continue prompts. */
    progressNote?: () => string;
    /** Per-provider circuit breaker: open providers are skipped (unless no other agent is left). */
    breaker?: CircuitBreaker;
    /** Every provider error (event provider_error{class}). */
    onProviderError?: (e: ProviderErrorInfo) => void;
    /** A provider whose breaker had been open succeeded again (event provider_recovered). */
    onProviderRecovered?: (agent: string, model: string) => void;
    /** Injectable for tests. */
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    rand?: () => number;
  },
): Promise<FailoverResult> {
  if (attempts.length === 0) throw new Error('no agents configured');
  const switches: SwitchInfo[] = [];
  const retries: RetryInfo[] = [];
  const wait = opts.delay ?? sleep;
  let last: FailoverResult | undefined;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i] as AgentAttempt;
    const nextAgent = attempts[i + 1];
    if (opts.breaker && nextAgent && !opts.breaker.allow(a.model)) {
      const h = opts.breaker.snapshot().find((p) => p.provider === providerOf(a.model));
      const s: SwitchInfo = { from: a.agent, to: nextAgent.agent, fromModel: a.model, toModel: nextAgent.model, reason: `circuit open after ${h?.lastErrorClass ?? 'errors'}`, circuitOpen: true };
      switches.push(s);
      opts.onSwitch?.(s);
      continue;
    }
    let outcome: RunOutcome;
    const checkpoint = (): string => {
      const note = opts.progressNote?.() ?? '';
      return note ? `\n${note}` : '';
    };
    let prompt = i === 0 ? text : `${text}\n\n${FAILOVER_NOTE}${checkpoint()}`;
    let driver: TurnDriver | undefined;
    // Retry budgets per class (RETRY_BUDGET in errors.ts). Rate limits count only CONSECUTIVE failures
    // without progress (a long task that hits a per-minute quota several times while advancing keeps
    // going), with a hard cap of MAX_RATE_LIMIT_WAITS per agent per run.
    const used: Partial<Record<ErrorClass, number>> = {};
    let rateStreak = 0;
    let rateWaits = 0;
    for (let n = 0; ; n++) {
      let progress = 0;
      try {
        driver ??= await a.driver();
        outcome = await runWithApprovals(prompt, {
          ...opts,
          driver,
          onEvent: (ev) => {
            if (ev.type === 'tool.response') progress++;
            opts.onEvent?.(ev);
          },
        });
      } catch (e) {
        if (opts.signal?.aborted) return { outcome: { status: 'cancelled', rounds: 0 }, agent: a.agent, switches, retries };
        outcome = { status: 'error', message: redact(e instanceof Error ? e.message : String(e)), rounds: 0 };
      }
      if (outcome.status !== 'error') break;
      const cls = classifyError(outcome.message).cls;
      opts.onProviderError?.({ agent: a.agent, model: a.model, cls, message: outcome.message });
      let delayMs: number | undefined;
      if (cls === 'rate_limit') {
        rateStreak = progress > 0 ? 0 : rateStreak;
        delayMs = rateWaits < MAX_RATE_LIMIT_WAITS ? retryDelayMs(outcome.message, rateStreak, opts.rand) : undefined;
        rateStreak++;
        rateWaits++;
      } else {
        const k = used[cls] ?? 0;
        delayMs = retryDelayMs(outcome.message, k, opts.rand);
        used[cls] = k + 1;
      }
      // Context too large: retry once with a trimmed prompt in a FRESH session (the old history is too big).
      let freshPrompt: string | undefined;
      if (cls === 'context_too_large' && delayMs !== undefined) {
        freshPrompt = await opts.trimPrompt?.(i === 0 ? text : `${text}\n\n${FAILOVER_NOTE}`);
        if (freshPrompt === undefined) delayMs = undefined;
      }
      if (delayMs === undefined || opts.signal?.aborted) break;
      const info: RetryInfo = { agent: a.agent, model: a.model, retry: n + 1, delayMs, reason: outcome.message };
      retries.push(info);
      opts.onRetry?.(info);
      await wait(delayMs, opts.signal);
      if (opts.signal?.aborted) return { outcome: { status: 'cancelled', rounds: 0 }, agent: a.agent, switches, retries };
      if (freshPrompt !== undefined) {
        driver = undefined; // new session
        prompt = freshPrompt;
      } else {
        // A session that could not even be created is created again; otherwise continue in the same session.
        prompt = driver ? `${CONTINUE_PROMPT}${checkpoint()}` : prompt;
      }
    }
    last = { outcome, agent: a.agent, switches, retries };
    if (opts.breaker) {
      if (outcome.status === 'error') opts.breaker.recordFailure(a.model, outcome.message);
      else if (outcome.status === 'done' && opts.breaker.recordSuccess(a.model)) opts.onProviderRecovered?.(a.agent, a.model);
    }
    if (outcome.status !== 'error') return last;
    // A TLS failure is a local network problem: another model behind the same network would fail the same way.
    if (classifyError(outcome.message).cls === 'tls_error') return last;
    const next = attempts[i + 1];
    if (!next) return last;
    const s: SwitchInfo = { from: a.agent, to: next.agent, fromModel: a.model, toModel: next.model, reason: outcome.message };
    switches.push(s);
    opts.onSwitch?.(s);
  }
  return last as FailoverResult;
}
