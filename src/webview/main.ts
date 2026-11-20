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
