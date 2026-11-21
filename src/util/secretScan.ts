// Workspace secret scan (P5). Pure over injected file access. Findings carry file, line and rule name only:
// the matched value is never stored, logged or shown.
import { SECRET_RULES } from './redact';

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
}

export interface ScanReport {
  scannedFiles: number;
  skippedFiles: number;
  findings: SecretFinding[];
  /** .env-style files found in the workspace (agents cannot read them; they should be gitignored). */
  envFiles: string[];
}

const ALLOW = 'secret-scan:allow';
const MAX_SCAN_CHARS = 1_000_000;

export function scanText(path: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (l.includes(ALLOW)) return;
    for (const r of SECRET_RULES) {
      r.re.lastIndex = 0;
      if (r.re.test(l)) out.push({ path, line: i + 1, rule: r.name });
      r.re.lastIndex = 0;
    }
  });
  // multi-line private keys
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !out.some((f) => f.rule === 'private key')) {
    const idx = lines.findIndex((l) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l));
    if (idx >= 0 && !(lines[idx] ?? '').includes(ALLOW)) out.push({ path, line: idx + 1, rule: 'private key' });
  }
  return out;
}

export async function scanWorkspace(files: string[], read: (path: string) => Promise<string | undefined>, envFiles: string[] = []): Promise<ScanReport> {
  const findings: SecretFinding[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const p of files) {
    const text = await read(p).catch(() => undefined);
    if (text === undefined || text.length > MAX_SCAN_CHARS || text.includes('\0')) {
      skipped++;
      continue;
    }
    scanned++;
    findings.push(...scanText(p, text));
  }
  return { scannedFiles: scanned, skippedFiles: skipped, findings, envFiles: [...envFiles].sort() };
}

/** Markdown report: locations and rule names only. */
export function renderScan(r: ScanReport): string {
  const out = ['# CodeCraft secret scan', '', `${r.scannedFiles} file(s) scanned, ${r.skippedFiles} skipped (binary or larger than 1 MB). Values are never shown.`, ''];
  out.push(r.findings.length ? `## ${r.findings.length} possible secret(s)` : '## No key-shaped values found', '');
  for (const f of r.findings) out.push(`- ${f.path}:${f.line} - ${f.rule}`);
  if (r.envFiles.length) {
    out.push('', '## Environment files', '', 'Agents cannot read these. Make sure they are listed in .gitignore and never committed:', '');
    for (const e of r.envFiles) out.push(`- ${e}`);
  }
  return out.join('\n');
}
