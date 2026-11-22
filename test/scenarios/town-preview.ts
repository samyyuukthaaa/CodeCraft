// Dev tool: renders the REAL Code Town webview (out/codetown.js + buildTownHtml) in headless Edge/Chrome with a
// stub VS Code API, fed with the real index of a workspace (default fixtures/flask) and, optionally, the town
// events of a journal file. Writes a screenshot; with --measure also frame rate and JS heap numbers.
// Usage: node out/scenarios/town-preview.js [--root fixtures/flask] [--journal file.jsonl] [--out out/town-preview/shot.png]
//        [--events demo] [--measure] [--size 1400,900] [--budget 6000]
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndexService } from '../../src/index/service';
import type { JournalEntry } from '../../src/journal/journal';
import { townEventsFromJournal } from '../../src/town/fromJournal';
import { buildTownHtml } from '../../src/town/html';
import { foldEvents, initialSceneState, sceneReducer } from '../../src/town/reducer';
import type { TownEvent } from '../../src/town/types';
import { cdp } from './town-perf';

const arg = (name: string, def = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? def) : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** A short, realistic agent run over the Flask fixture (used when no journal is given). */
function demoEvents(at0: number): TownEvent[] {
  let at = at0;
  const t = () => (at += 400);
  return [
    { type: 'run_started', runId: 'demo', request: 'Add a --env-file option', at: t() },
    { type: 'file_planned', path: 'src/flask/cli.py', action: 'edit', why: 'the run command and its options live here', at: t() },
    { type: 'file_planned', path: 'tests/test_cli.py', action: 'edit', at: t() },
    { type: 'file_planned', path: 'docs/cli.rst', action: 'edit', at: t() },
    { type: 'file_read', path: 'src/flask/cli.py', at: t() },
    { type: 'file_read', path: 'src/flask/helpers.py', at: t() },
    { type: 'provider', status: 'retrying', model: 'google-gemini/primary', detail: 'rate limit', at: t() },
    { type: 'provider', status: 'failed_over', model: 'google-gemini/fallback', detail: 'from primary', at: t() },
    { type: 'file_read', path: 'tests/test_cli.py', at: t() },
    { type: 'hunk_proposed', path: 'src/flask/cli.py', intent: 'implement', hunks: 3, reason: 'add the --env-file option to flask run', at: t() },
    { type: 'hunk_proposed', path: 'tests/test_cli.py', intent: 'add test', hunks: 1, at: t() },
    { type: 'hunk_proposed', path: 'docs/cli.rst', intent: 'docs', hunks: 1, at: t() },
    { type: 'hunk_decided', path: 'src/flask/cli.py', accepted: 3, rejected: 0, at: t() },
    { type: 'hunk_decided', path: 'tests/test_cli.py', accepted: 1, rejected: 0, at: t() },
    { type: 'hunk_decided', path: 'docs/cli.rst', accepted: 0, rejected: 1, at: t() },
    { type: 'file_written', path: 'src/flask/cli.py', opId: 'op1', accepted: 3, rejected: 0, created: false, at: t() },
    { type: 'file_note', path: 'src/flask/cli.py', reason: 'flask run needs to load a chosen .env file', plain: 'This lets you pick which settings file Flask loads when it starts.', confidence: 'check this', at: t() },
    { type: 'file_written', path: 'tests/test_cli.py', opId: 'op1', accepted: 1, rejected: 0, created: false, at: t() },
    { type: 'test_run', passed: false, failing: ['tests/test_cli.py::test_env_file'], phase: 'after', at: t() },
    { type: 'file_written', path: 'src/flask/cli.py', opId: 'op2', accepted: 1, rejected: 0, created: false, at: t() },
    { type: 'test_run', passed: true, failing: [], phase: 'after_fix', at: t() },
    { type: 'provider', status: 'recovered', model: 'google-gemini/primary', at: t() },
    { type: 'file_read', path: 'src/flask/cli.py', at: t() },
  ];
}

async function main(): Promise<void> {
  const root = path.resolve(arg('root', 'fixtures/flask'));
  const outFile = path.resolve(arg('out', 'out/town-preview/shot.png'));
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });
  const index = await new IndexService(root, undefined).get();
  const files = Object.values(index.files).map((f) => ({ path: f.path, lines: f.lines, size: f.size, language: f.language, isTest: f.isTest, imports: f.imports }));
  let events: TownEvent[] = [];
  const journal = arg('journal');
  if (journal) {
    const entries = fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
    events = townEventsFromJournal(entries, arg('run') || undefined);
  } else if (arg('events') === 'demo') events = demoEvents(1_700_000_000_000);
  const live = has('live'); // stream the events into the page one by one (like a running agent) instead of pre-folding
  const init: TownEvent = { type: 'init', files, at: 0 };
  const start = sceneReducer(initialSceneState(), init);
  const state = live ? start : foldEvents(start, events);

  fs.copyFileSync(path.resolve('out/codetown.js'), path.join(dir, 'codetown.js'));
  const measure = has('measure');
  fs.writeFileSync(
    path.join(dir, 'stub.js'),
    `window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__sent = (window.__sent || []).concat([m]);
  if (m.type === 'replay_run') setTimeout(() => window.postMessage({ type: 'replay', runId: 'ab12ab12ab12ab12', base: window.__base, events: window.__replay }, '*'), 10); } });
window.__base = ${JSON.stringify(has('replay') ? start : null)};
window.__replay = ${JSON.stringify(has('replay') ? events : [])};
window.__state = ${JSON.stringify(state)};
window.__events = ${JSON.stringify(live ? events : [])};
window.addEventListener('load', () => {
  window.postMessage({ type: 'scene', state: window.__state }, '*');
  ${has('replay') ? `window.postMessage({ type: 'runs', runs: [{ runId: 'ab12ab12ab12ab12', request: 'Add a --env-file option', at: 1700000000000, status: 'done' }] }, '*'); setTimeout(() => document.getElementById('btn-replay').click(), 300);` : ''}
  ${arg('mode') ? `setTimeout(() => document.getElementById('mode-${arg('mode')}').click(), 100);` : ''}
  ${arg('inspect') ? `setTimeout(() => window.postMessage({ type: 'focus', path: ${JSON.stringify(arg('inspect'))} }, '*'), 150);` : ''}
  ${arg('ask') ? `setTimeout(() => { document.getElementById('ask-toggle').click(); document.getElementById('ask-input').value = ${JSON.stringify(arg('ask'))}; document.getElementById('ask-form').requestSubmit(); }, 250);` : ''}
  const evs = window.__events; let i = 0;
  const step = () => { if (i < evs.length) { window.postMessage({ type: 'event', event: evs[i++] }, '*'); setTimeout(step, ${Number(arg('interval', '60'))}); } };
  setTimeout(step, 200);
  ${
    measure
      ? `let frames = 0, worst = 0, last = performance.now(); const t0 = last; const lag = [];
  const f = (now) => { frames++; worst = Math.max(worst, now - last); lag.push(now - last); last = now; if (now - t0 < ${Number(arg('window', '5000'))}) requestAnimationFrame(f); else {
    const mem = performance.memory ? performance.memory.usedJSHeapSize : -1; lag.sort((a, b) => a - b);
    document.title = 'MEASURE ' + JSON.stringify({ frames, seconds: (now - t0) / 1000, fps: frames / ((now - t0) / 1000), p95FrameMs: lag[Math.floor(lag.length * 0.95)], worstFrameMs: worst, heapMB: mem / 1048576, buildings: Object.keys(window.__state.buildings).length, events: evs.length }); } };
  requestAnimationFrame(f);`
      : ''
  }
});`,
  );
  // --motion on|off|auto (default off: headless browsers may report reduced motion)
  const html = buildTownHtml({ cspSource: 'file:', nonce: 'N', scriptUri: 'codetown.js', reducedMotion: (arg('motion', 'off') as 'on' | 'off' | 'auto'), scout: arg('scout', 'on') === 'muted' ? 'muted' : 'on' }).replace('<script nonce="N" src="codetown.js">', '<script nonce="N" src="stub.js"></script>\n  <script nonce="N" src="codetown.js">');
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, html);

  const browsers = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const browser = browsers.find((b) => fs.existsSync(b));
  if (!browser) throw new Error('no Edge/Chrome found');
  const size = arg('size', '1400,900');
  // --nowebgl: a browser without WebGL, to check the 2D fallback
  const gl = has('nowebgl') ? ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const common = ['--headless=new', '--hide-scrollbars', ...gl, '--enable-precise-memory-info', `--window-size=${size}`, '--allow-file-access-from-files', `--user-data-dir=${path.join(dir, 'profile')}`];
  const url = `file:///${page.replace(/\\/g, '/')}`;
  const budget = arg('budget', measure ? String(Number(arg('window', '5000')) + 4000) : '6000');
  if (arg('realtime')) {
    // --realtime <seconds>: REAL time (virtual time runs too few animation frames for walks): open the page over
    // the DevTools protocol, wait, print the stats (incl. Scout), take the screenshot, then close the browser.
    const port = 9600 + Math.floor(Math.random() * 300);
    const child = cp.spawn(browser, [...common, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
    try {
      let ws = '';
      for (let i = 0; i < 60 && !ws; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
          ws = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
        } catch {
          // not up yet
        }
      }
      if (!ws) throw new Error('the browser did not open a debugging port');
      const c = await cdp(ws);
      if (arg('click')) {
        // --click <id>: press a panel button 1.5 s after load (e.g. btn-find-scout)
        await new Promise((r) => setTimeout(r, 1500));
        await c.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(arg('click'))})?.click()` });
      }
      await new Promise((r) => setTimeout(r, Number(arg('realtime')) * 1000));
      const stats = (await c.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__townStats && window.__townStats())', returnByValue: true })).result?.value;
      console.log('stats', String(stats));
      const shot = (await c.send('Page.captureScreenshot', { format: 'png' })) as unknown as { data?: string };
      if (shot.data) fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
      c.close();
    } finally {
      try {
        const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
        if (v.webSocketDebuggerUrl) void (await cdp(v.webSocketDebuggerUrl)).send('Browser.close');
      } catch {
        // closed
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // gone
        }
      }
    }
    console.log(`${files.length} files, ${events.length} events -> ${outFile} (real time ${arg('realtime')} s)`);
    return;
  }
  if (has('probe')) {
    // --probe: print the page's stats (incl. Scout's position) shortly before the time budget ends
    fs.appendFileSync(path.join(dir, 'stub.js'), `\nwindow.addEventListener('load', () => setTimeout(() => { document.title = 'PROBE ' + JSON.stringify(window.__townStats && window.__townStats()); }, ${Number(budget) - 800}));\n`);
    const dom = cp.execFileSync(browser, [...common, `--virtual-time-budget=${budget}`, '--dump-dom', url], { encoding: 'utf8', timeout: 180_000 });
    console.log((/PROBE ([^<]*)/.exec(dom)?.[1] ?? 'no probe').replace(/&quot;/g, '"'));
  }
  if (measure) {
    const dom = cp.execFileSync(browser, [...common, `--virtual-time-budget=${budget}`, '--run-all-compositor-stages-before-draw', '--dump-dom', url], { encoding: 'utf8', timeout: 180_000 });
    const m = /MEASURE (\{[^<]*\})/.exec(dom);
    console.log(m ? m[1] : 'no measurement in the page title');
  }
  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  cp.execFileSync(browser, [...common, `--virtual-time-budget=${budget}`, `--screenshot=${outFile}`, url], { stdio: 'ignore', timeout: 180_000 });
  // the browser writes the file after its launcher exits: wait for it (and let it settle) before returning
  for (let i = 0; i < 120 && !fs.existsSync(outFile); i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`${files.length} files, ${events.length} events -> ${outFile}`);
}
main().catch((e) => {
  console.error('FAILED', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
