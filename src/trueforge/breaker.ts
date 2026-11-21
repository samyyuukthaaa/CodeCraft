// Per-provider circuit breaker (P4). Pure, with an injectable clock. A provider is the part of a TrueForge
// model reference before the first "/" (e.g. "google-gemini" in "google-gemini/gemini-3-5-flash").
//
//   closed    -> requests go through
//   open      -> skipped until the cooldown ends (a fallback is used instead)
//   half_open -> cooldown over: the next request (a run or a "Test providers" probe) is let through;
//                success closes it and reports provider_recovered, failure re-opens it
import { ErrorClass, classifyError, isDailyQuota } from './errors';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface ProviderHealth {
  provider: string;
  /** Last model seen for this provider. */
  model: string;
  state: BreakerState;
  lastErrorClass?: ErrorClass;
  lastErrorAt?: number;
  lastOkAt?: number;
  /** When an open breaker allows a probe again. */
  retryAt?: number;
  consecutiveFailures: number;
}

export const COOLDOWN_MS = {
  invalid_or_revoked_key: 10 * 60_000,
  daily_quota: 60 * 60_000,
  rate_limit: 60_000,
  unavailable_or_timeout: 60_000,
  other: 30_000,
};
/** Other failures (bad output, bad request, unknown) open the breaker only after this many in a row. */
export const OTHER_FAILURES_TO_OPEN = 3;

export const providerOf = (modelRef: string): string => modelRef.split('/')[0] ?? modelRef;

/** Banner when the primary is skipped because its provider's breaker is open. Plain words, no key values. */
export function circuitOpenBanner(fromModel: string, toModel: string, health: ProviderHealth | undefined, now: number = Date.now()): string {
  const why = health?.lastErrorClass ? ` after ${health.lastErrorClass.replace(/_/g, ' ')}` : '';
  const mins = health?.retryAt ? Math.max(1, Math.ceil((health.retryAt - now) / 60_000)) : undefined;
  const until = mins ? ` CodeCraft will try it again in about ${mins} min.` : '';
  return `The primary model ${fromModel} is paused${why}.${until} This request uses the fallback model ${toModel}.`;
}

interface Entry {
  model: string;
  openedUntil?: number;
  lastErrorClass?: ErrorClass;
  lastErrorAt?: number;
  lastOkAt?: number;
  consecutiveFailures: number;
  wasOpen: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }

  private entry(provider: string, model: string): Entry {
    let e = this.entries.get(provider);
    if (!e) {
      e = { model, consecutiveFailures: 0, wasOpen: false };
      this.entries.set(provider, e);
    }
    e.model = model;
    return e;
  }

  state(provider: string): BreakerState {
    const e = this.entries.get(provider);
    if (!e?.openedUntil) return 'closed';
    return this.now() >= e.openedUntil ? 'half_open' : 'open';
  }

  /** False while the breaker is open (cooldown not over). */
  allow(modelRef: string): boolean {
    return this.state(providerOf(modelRef)) !== 'open';
  }

  /** Records a failed run or probe; returns the new state. TLS errors are local and never open a breaker. */
  recordFailure(modelRef: string, message: string): BreakerState {
    const provider = providerOf(modelRef);
    const e = this.entry(provider, modelRef);
    const cls = classifyError(message).cls;
    e.lastErrorClass = cls;
    e.lastErrorAt = this.now();
    e.consecutiveFailures++;
    let cooldown: number | undefined;
    if (cls === 'invalid_or_revoked_key') cooldown = COOLDOWN_MS.invalid_or_revoked_key;
    else if (cls === 'rate_limit') cooldown = isDailyQuota(message) ? COOLDOWN_MS.daily_quota : COOLDOWN_MS.rate_limit;
    else if (cls === 'unavailable_or_timeout') cooldown = COOLDOWN_MS.unavailable_or_timeout;
    else if (cls !== 'tls_error' && e.consecutiveFailures >= OTHER_FAILURES_TO_OPEN) cooldown = COOLDOWN_MS.other;
    if (cooldown !== undefined) {
      e.openedUntil = this.now() + cooldown;
      e.wasOpen = true;
    }
    this.changed();
    return this.state(provider);
  }

  /** Records a success; returns true when this closes a breaker that had been open (provider_recovered). */
  recordSuccess(modelRef: string): boolean {
    const provider = providerOf(modelRef);
    const e = this.entry(provider, modelRef);
    const recovered = e.wasOpen;
    e.openedUntil = undefined;
    e.wasOpen = false;
    e.consecutiveFailures = 0;
    e.lastOkAt = this.now();
    this.changed();
    return recovered;
  }

  /** Health rows for the panel: never includes keys (CodeCraft never has them). */
  snapshot(): ProviderHealth[] {
    return [...this.entries.entries()]
      .map(([provider, e]) => ({
        provider,
        model: e.model,
        state: this.state(provider),
        consecutiveFailures: e.consecutiveFailures,
        ...(e.lastErrorClass ? { lastErrorClass: e.lastErrorClass } : {}),
        ...(e.lastErrorAt ? { lastErrorAt: e.lastErrorAt } : {}),
        ...(e.lastOkAt ? { lastOkAt: e.lastOkAt } : {}),
        ...(e.openedUntil ? { retryAt: e.openedUntil } : {}),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}
