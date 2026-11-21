// Pure redaction helper. Used before anything is logged, shown, journaled or sent anywhere other than the
// agent's own read_file (which must return exact file content so edits match; .env and key files are
// blocked from it entirely by the path policy).
export const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /gsk_[0-9A-Za-z]{16,}/g, // Groq
  /sk-(?:ant-|proj-)?[0-9A-Za-z_-]{16,}/g, // OpenAI, Anthropic
  /xai-[0-9A-Za-z]{16,}/g, // xAI
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /gh[pousr]_[0-9A-Za-z]{20,}/g, // GitHub tokens
  /xox[abprs]-[0-9A-Za-z-]{10,}/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[0-9A-Za-z._~+/-]{12,}=*/gi,
  /("?(?:api[_-]?key|apikey|authorization|token|secret|password)"?\s*[:=]\s*)"?[^"\s,}]{6,}"?/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_m, g1?: string) => (typeof g1 === 'string' ? `${g1}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}
