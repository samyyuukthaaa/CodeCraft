// Runs inside the webview. Read-only view: it renders sanitized events with textContent only
// and sends one narrowly typed message to the host.
import type { HostToWebview } from '../panel/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;
const answer = document.getElementById('answer') as HTMLElement;
const events = document.getElementById('events') as HTMLElement;
const MAX_ROWS = 500;
const ctxSummary = document.getElementById('context-summary') as HTMLElement;
const ctxRows = document.getElementById('context-rows') as HTMLElement;
const reads = document.getElementById('reads') as HTMLElement;

function cell(row: HTMLElement, text: string, cls?: string): void {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  row.appendChild(td);
}

send.addEventListener('click', () => {
  answer.textContent = '';
  vscode.postMessage({ type: 'prompt', text: prompt.value });
});

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  if (m.type === 'status') {
    send.disabled = m.state === 'running';
    status.textContent = m.note ? `${m.state}: ${m.note}` : m.state;
    return;
  }
  if (m.type === 'context') {
    const r = m.report;
    const inc = r.items.filter((i) => i.included);
    ctxSummary.textContent = `${inc.length} file(s), about ${r.usedTokens} of ${r.budgetTokens} tokens (estimated), from ${r.totalFiles} indexed files.` + (r.unresolved.length ? ` Not found: ${r.unresolved.join(', ')}.` : '');
    ctxRows.textContent = '';
    for (const it of r.items) {
      const tr = document.createElement('tr');
      if (!it.included) tr.className = 'excluded';
      cell(tr, it.included ? it.path : `${it.path} (not included)`);
      cell(tr, it.reason);
      cell(tr, String(it.tokens), 'num');
      ctxRows.appendChild(tr);
    }
    reads.textContent = '';
    return;
  }
  if (m.type === 'reads') {
    reads.textContent = `Files read by the agent: ${m.read} of ${m.total}` + (m.paths.length ? ` (${m.paths.slice(0, 8).join(', ')}${m.paths.length > 8 ? ', ...' : ''})` : '');
    return;
  }
  if (m.type === 'event') {
    const ev = m.event;
    if (ev.delta) {
      answer.textContent = (answer.textContent ?? '') + ev.delta;
      return;
    }
    const li = document.createElement('li');
    li.textContent = ev.summary ? `${ev.type}  ${ev.summary}` : ev.type;
    if (ev.failed) li.className = 'failed';
    events.appendChild(li);
    while (events.childElementCount > MAX_ROWS) events.removeChild(events.firstElementChild as Element);
  }
});
