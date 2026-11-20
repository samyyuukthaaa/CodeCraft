// Pure redaction helper. Used before anything is logged or emitted.
const PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gsk_[0-9A-Za-z]{16,}/g,
  /sk-[0-9A-Za-z_-]{16,}/g,
  /Bearer\s+[0-9A-Za-z._~+/-]{12,}=*/gi,
  /("?(?:api[_-]?key|apikey|authorization|token|secret)"?\s*[:=]\s*)"?[^"\s,}]{6,}"?/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (_m, g1?: string) => (typeof g1 === 'string' ? `${g1}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}
