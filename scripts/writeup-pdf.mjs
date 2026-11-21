// docs/WRITEUP.md -> docs/WRITEUP.pdf (A4) using headless Microsoft Edge or Chrome. No dependencies.
// Supports the Markdown used in the write-up: #/##/### headings, paragraphs, - lists, **bold**, `code`, | tables |.
// Usage: node scripts/writeup-pdf.mjs [--browser <path>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { countPdfPages, waitForStableFile } from './wait-file.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const md = readFileSync('docs/WRITEUP.md', 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

const out = [];
const lines = md.split('\n');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!l.trim()) continue;
  const h = /^(#{1,3})\s+(.*)$/.exec(l);
  if (h) {
    out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    continue;
  }
  if (l.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
    i--;
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const body = rows.filter((r) => !/^\|\s*-/.test(r));
    out.push(`<table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    continue;
  }
  if (/^\s*-\s+/.test(l)) {
    const items = [];
    while (i < lines.length && /^\s*-\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*-\s+/, ''));
    i--;
    out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
    continue;
  }
  const para = [l];
  while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|\||\s*-\s)/.test(lines[i + 1])) para.push(lines[++i]);
  out.push(`<p>${inline(para.join(' '))}</p>`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>CodeCraft write-up</title><style>
@page { size: A4; margin: 14mm 15mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9.6pt; line-height: 1.35; color: #111; }
h1 { font-size: 16pt; margin: 0 0 4px; } h2 { font-size: 11.5pt; margin: 10px 0 3px; border-bottom: 1px solid #bbb; padding-bottom: 1px; }
h3 { font-size: 10pt; margin: 6px 0 2px; } p { margin: 3px 0; } ul { margin: 2px 0 4px 16px; padding: 0; } li { margin: 1px 0; }
code { font-family: Consolas, monospace; font-size: 8.8pt; background: #f2f2f2; padding: 0 2px; }
table { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: 8.6pt; } th, td { border: 1px solid #ccc; padding: 2px 4px; text-align: left; vertical-align: top; } th { background: #f0f0f0; }
</style></head><body>${out.join('\n')}</body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'codecraft-writeup-'));
const htmlPath = join(dir, 'writeup.html');
writeFileSync(htmlPath, html);
const argIdx = process.argv.indexOf('--browser');
const candidates = [argIdx > 0 ? process.argv[argIdx + 1] : '', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) throw new Error('no Edge/Chrome found; pass --browser <path>');
const pdf = resolve('docs/WRITEUP.pdf');
// Remove the old PDF first, so the wait below can only succeed on the new one.
rmSync(pdf, { force: true });
execFileSync(browser, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${pdf}`, pathToFileURL(htmlPath).href], { stdio: 'ignore', timeout: 120_000 });
// The browser writes the PDF after its launcher exits (Windows): wait until the file exists and stops growing.
await waitForStableFile(pdf, 60_000);
const pages = countPdfPages(readFileSync(pdf));
rmSync(dir, { recursive: true, force: true });
console.log(`wrote docs/WRITEUP.pdf (${pages} page(s))`);
if (pages > 3) process.exitCode = 1;
