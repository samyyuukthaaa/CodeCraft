// Pure redaction helper. Used before anything is logged, shown, journaled or sent anywhere other than the
// agent's own read_file (which must return exact file content so edits match; .env and key files are
// blocked from it entirely by the path policy). The same named rules drive the workspace secret scan.
export const SECRET_RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'Groq API key', re: /gsk_[0-9A-Za-z]{16,}/g },
  { name: 'OpenAI/Anthropic API key', re: /sk-(?:ant-|proj-)?[0-9A-Za-z_-]{16,}/g },
  { name: 'xAI API key', re: /xai-[0-9A-Za-z]{16,}/g },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub token', re: /gh[pousr]_[0-9A-Za-z]{20,}/g },
  { name: 'Slack token', re: /xox[abprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Bearer token', re: /Bearer\s+[0-9A-Za-z._~+/-]{12,}=*/gi },
  { name: 'key/token/password assignment', re: /("?(?:api[_-]?key|apikey|authorization|token|secret|password)"?\s*[:=]\s*)"?[^"\s,}]{6,}"?/gi },
];
export const SECRET_PATTERNS: RegExp[] = SECRET_RULES.map((r) => r.re);

export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_m, g1?: string) => (typeof g1 === 'string' ? `${g1}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}
