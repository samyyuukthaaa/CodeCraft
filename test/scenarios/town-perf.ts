// Frame-rate and memory check for Code Town (step 6). Opens the REAL webview (out/codetown.js) in headless
// Edge/Chrome over the real index of fixtures/flask, then streams the events of the RECORDED task2 run
// (docs/results/task2-*.json: its tool activity, retries, failover, applied changes and test runs) in REAL time,
// compressed into --seconds (default 60; the recorded run took ~9 minutes, so this is a harder load).
// Samples every 5 s through the Chrome DevTools Protocol: frames per second, JS heap, GPU resources (geometries,
// textures), draw calls, scene-graph rebuilds. No virtual time: these are wall-clock numbers.
// Usage: node out/scenarios/town-perf.js [--record docs/results/task2-....json] [--seconds 60] [--gpu software|hardware]
//        [--motion auto|on|off] [--size 1400,900]
// --patrol: no run at all, Scout patrols the idle town for --seconds; samples every 30 s, plus the JS heap after a
//           forced garbage collection at the start and at the end (a leak shows up as growth there).
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndexService } from '../../src/index/service';
import { buildTownHtml } from '../../src/town/html';
import { initialSceneState, sceneReducer } from '../../src/town/reducer';
import type { TownEvent } from '../../src/town/types';

const arg = (name: string, def = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? def) : def;
};

interface Record {
  startedAt: string;
  durationMs: number;
  activity: string[];
  retries: string[];
  switches: Array<{ fromModel: string; toModel: string }>;
  plans: Array<{ plan: { files: Array<{ path: string; action: string; why: string }> } }>;
}

/** The recorded run as town events, in the record's order (retries and the failover came first in that run). */
export function eventsFromRecord(rec: Record, t0: number): TownEvent[] {
  const evs: TownEvent[] = [];
  let at = t0;
  const t = () => (at += 1000);
  evs.push({ type: 'run_started', runId: 'task2-recorded', request: 'task2 (recorded run)', at: t() });
  for (const r of rec.retries) evs.push({ type: 'provider', status: 'retrying', model: rec.switches[0]?.fromModel, detail: r.slice(0, 60), at: t() });
  for (const s of rec.switches) evs.push({ type: 'provider', status: 'failed_over', model: s.toModel, detail: `from ${s.fromModel}`, at: t() });
  let proposed: string[] = [];
  for (const line of rec.activity) {
    let m: RegExpExecArray | null;
    if ((m = /^read_file (\S+)/.exec(line))) evs.push({ type: 'file_read', path: m[1]!, at: t() });
    else if (line.startsWith('submit_plan ')) {
      for (const f of line.slice('submit_plan '.length).split(', ')) {
        const [action, p] = f.split(':') as [string, string];
        if (action === 'edit' || action === 'create') evs.push({ type: 'file_planned', path: p, action, at: t() });
      }
    } else if ((m = /^propose_changes (?!->)(.*)$/.exec(line))) {
      proposed = [...m[1]!.matchAll(/\(([^)]+)\)/g)].map((x) => x[1]!).filter((p) => /\.\w+$/.test(p));
      for (const p of proposed) evs.push({ type: 'hunk_proposed', path: p, intent: 'change', hunks: 1, at: t() });
    } else if (/^propose_changes -> (applied|partially_applied)/.test(line)) {
      for (const p of proposed) evs.push({ type: 'hunk_decided', path: p, accepted: 1, rejected: 0, at: t() });
      for (const p of proposed) evs.push({ type: 'file_written', path: p, opId: `op${evs.length}`, accepted: 1, rejected: 0, created: false, at: t() });
    } else if ((m = /^run_tests: (.*)$/.exec(line))) {
      const failed = /(\d+) failed/.exec(m[1]!);
      evs.push({ type: 'test_run', passed: !failed, failing: failed ? ['(the test command)'] : [], phase: 'agent', at: t() });
    }
  }
  evs.push({ type: 'run_finished', status: 'done', at: t() });
  return evs;
}

export async function cdp(wsUrl: string): Promise<{ send: (method: string, params?: object) => Promise<{ result?: { value?: unknown } }>; close: () => void }> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('CDP connection failed'));
  });
  let id = 0;
  const waiting = new Map<number, (v: unknown) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        waiting.set(n, res as (v: unknown) => void);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main(): Promise<void> {
  const recPath = arg('record') || path.join('docs/results', fs.readdirSync('docs/results').filter((f) => f.startsWith('task2-')).sort().at(-1)!);
  const rec = (JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record[])[0]!;
  const seconds = Number(arg('seconds', '60'));
  const patrol = process.argv.includes('--patrol');
  const dir = path.resolve('out/town-perf');
  fs.mkdirSync(dir, { recursive: true });
  const index = await new IndexService(path.resolve('fixtures/flask'), undefined).get();
  const files = Object.values(index.files).map((f) => ({ path: f.path, lines: f.lines, size: f.size, language: f.language, isTest: f.isTest, imports: f.imports }));
  const events = eventsFromRecord(rec, Date.parse(rec.startedAt));
  const state = sceneReducer(initialSceneState(), { type: 'init', files, at: 0 });
  // --bundle: measure another build of the webview (e.g. main's) with the same harness
  fs.copyFileSync(path.resolve(arg('bundle', 'out/codetown.js')), path.join(dir, 'codetown.js'));
  const interval = (seconds * 1000) / events.length;
  const streamed = patrol ? [] : events;
  const every = patrol ? 30000 : 5000;
  fs.writeFileSync(
    path.join(dir, 'stub.js'),
    `window.acquireVsCodeApi = () => ({ postMessage: () => {} });
window.__perf = [];
window.addEventListener('load', () => {
  window.postMessage({ type: 'scene', state: ${JSON.stringify(state)} }, '*');
  const evs = ${JSON.stringify(streamed)}; let i = 0;
  const t0 = performance.now(); let lastFrames = 0, lastT = t0;
  const sample = (phase) => { const s = window.__townStats(); const now = performance.now();
    window.__perf.push({ t: Math.round((now - t0) / 1000), phase, events: i, fps: Math.round(((s.frames - lastFrames) / ((now - lastT) / 1000)) * 10) / 10,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 104857.6) / 10 : -1, geometries: s.geometries, textures: s.textures,
      drawCalls: s.drawCalls, rebuilds: s.graph && s.graph.rebuilds, incremental: s.graph && s.graph.incremental, rendered: s.renderedFrames, listeners: s.listeners, scoutAt: s.scout && s.scout.at, scoutWalking: s.scout && s.scout.animating });
    lastFrames = s.frames; lastT = now; };
  setTimeout(() => sample('idle (before the run)'), 4000);
  setTimeout(() => {
    const iv = setInterval(() => { if (i < evs.length) window.postMessage({ type: 'event', event: evs[i++] }, '*'); else clearInterval(iv); }, ${interval});
    const sv = setInterval(() => sample(${patrol} ? 'Scout patrolling' : i < evs.length ? 'task2 streaming' : 'after the run'), ${every});
    setTimeout(() => { clearInterval(sv); sample(${patrol} ? 'Scout patrolling (end)' : 'after the run'); document.title = 'PERF DONE'; }, ${seconds * 1000 + (patrol ? 0 : 10000)});
  }, 5000);
});`,
  );
  const html = buildTownHtml({ cspSource: 'file:', nonce: 'N', scriptUri: 'codetown.js', reducedMotion: (arg('motion', 'off') as 'on' | 'off' | 'auto'), scout: arg('scout', 'on') === 'muted' ? 'muted' : 'on' }).replace(
    '<script nonce="N" src="codetown.js">',
    '<script nonce="N" src="stub.js"></script>\n  <script nonce="N" src="codetown.js">',
  );
  fs.writeFileSync(path.join(dir, 'index.html'), html);

  const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((b) => fs.existsSync(b));
  if (!browser) throw new Error('no Edge/Chrome found');
  const port = 9333 + Math.floor(Math.random() * 200);
  const gpu = arg('gpu', 'hardware');
  const flags = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(dir, `profile-${port}`)}`,
    `--window-size=${arg('size', '1400,900')}`,
    '--enable-precise-memory-info',
    '--allow-file-access-from-files',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(gpu === 'software' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']),
    `file:///${path.join(dir, 'index.html').replace(/\\/g, '/')}`,
  ];
  const child = cp.spawn(browser, flags, { stdio: 'ignore' });
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
    // heap after a forced GC (patrol mode): once the town is up, and again at the end
    const gcHeap = async (): Promise<number> => {
      await c.send('HeapProfiler.collectGarbage', {});
      const v = (await c.send('Runtime.evaluate', { expression: 'performance.memory.usedJSHeapSize', returnByValue: true })).result?.value;
      return Math.round(Number(v) / 104857.6) / 10;
    };
    let heapAfterGcStartMB: number | undefined;
    if (patrol) {
      await new Promise((r) => setTimeout(r, 6000));
      heapAfterGcStartMB = await gcHeap();
    }
    const deadline = Date.now() + (seconds + 40) * 1000;
    let title = '';
    while (Date.now() < deadline && title !== 'PERF DONE') {
      await new Promise((r) => setTimeout(r, 2000));
      title = String((await c.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.value ?? '');
    }
    const perf = (await c.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__perf)', returnByValue: true })).result?.value;
    const heapAfterGcEndMB = patrol ? await gcHeap() : undefined;
    const renderer = (await c.send('Runtime.evaluate', {
      expression: "(() => { const g = document.querySelector('canvas')?.getContext('webgl2'); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()",
      returnByValue: true,
    })).result?.value;
    c.close();
    console.log(JSON.stringify({ record: path.basename(recPath), recordedDurationS: Math.round(rec.durationMs / 1000), streamedOverS: seconds, events: events.length, buildings: files.length, gpu, renderer, motion: arg('motion', 'off'), ...(patrol ? { mode: 'scout patrol, no run', heapAfterGcStartMB, heapAfterGcEndMB } : {}), samples: JSON.parse(String(perf ?? '[]')) }, null, 1));
  } finally {
    // Ask the browser to close itself first: on Windows the launched msedge.exe hands off to a broker process that
    // is not its child, so killing the process tree alone left the browser (and its renderers) running.
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      if (v.webSocketDebuggerUrl) {
        const b = await cdp(v.webSocketDebuggerUrl);
        void b.send('Browser.close');
        await new Promise((r) => setTimeout(r, 1500));
        b.close();
      }
    } catch {
      // already closed
    }
    // Then end the WHOLE browser process tree: killing only the launcher left the renderer processes running (observed:
    // 165 orphaned headless Edge processes after repeated runs, which skewed every later measurement).
    if (process.platform === 'win32' && child.pid) {
      try {
        cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    } else child.kill('SIGKILL');
  }
}
// Run only as the town-perf script itself (bundled into other scripts, `require.main === module` would be true there too)
if (/town-perf\.(js|ts)$/.test(process.argv[1] ?? ''))
  main().catch((e) => {
    console.error('FAILED', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
