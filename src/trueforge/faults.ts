// Fault injection (P4): makes the next run fail on purpose so failover, retries, the breaker and banners can be
// exercised. Every injected error is the EXACT text TrueForge 0.185.1 produced for that fault (captured live,
// see test/fixtures/trueforge-errors.json). Test/demo feature: armed by a setting or the panel button.
import type { TurnEvent } from './client';
import type { TurnDriver } from './run';

export type FaultMode = 'outage' | 'timeout' | 'malformed_tool_call' | 'cut_stream' | 'invalid_key' | 'rate_limit';
export const FAULT_MODES: FaultMode[] = ['outage', 'timeout', 'malformed_tool_call', 'cut_stream', 'invalid_key', 'rate_limit'];

/** Real TrueForge turn.done error texts (source: test/fixtures/trueforge-errors.json, 2026-11-21). */
export const REAL_FAULT_TEXT: Record<Exclude<FaultMode, 'cut_stream'>, string> = {
  outage: '[Model Error] Request failed (503): The engine is currently overloaded, please try again later.',
  timeout: '[Model Error] Cannot connect to API: Headers Timeout Error',
  malformed_tool_call: '[Model Error] JSON parsing failed: Text: {"id": "c1", "choices": [ {"delta": {"content": "hel.\nError message: SyntaxError: Unterminated string in JSON at position 45',
  invalid_key: '[Model Error] Request failed (401): Invalid API Key',
  rate_limit: '[Model Error] Request failed (429): Rate limit reached for requests. Please try again in 7s.',
};

const ev = (e: unknown): TurnEvent => e as TurnEvent;

export class FaultInjector {
  private once: FaultMode | undefined;
  /** Every injection, for the journal and the failure table. */
  readonly injected: FaultMode[] = [];

  constructor(private readonly persistent: () => FaultMode | 'none' = () => 'none') {}

  /** Arms a fault for the next run only (the panel button). */
  arm(mode: FaultMode): void {
    this.once = mode;
  }

  /** The fault for this run, consuming a one-shot arm. */
  take(): FaultMode | undefined {
    const m = this.once ?? (this.persistent() === 'none' ? undefined : (this.persistent() as FaultMode));
    this.once = undefined;
    return m;
  }

  /** Wraps a driver so that the first start() of this run fails with `mode` (or passes through when undefined). */
  wrap(inner: TurnDriver, mode: FaultMode | undefined, onInjected?: (m: FaultMode) => void): TurnDriver {
    if (!mode) return inner;
    let used = false;
    const self = this;
    return {
      ...inner,
      start(text, signal) {
        if (used) return inner.start(text, signal);
        used = true;
        self.injected.push(mode);
        onInjected?.(mode);
        if (mode === 'cut_stream') {
          // Real stream, cut right after the first model message; the run must resume the same turn.
          return (async function* () {
            for await (const e of inner.start(text, signal)) {
              yield e;
              if (e.type === 'model.message') return;
            }
          })();
        }
        const message = REAL_FAULT_TEXT[mode];
        return (async function* () {
          yield ev({ type: 'turn.created', id: `injected-${mode}`, turnId: `injected-${mode}`, previousTurnId: null, state: { status: 'running' }, createdAt: new Date().toISOString(), threadId: null });
          yield ev({ type: 'turn.done', id: `injected-${mode}-done`, threadId: null, createdAt: new Date().toISOString(), state: { status: 'error', message, completedAt: new Date().toISOString() } });
        })();
      },
    };
  }
}
