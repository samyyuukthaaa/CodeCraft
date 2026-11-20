// Pure classification of TrueForge model errors into plain-language messages. Every pattern below comes
// from an error text actually observed from TrueForge 0.185.1 (see docs/TRUEFORGE_NOTES.md); anything
// else is "unknown" and is shown as-is (redacted) rather than guessed at. Key values are never shown.
import { redact } from '../util/redact';

export type ErrorClass = 'invalid_or_revoked_key' | 'rate_limit' | 'unavailable_or_timeout' | 'bad_output' | 'context_too_large' | 'bad_request' | 'unknown';

export interface Classified {
  cls: ErrorClass;
  /** HTTP status from "[Model Error] Request failed (NNN)", if present. */
  status?: number;
}

export function classifyError(message: string): Classified {
  const m = /Request failed \((\d{3})\)/.exec(message);
  const status = m ? Number(m[1]) : undefined;
  const t = message.toLowerCase();
  // observed: "(401): Invalid API Key"
  if (status === 401 || status === 403 || /invalid api key|api key not valid|api_key_invalid|unauthori[sz]ed|permission denied/.test(t)) return { cls: 'invalid_or_revoked_key', status };
  // observed: "(429): You exceeded your current quota ..."
  if (status === 429 || /quota|rate limit|too many requests/.test(t)) return { cls: 'rate_limit', status };
  // observed: "(503): ... high demand", "Cannot connect to API: Headers Timeout Error", "terminated: read ECONNRESET"
  if ((status !== undefined && status >= 500) || /high demand|cannot connect to api|timeout|econnreset|econnrefused|unavailable/.test(t)) return { cls: 'unavailable_or_timeout', status };
  if (/context (length|window)|maximum context|too many tokens|prompt is too long/.test(t)) return { cls: 'context_too_large', status };
  // observed: "(400): * GenerateContentRequest.generation_config.temperature: ...", "(400): Bad Request"
  if (status === 400) return { cls: 'bad_request', status };
  return { cls: 'unknown', status };
}

export const MAX_RETRIES = 2;
const MAX_HINT_MS = 65_000;

/**
 * Delay before retrying the same agent, or undefined when the error must not be retried (it then fails
 * over at once). Observed rate-limit text carries a hint: "Please retry in 59.382723513s."
 */
export function retryDelayMs(message: string, retryIndex: number, rand: () => number = Math.random): number | undefined {
  if (retryIndex >= MAX_RETRIES) return undefined;
  const c = classifyError(message);
  const jitter = Math.floor(rand() * 1000);
  if (c.cls === 'rate_limit') {
    const hint = /retry in ([\d.]+)\s*s/i.exec(message);
    const ms = hint ? Math.ceil(Number(hint[1]) * 1000) : 10_000 * (retryIndex + 1);
    return Math.min(ms, MAX_HINT_MS) + jitter;
  }
  if (c.cls === 'unavailable_or_timeout') return [5_000, 15_000][retryIndex]! + jitter;
  return undefined; // invalid key, bad request, context too large, unknown: no blind retries
}

const WHAT: Record<ErrorClass, string> = {
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
  return `The primary model ${fromModel} stopped because ${WHAT[c.cls]}${code}. CodeCraft switched to the fallback model ${toModel} automatically and is continuing your request.`;
}

/** Message when a run fails and no fallback could take over. `appliedFiles` = files written during the run. */
export function failureMessage(model: string, reason: string, appliedFiles: string[] = []): string {
  const c = classifyError(reason);
  const filesNote = appliedFiles.length ? ` Changes you accepted earlier in this run stay applied: ${appliedFiles.join(', ')}.` : ' Nothing was changed in your files.';
  const code = c.status ? ` (HTTP ${c.status})` : '';
  switch (c.cls) {
    case 'invalid_or_revoked_key':
      return `Provider key rejected${code} for ${model}: update it in TrueForge Settings.${filesNote}`;
    case 'rate_limit':
      return `${model} hit a rate limit or quota${code}. Try again later or configure a fallback model.${filesNote}`;
    case 'unavailable_or_timeout':
      return `${model} is unavailable or timed out${code}. Try again, or configure a fallback model.${filesNote}`;
    case 'context_too_large':
      return `The request was too large for ${model}${code}. Reduce codecraft.contextBudget or narrow the request.${filesNote}`;
    default:
      return `${model} failed${code}: ${redact(reason).slice(0, 300)}${filesNote}`;
  }
}
