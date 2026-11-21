// Pure classification of TrueForge model errors into plain-language messages. Every pattern below comes
// from an error text actually observed from TrueForge 0.185.1 (see docs/TRUEFORGE_NOTES.md); anything
// else is "unknown" and is shown as-is (redacted) rather than guessed at. Key values are never shown.
import { redact } from '../util/redact';

export type ErrorClass = 'tls_error' | 'invalid_or_revoked_key' | 'rate_limit' | 'unavailable_or_timeout' | 'bad_output' | 'context_too_large' | 'bad_request' | 'unknown';

export interface Classified {
  cls: ErrorClass;
  /** HTTP status from "[Model Error] Request failed (NNN)", if present. */
  status?: number;
}

export function classifyError(message: string): Classified {
  const m = /Request failed \((\d{3})\)/.exec(message);
  const status = m ? Number(m[1]) : undefined;
  const t = message.toLowerCase();
  // observed: "Cannot connect to API: certificate has expired" (a machine network/TLS problem, not the provider)
  if (/certificate has expired|cert_has_expired|self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate/.test(t)) return { cls: 'tls_error', status };
  // observed: "(401): Invalid API Key"
  if (status === 401 || status === 403 || /invalid api key|api key not valid|api_key_invalid|unauthori[sz]ed|permission denied/.test(t)) return { cls: 'invalid_or_revoked_key', status };
  // observed: "(429): You exceeded your current quota ..."
  if (status === 429 || /quota|rate limit|too many requests/.test(t)) return { cls: 'rate_limit', status };
  // observed: "(503): ... high demand", "Cannot connect to API: Headers Timeout Error", "terminated: read ECONNRESET"
  if ((status !== undefined && status >= 500) || /high demand|cannot connect to api|timeout|econnreset|econnrefused|unavailable/.test(t)) return { cls: 'unavailable_or_timeout', status };
  if (/context (length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds the maximum/.test(t)) return { cls: 'context_too_large', status };
  // Output the agent loop could not use (malformed tool call JSON, empty or blocked response). Not observed
  // live yet; patterns follow the common provider texts and are covered by unit tests only.
  if (/invalid json|malformed|could not parse|failed to parse|unexpected token|empty (response|output|completion)|no candidates|finish_reason[^a-z]*(malformed|recitation)/.test(t)) return { cls: 'bad_output', status };
  // observed: "(400): * GenerateContentRequest.generation_config.temperature: ...", "(400): Bad Request"
  if (status === 400) return { cls: 'bad_request', status };
  return { cls: 'unknown', status };
}

/**
 * Retries per class within one run on one agent, before failing over (P4 policy):
 *  - invalid key / TLS / bad request / unknown: 0 (fail over at once; a key problem shows the banner)
 *  - rate limit (per minute): wait for Retry-After / "retry in N s"; counted as CONSECUTIVE failures without
 *    progress (MAX_RETRIES), hard-capped at MAX_RATE_LIMIT_WAITS per run; a DAILY quota is never retried
 *  - outage / timeout: 2, with backoff
 *  - bad output: 1
 *  - context too large: 1, after the caller trims the context (see runWithFailover's trimPrompt)
 */
export const RETRY_BUDGET: Record<ErrorClass, number> = {
  tls_error: 0,
  invalid_or_revoked_key: 0,
  bad_request: 0,
  unknown: 0,
  rate_limit: 3,
  unavailable_or_timeout: 2,
  bad_output: 1,
  context_too_large: 1,
};
/** Consecutive rate-limit failures without progress before failing over. */
export const MAX_RETRIES = RETRY_BUDGET.rate_limit;
/** Hard cap on rate-limit waits per agent per run, even while the agent keeps making progress. */
export const MAX_RATE_LIMIT_WAITS = 10;
const MAX_HINT_MS = 65_000;

/** Server-provided wait: a Retry-After value (seconds) or the observed "Please retry in 59.38s." text. */
export function retryAfterMs(message: string): number | undefined {
  const m = /retry[-_ ]after["':\s]+([\d.]+)\s*(?:s|sec|secs|seconds)?\b/i.exec(message) ?? /retry in ([\d.]+)\s*s/i.exec(message);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

/**
 * Delay before retry number `retryIndex` (0-based, counted per class) of the same agent, or undefined when
 * this class must not be retried (any more); the run then fails over.
 */
export function retryDelayMs(message: string, retryIndex: number, rand: () => number = Math.random): number | undefined {
  const c = classifyError(message);
  if (retryIndex >= RETRY_BUDGET[c.cls]) return undefined;
  const jitter = Math.floor(rand() * 1000);
  switch (c.cls) {
    case 'rate_limit': {
      // observed: "Generate content requests per day limit exceeded on Free Tier" (limit 500); waiting a minute
      // cannot help, so a daily quota is never retried (it fails over at once).
      if (isDailyQuota(message)) return undefined;
      const ms = retryAfterMs(message) ?? 10_000 * (retryIndex + 1);
      return Math.min(ms, MAX_HINT_MS) + jitter;
    }
    case 'unavailable_or_timeout':
      return [5_000, 15_000][retryIndex]! + jitter;
    case 'bad_output':
      return 2_000 + jitter;
    case 'context_too_large':
      return 0; // retried at once with a trimmed context
    default:
      return undefined;
  }
}

/** True for a provider's per-day quota (not a per-minute limit). */
export const isDailyQuota = (message: string): boolean => /per day|daily (limit|quota)|requests_per_day|PerDay/i.test(message);

const WHAT: Record<ErrorClass, string> = {
  tls_error: 'the secure connection to the provider failed (TLS certificate error on this machine or network)',
  invalid_or_revoked_key: 'its API key was rejected',
  rate_limit: 'it hit a rate limit or used up its quota',
  unavailable_or_timeout: 'the provider was unavailable or timed out',
  bad_output: 'it returned output CodeCraft could not use',
  context_too_large: 'the request was too large for its context window',
  bad_request: 'the provider rejected the request',
  unknown: 'it failed',
};

/** Banner text for an automatic switch. Never includes a key or raw provider text beyond the class. */
export function failoverBanner(fromModel: string, toModel: string, reason: string): string {
  const c = classifyError(reason);
  const code = c.status ? ` (HTTP ${c.status})` : '';
  const what = c.cls === 'rate_limit' && isDailyQuota(reason) ? 'it used up its daily quota' : WHAT[c.cls];
  return `The primary model ${fromModel} stopped because ${what}${code}. CodeCraft switched to the fallback model ${toModel} automatically and is continuing your request.`;
}

/** Message when a run fails and no fallback could take over. `appliedFiles` = files written during the run. */
export function failureMessage(model: string, reason: string, appliedFiles: string[] = []): string {
  const c = classifyError(reason);
  const filesNote = appliedFiles.length ? ` Changes you accepted earlier in this run stay applied: ${appliedFiles.join(', ')}.` : ' Nothing was changed in your files.';
  const code = c.status ? ` (HTTP ${c.status})` : '';
  switch (c.cls) {
    case 'tls_error':
      return `Cannot reach ${model}: the secure (TLS) connection failed${code}. Check this machine's clock, proxy or network; retrying will not help.${filesNote}`;
    case 'invalid_or_revoked_key':
      return `Provider key rejected${code} for ${model}: update it in TrueForge Settings.${filesNote}`;
    case 'rate_limit':
      if (isDailyQuota(reason)) return `${model} has used up its daily quota${code}. It resets once a day (for Google's free tier, at midnight Pacific time); configure a fallback model with its own quota or try again after the reset.${filesNote}`;
      return `${model} hit a rate limit or quota${code}. Try again later or configure a fallback model.${filesNote}`;
    case 'unavailable_or_timeout':
      return `${model} is unavailable or timed out${code}. Try again, or configure a fallback model.${filesNote}`;
    case 'context_too_large':
      return `The request was too large for ${model}${code}. Reduce codecraft.contextBudget or narrow the request.${filesNote}`;
    default:
      return `${model} failed${code}: ${redact(reason).slice(0, 300)}${filesNote}`;
  }
}
