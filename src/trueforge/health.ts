// Provider/key health (P4): rows for the panel and the "Test providers" probe. Pure: the probe's turn runner
// is injected. Rows never contain keys (CodeCraft never has them) or raw provider text.
import { CircuitBreaker, providerOf } from './breaker';
import { classifyError } from './errors';

export interface HealthRow {
  role: string;
  model: string;
  provider: string;
  /** healthy | paused (breaker open) | probe-pending (half-open) | unknown (not used yet) */
  status: 'healthy' | 'paused' | 'probe-pending' | 'unknown';
  lastErrorClass?: string;
  /** ISO time of the last error. */
  lastErrorAt?: string;
  /** ISO time when a paused provider may be tried again. */
  retryAt?: string;
}

export function healthRows(breaker: CircuitBreaker, configured: Array<{ role: string; model: string }>): HealthRow[] {
  const snap = breaker.snapshot();
  return configured.map(({ role, model }) => {
    const h = snap.find((s) => s.provider === providerOf(model));
    const status: HealthRow['status'] = !h ? 'unknown' : h.state === 'open' ? 'paused' : h.state === 'half_open' ? 'probe-pending' : h.lastOkAt || !h.lastErrorClass ? 'healthy' : 'unknown';
    return {
      role,
      model,
      provider: providerOf(model),
      status,
      ...(h?.lastErrorClass ? { lastErrorClass: h.lastErrorClass } : {}),
      ...(h?.lastErrorAt ? { lastErrorAt: new Date(h.lastErrorAt).toISOString() } : {}),
      ...(h?.retryAt && h.state !== 'closed' ? { retryAt: new Date(h.retryAt).toISOString() } : {}),
    };
  });
}

export interface ProbeResult {
  role: string;
  model: string;
  ok: boolean;
  /** Error class only (never the raw message, which could echo provider details). */
  errorClass?: string;
  recovered?: boolean;
}

/**
 * "Test providers": one tiny turn per configured agent. Results update the breaker (a success after an open
 * breaker reports recovery). `runProbe` returns undefined on success or the error message on failure.
 */
export async function probeProviders(
  breaker: CircuitBreaker,
  configured: Array<{ role: string; model: string; agent: string }>,
  runProbe: (agent: string) => Promise<string | undefined>,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const c of configured) {
    let err: string | undefined;
    try {
      err = await runProbe(c.agent);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (err === undefined) {
      const recovered = breaker.recordSuccess(c.model);
      out.push({ role: c.role, model: c.model, ok: true, ...(recovered ? { recovered } : {}) });
    } else {
      breaker.recordFailure(c.model, err);
      out.push({ role: c.role, model: c.model, ok: false, errorClass: classifyError(err).cls });
    }
  }
  return out;
}
