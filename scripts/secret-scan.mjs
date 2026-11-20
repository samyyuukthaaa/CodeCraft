// Secret scan over staged files and the staged diff (or all tracked files with --all).
// Exit code 1 on any hit. Never prints the matched value, only file, line and rule.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const RULES = [
  ['AIza key', /AIza[0-9A-Za-z_-]{20,}/],
  ['gsk_ key', /gsk_[0-9A-Za-z]{16,}/],
  ['sk- key', /sk-[0-9A-Za-z_-]{16,}/],
  ['Bearer token', /Bearer\s+[0-9A-Za-z._~+/-]{16,}/],
  ['api_key assignment', /api[_-]?key["']?\s*[:=]\s*["']?[0-9A-Za-z_-]{12,}/i],
];
// Lines carrying this marker are test fixtures that deliberately look like keys.
const ALLOW = 'secret-scan:allow';

const all = process.argv.includes('--all');
const sh = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const files = sh(all ? 'git ls-files' : 'git diff --cached --name-only --diff-filter=ACMR')
  .split('\n')
  .filter(Boolean);

let hits = 0;
for (const f of files) {
  if (/(^|\/)\.env(\..*)?$/.test(f)) {
    console.error(`BLOCKED: ${f} is an env file and must never be committed`);
    hits++;
    continue;
  }
  if (!existsSync(f) || f === 'scripts/secret-scan.mjs') continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    for (const [name, re] of RULES) {
      if (re.test(line)) {
        console.error(`HIT: ${f}:${i + 1} matches ${name}`);
        hits++;
      }
    }
  });
}
console.log(`secret-scan: ${files.length} files checked, ${hits} hit(s)`);
process.exit(hits ? 1 : 0);
