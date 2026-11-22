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
const readBudget = document.getElementById('read-budget') as HTMLElement;
const planSummary = document.getElementById('plan-summary') as HTMLElement;
const planRows = document.getElementById('plan-rows') as HTMLElement;
const healthRows = document.getElementById('health-rows') as HTMLElement;
const healthNote = document.getElementById('health-note') as HTMLElement;
const testProviders = document.getElementById('test-providers') as HTMLButtonElement;
testProviders.addEventListener('click', () => {
  healthNote.textContent = 'Testing...';
  vscode.postMessage({ type: 'testProviders' });
});
const injectFault = document.getElementById('inject-fault') as HTMLButtonElement;
injectFault.addEventListener('click', () => vscode.postMessage({ type: 'injectFault' }));

// Task templates: fill the prompt box only (the user edits and sends; nothing runs on click).
const TEMPLATES: Record<string, string> = {
  fix: 'Fix the bug in the selected code (select it in the editor first). What goes wrong: <describe it>. What should happen instead: <describe it>.',
  rename: 'Rename <OldName> to <NewName> across all files: update the definition, every import, call and test that uses it, and nothing else.',
  tests: "Add tests for the selected code (or name the function or file here: <name>), following the style of the project's existing tests, then run the tests.",
};
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#tasks button'))) {
  b.addEventListener('click', () => {
    const t = TEMPLATES[b.dataset.task ?? ''];
    if (!t) return;
    prompt.value = t;
    prompt.focus();
    const i = t.indexOf('<');
    if (i >= 0) prompt.setSelectionRange(i, t.indexOf('>', i) + 1);
  });
}

// The agent's question (TrueForge ask_user_question): answer with an option or free text.
const qBox = document.getElementById('question') as HTMLElement;
const qText = document.getElementById('question-text') as HTMLElement;
const qOptions = document.getElementById('question-options') as HTMLElement;
const qInput = document.getElementById('question-input') as HTMLInputElement;
const qSend = document.getElementById('question-send') as HTMLButtonElement;
const sendAnswer = (text: string): void => {
  const t = text.trim();
  if (!t) return;
  vscode.postMessage({ type: 'answer', text: t.slice(0, 2000) });
  qBox.hidden = true;
};
qSend.addEventListener('click', () => sendAnswer(qInput.value));
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAnswer(qInput.value);
});

const warn = document.getElementById('warn') as HTMLElement;
const groupsList = document.getElementById('groups') as HTMLElement;
const rollback = document.getElementById('rollback') as HTMLButtonElement;
rollback.addEventListener('click', () => vscode.postMessage({ type: 'rollback' }));
const exportReport = document.getElementById('export-report') as HTMLButtonElement;
exportReport.addEventListener('click', () => vscode.postMessage({ type: 'exportReport' }));

const mModel = document.getElementById('m-model') as HTMLElement;
const mTokens = document.getElementById('m-tokens') as HTMLElement;
const mElapsed = document.getElementById('m-elapsed') as HTMLElement;
const mFiles = document.getElementById('m-files') as HTMLElement;
let tick: ReturnType<typeof setInterval> | undefined;
const secs = (ms: number): string => `${(ms / 1000).toFixed(0)} s`;

function cell(row: HTMLElement, text: string, cls?: string): void {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  row.appendChild(td);
}

send.addEventListener('click', () => {
  answer.textContent = '';
  planSummary.textContent = 'Waiting for the agent to submit its plan...';
  planRows.textContent = '';
  warn.hidden = true;
  groupsList.textContent = '';
  qBox.hidden = true;
  vscode.postMessage({ type: 'prompt', text: prompt.value });
});

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  if (m.type === 'status') {
    send.disabled = m.state === 'running';
    testProviders.disabled = m.state === 'running';
    injectFault.disabled = m.state === 'running';
    rollback.disabled = m.state === 'running';
    exportReport.disabled = m.state === 'running';
    status.textContent = m.note ? `${m.state}: ${m.note}` : m.state;
    if (m.state === 'idle') qBox.hidden = true;
    return;
  }
  if (m.type === 'question') {
    qText.textContent = m.question;
    qOptions.textContent = '';
    for (const o of m.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.textContent = o;
      b.addEventListener('click', () => sendAnswer(o));
      qOptions.appendChild(b);
    }
    qInput.value = '';
    qBox.hidden = false;
    qInput.focus();
    return;
  }
  if (m.type === 'questionDone') {
    qBox.hidden = true;
    return;
  }
  if (m.type === 'warn') {
    warn.textContent = `Before any edit: planned changes to ${m.files.join(', ') || 'no files'}. Tests that might break: ${m.tests.join(', ') || 'none found'}.`;
    warn.hidden = false;
    return;
  }
  if (m.type === 'groups') {
    groupsList.textContent = '';
    for (const g of m.groups) {
      const li = document.createElement('li');
      const tag = document.createElement('span');
      tag.className = `tag ${g.confidence === 'sure' ? 'sure' : g.confidence === 'risky' ? 'risky' : 'check'}`;
      tag.textContent = g.confidence;
      li.appendChild(tag);
      const head = document.createElement('b');
      head.textContent = `[${g.intent}] ${g.status}`;
      li.appendChild(head);
      for (const line of [g.plain, `Why: ${g.reason}`, `Confidence rule: ${g.why.join('; ')}`, `Tests: ${g.tests}`, `Files: ${g.files.join(', ')}`]) {
        const d = document.createElement('div');
        d.textContent = line;
        li.appendChild(d);
      }
      groupsList.appendChild(li);
    }
    return;
  }
  if (m.type === 'metrics') {
    const x = m.metrics;
    mModel.textContent = x.model;
    mTokens.textContent = x.inputTokens === undefined && x.outputTokens === undefined ? 'not reported yet' : `${x.inputTokens ?? '?'} input, ${x.outputTokens ?? '?'} output${x.costUsd !== undefined ? ` (about $${x.costUsd.toFixed(4)})` : ''}`;
    mFiles.textContent = `${x.read} of ${x.total}`;
    if (tick) clearInterval(tick);
    tick = undefined;
    if (x.elapsedMs !== undefined) mElapsed.textContent = secs(x.elapsedMs);
    else {
      const update = (): void => {
        mElapsed.textContent = `${secs(Date.now() - x.startedAt)} (running)`;
      };
      update();
      tick = setInterval(update, 1000);
    }
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
  if (m.type === 'health') {
    healthRows.textContent = '';
    for (const r of m.rows) {
      const tr = document.createElement('tr');
      cell(tr, r.role);
      cell(tr, r.model);
      cell(tr, r.status === 'paused' && r.retryAt ? `paused until ${r.retryAt.slice(11, 16)} UTC` : r.status, r.status === 'paused' ? 'paused' : undefined);
      cell(tr, r.lastErrorClass ? r.lastErrorClass.replace(/_/g, ' ') : '-');
      cell(tr, r.lastErrorAt ? r.lastErrorAt.replace('T', ' ').slice(0, 16) : '-');
      healthRows.appendChild(tr);
    }
    healthNote.textContent = m.note ?? '';
    return;
  }
  if (m.type === 'plan') {
    planSummary.textContent = m.plan.summary;
    planRows.textContent = '';
    for (const f of m.plan.files) {
      const tr = document.createElement('tr');
      cell(tr, f.path);
      cell(tr, f.action);
      cell(tr, f.why);
      planRows.appendChild(tr);
    }
    return;
  }
  if (m.type === 'budget') {
    const b = m.budget;
    readBudget.textContent = `Read budget this run: read_file ${b.used.read_file} of ${b.limits.read_file}, list_files ${b.used.list_files} of ${b.limits.list_files}, search_text ${b.used.search_text} of ${b.limits.search_text}` + (b.cached ? ` (${b.cached} repeat(s) answered from cache)` : '') + '.';
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
