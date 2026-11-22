// Scenario harness: runs a fixed task end to end against the real fixture (fixtures/flask at 3.1.3),
// real TrueForge, real models and the real MCP server. Only the human is scripted: the tool approver and
// the hunk reviewer. Verification uses real commands (python, pytest, flask CLI) in the fixture.
import * as cp from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EditorSelection, composePrompt, selectContext, ContextReport } from '../../src/index/context';
import { IndexService } from '../../src/index/service';
import type { RepoIndex } from '../../src/index/types';
import { Decision, ReviewRequest, WriteGate } from '../../src/mcp/gate';
import { NodeReadFs } from '../../src/mcp/nodeFs';
import { startMcpServer } from '../../src/mcp/server';
import { Plan, PlanStore, TestResult, createHandlers } from '../../src/mcp/tools';
import { ReadBudget } from '../../src/mcp/budget';
import { pythonSyntaxCheck } from '../../src/mcp/pySyntax';
import { agentsApi, cancelSession, createClient, createSession, describeError, ensureAgents, registerEditorServer, sessionDriver } from '../../src/trueforge/client';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { CodeCraftConfig, FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateConfig } from '../../src/trueforge/config';
import { failoverBanner, failureMessage } from '../../src/trueforge/errors';
import { autoResponder } from '../../src/trueforge/autoAnswer';
import { AgentAttempt, SwitchInfo, runWithFailover } from '../../src/trueforge/failover';
import type { RunOutcome } from '../../src/trueforge/run';
import { redact } from '../../src/util/redact';
import { DiskApplier, acceptAll, rejectAll } from '../helpers';

export const FIXTURE_COMMIT = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
// Canonical path (upper-case drive letter on Windows): Flask's CLI tests compare paths case-sensitively.
// (Resolved only when the fixture exists, so modules that import the harness still load in a fresh clone.)
const FIXTURE_DIR = path.resolve('fixtures/flask');
export const ROOT = fs.existsSync(FIXTURE_DIR) ? fs.realpathSync.native(FIXTURE_DIR) : FIXTURE_DIR;
export const PY = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export interface Proc {
  code: number;
  stdout: string;
  stderr: string;
}

export function sh(cmd: string, args: string[], opts: { env?: Record<string, string | undefined>; timeoutMs?: number; input?: string; cwd?: string } = {}): Promise<Proc> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 300_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

export const git = (...args: string[]) => sh('git', args);

/** Changed or untracked files in the fixture, ignoring the venv and Python bytecode caches. */
export async function changedFiles(): Promise<string[]> {
  const r = await git('status', '--porcelain', '--untracked-files=all');
  return r.stdout
    .split('\n')
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((p) => p && !p.startsWith('.venv/') && !p.includes('__pycache__/') && !p.endsWith('.pyc'))
    .sort();
}

export async function resetFixture(): Promise<void> {
  await git('checkout', '--', '.');
  await git('clean', '-fdq', '-e', '.venv');
}

export async function pytest(args: string[] = []): Promise<{ passed: number; failed: number; errors: number; summary: string; proc: Proc }> {
  const proc = await sh(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...args], { timeoutMs: 600_000 });
  const last = proc.stdout.trim().split('\n').pop() ?? '';
  const num = (re: RegExp) => Number(re.exec(last)?.[1] ?? 0);
  return { passed: num(/(\d+) passed/), failed: num(/(\d+) failed/), errors: num(/(\d+) errors?/), summary: last, proc };
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RunRecord {
  scenario: string;
  run: number;
  startedAt: string;
  durationMs: number;
  outcome: RunOutcome;
  finalAgent: string;
  switches: SwitchInfo[];
  sessions: Array<{ agent: string; id: string }>;
  tokens: number;
  approvals: string[];
  review: Array<{ plan: string; groups: string[] }>;
  activity: string[];
  filesRead: string[];
  totalFiles: number;
  context: ContextReport;
  changed: string[];
  maxEventLoopLagMs: number;
  /** Every plan the agent submitted, with how many reviews had happened before it. */
  plans: Array<{ plan: Plan; reviewsBefore: number }>;
  /** Same-agent retries after transient provider errors. */
  retries: string[];
  /** What the user sees on an automatic switch (plain words). */
  banners: string[];
  /** State captured at the moment of each switch. */
  atSwitch: Array<{ changed: string[]; approvalsBefore: number; reviewsBefore: number }>;
  /** What the user sees when the run fails with no fallback left. */
  failureMessage?: string;
  /** Ask-user questions answered automatically (non-interactive run): the question and the fixed reply. */
  autoAnswers?: Array<{ question: string; reply: string }>;
  checks: Check[];
  pass: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  /** The instruction exactly as the task states it. */
  prompt: string;
  selection?: (index: RepoIndex) => EditorSelection;
  /** The scripted human: accept or reject every hunk. */
  review: 'accept' | 'reject';
  /** Which agents to try, in order (default: real primary then real fallback). */
  agents?: (h: { client: TrueForge; cfg: CodeCraftConfig; real: (agent: string, model: string) => AgentAttempt }) => Promise<AgentAttempt[]> | AgentAttempt[];
  verify: (run: Omit<RunRecord, 'checks' | 'pass'>) => Promise<Check[]>;
}

const BUDGET = 6000;
/** Fixed port and a token reused across runs, so TrueForge never holds a stale URL or token (see server.ts). */
const SCENARIO_MCP_PORT = 8792;
function scenarioToken(): string {
  const file = path.join(os.tmpdir(), 'codecraft-scenario-mcp-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch {
    /* create below */
  }
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}
// Safety net for the harness (not a task check). Task B under Gemini's free-tier per-minute token quota
// (250k input tokens/min) legitimately needed more than 15 minutes in one run on 2026-11-21.
const RUN_LIMIT_MS = 25 * 60_000;

export async function runScenario(s: Scenario, runNo: number, log: (l: string) => void): Promise<RunRecord> {
  const started = Date.now();
  // Pre-flight: exact fixture commit and a clean tree.
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  if (head !== FIXTURE_COMMIT) throw new Error(`fixtures/flask is at ${head}, expected ${FIXTURE_COMMIT}`);
  await resetFixture();
  const pre = await changedFiles();
  if (pre.length) throw new Error(`fixture not clean before the run: ${pre.join(', ')}`);

  // Event-loop responsiveness probe (a stand-in for "the editor stays responsive").
  let maxLag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 50);
    last = now;
  }, 50);

  const cfg = validateConfig({});
  const client = createClient(cfg);
  const fsRead = new NodeReadFs(ROOT);
  const review: RunRecord['review'] = [];
  const reviewer = {
    async review(req: ReviewRequest): Promise<Record<string, Decision>> {
      review.push({ plan: redact(req.plan).slice(0, 600), groups: req.groups.map((g) => `${g.intent}: ${g.files.map((f) => `${f.path} (${f.hunks.length} hunk${f.hunks.length === 1 ? '' : 's'})`).join(', ')}`) });
      return s.review === 'accept' ? acceptAll(req) : rejectAll(req);
    },
  };
  const gate = new WriteGate(fsRead, new DiskApplier(ROOT), reviewer);
  const index = new IndexService(ROOT, undefined);
  const filesRead = new Set<string>();
  const activity: string[] = [];
  const tests = {
    async run(): Promise<TestResult> {
      const r = await pytest();
      activity.push(`run_tests: ${r.summary}`);
      return { ran: true, exitCode: r.proc.code, output: (r.proc.stdout + r.proc.stderr).slice(-8000) };
    },
  };
  const planStore = new PlanStore();
  const plans: Array<{ plan: Plan; reviewsBefore: number }> = [];
  const handlers = createHandlers({
    fs: fsRead,
    gate,
    tests,
    index,
    plan: planStore,
    budget: new ReadBudget(), // per run, as in the extension
    syntaxCheck: pythonSyntaxCheck(PY), // proposed .py files must compile (in memory) before review
    onPlan: (p) => {
      plans.push({ plan: p, reviewsBefore: review.length });
      log(`PLAN: ${p.summary} | ${p.files.map((f) => `${f.action} ${f.path} (${f.why})`).join(' | ')}`);
    },
    onActivity: (l) => activity.push(l),
    onRead: (p) => filesRead.add(p),
  });
  const server = await startMcpServer(handlers, scenarioToken(), SCENARIO_MCP_PORT);

  const sessions: RunRecord['sessions'] = [];
  const approvals: string[] = [];
  let tokens = 0;
  let outcome: RunOutcome = { status: 'error', message: 'not started', rounds: 0 };
  let finalAgent = '';
  let switches: SwitchInfo[] = [];
  let context: ContextReport = { budgetTokens: BUDGET, usedTokens: 0, totalFiles: 0, items: [], unresolved: [] };
  let totalFiles = 0;
  const banners: string[] = [];
  const retries: string[] = [];
  const autoAnswers: Array<{ question: string; reply: string }> = [];
  const atSwitch: Array<Promise<RunRecord['atSwitch'][number]>> = [];
  let attemptsUsed: AgentAttempt[] = [];
  try {
    await registerEditorServer(client, server.url, scenarioToken());
    log(`ensureAgents: ${JSON.stringify(await ensureAgents(agentsApi(client), cfg))}`);
    const idx = await index.get();
    totalFiles = idx.stats.totalFiles;
    const sel = s.selection?.(idx);
    const ctx = await selectContext({ index: idx, text: s.prompt, budgetTokens: BUDGET, read: (p) => fsRead.read(p), selection: sel });
    context = ctx.report;
    log(`context: ${ctx.report.items.filter((i) => i.included).map((i) => `${i.path} [${i.reason}] ~${i.tokens}t`).join('; ') || '(none)'}`);

    const real = (agent: string, model: string): AgentAttempt => ({
      agent,
      model,
      driver: async () => {
        const id = await createSession(client, agent);
        sessions.push({ agent, id });
        log(`session ${id} (agent ${agent}, model ${model}): ${cfg.baseUrl}/api/v1/sessions/${id}`);
        return sessionDriver(client, id);
      },
    });
    const attempts = s.agents ? await s.agents({ client, cfg, real }) : [real(PRIMARY_AGENT_NAME, cfg.primaryModel), real(FALLBACK_AGENT_NAME, cfg.fallbackModel)];
    attemptsUsed = attempts;
    // Time limit: abort locally AND cancel every session server-side so nothing keeps spending quota.
    const ac = new AbortController();
    const limit = setTimeout(() => {
      log(`TIME LIMIT ${RUN_LIMIT_MS / 60000} min reached: aborting and cancelling sessions`);
      ac.abort();
      for (const sess of sessions) void cancelSession(client, sess.id).catch(() => undefined);
    }, RUN_LIMIT_MS);
    const result = await runWithFailover(composePrompt(ctx.contextText, s.prompt), attempts, {
      signal: ac.signal,
      // nobody can answer the agent's questions here: a fixed reply, logged; the third question stops the run
      responder: autoResponder((q, reply, n) => {
        autoAnswers.push({ question: q.question ?? '', reply });
        log(`AUTO-ANSWER #${n}: "${(q.question ?? '').slice(0, 200)}" -> "${reply}"`);
      }),
      approver: {
        async approve(call) {
          approvals.push(`${call.name}: ${call.summary}`);
          log(`approval: ${call.name} ${call.summary.slice(0, 200)}`);
          return { allow: true };
        },
      },
      onRetry: (r) => {
        retries.push(`${r.agent} retry ${r.retry} after ${Math.round(r.delayMs / 1000)} s: ${r.reason.slice(0, 120)}`);
        log(`RETRY ${r.agent} #${r.retry} in ${Math.round(r.delayMs / 1000)} s: ${r.reason.slice(0, 160)}`);
      },
      onSwitch: (sw) => {
        const banner = failoverBanner(sw.fromModel, sw.toModel, sw.reason);
        banners.push(banner);
        const approvalsBefore = approvals.length;
        const reviewsBefore = review.length;
        atSwitch.push(changedFiles().then((changed) => ({ changed, approvalsBefore, reviewsBefore })));
        log(`FAILOVER ${sw.from} -> ${sw.to}: ${sw.reason.slice(0, 300)}`);
        log(`BANNER: ${banner}`);
      },
      onEvent: (ev) => {
        if (ev.type === 'turn.done') {
          const m = (ev.state as { metrics?: { totalTokens?: number } }).metrics;
          tokens += m?.totalTokens ?? 0;
        }
      },
    });
    clearTimeout(limit);
    outcome = result.outcome;
    finalAgent = result.agent;
    switches = result.switches;
  } catch (e) {
    outcome = { status: 'error', message: redact(describeError(e)), rounds: 0 };
  } finally {
    clearInterval(probe);
    await server.close();
  }

  const changed = await changedFiles();
  const finalModel = attemptsUsed.find((a) => a.agent === finalAgent)?.model ?? finalAgent;
  const failMsg = outcome.status === 'error' ? failureMessage(finalModel, outcome.message, gate.filesAppliedSince(0)) : undefined;
  if (failMsg) log(`FAILURE MESSAGE: ${failMsg}`);
  const base: Omit<RunRecord, 'checks' | 'pass'> = {
    scenario: s.id,
    run: runNo,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    outcome,
    finalAgent,
    switches,
    sessions,
    tokens,
    approvals,
    review,
    activity,
    filesRead: [...filesRead].sort(),
    totalFiles,
    context,
    changed,
    maxEventLoopLagMs: Math.round(maxLag),
    banners,
    plans,
    retries,
    atSwitch: await Promise.all(atSwitch),
    ...(failMsg ? { failureMessage: failMsg } : {}),
    ...(autoAnswers.length ? { autoAnswers } : {}),
  };
  let checks: Check[];
  try {
    checks = await s.verify(base);
  } catch (e) {
    checks = [{ name: 'verification ran', pass: false, detail: describeError(e) }];
  }
  await resetFixture();
  const post = await changedFiles();
  checks.push({ name: 'fixture reset to clean after the run', pass: post.length === 0, detail: post.join(', ') || 'clean' });
  base.durationMs = Date.now() - started;
  return { ...base, checks, pass: checks.every((c) => c.pass) };
}

/** Markdown summary row for docs/RESULTS.md (real values only). */
export function summaryRow(r: RunRecord): string {
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.name);
  const included = r.context.items.filter((i) => i.included).map((i) => i.path);
  return `| ${r.scenario} | ${r.run} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.finalAgent || '-'}${r.switches.length ? ` (failover x${r.switches.length})` : ''} | ${r.changed.join('<br>') || '(none)'} | ${included.join('<br>') || '(none)'} | ${r.filesRead.length}/${r.totalFiles} | ${r.tokens || 'n/a'} | ${Math.round(r.durationMs / 1000)} s | ${r.maxEventLoopLagMs} ms | ${failed.join('; ') || '-'} |`;
}
