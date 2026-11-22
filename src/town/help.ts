// "Ask Scout": a built-in help guide for CodeCraft. STATIC knowledge plus the live scene state, matched by simple
// keyword and intent scoring. Pure: no VS Code, no Three.js, no network, no model calls; nothing here can fetch,
// edit a file, run a task or start a run. When it does not know, it says so and points to the README.
import { KIND_VISUALS, POWER_VISUALS } from './grammar';
import { BUILDING_STATES, STATE_VISUALS, SceneState } from './types';

export interface HelpTopic {
  id: string;
  /** Shown as a suggested question. */
  question: string;
  /** Lower-case words or phrases; a phrase match counts double. */
  keywords: string[];
  /** Words that decide the topic on their own (count double). */
  strong?: string[];
  answer: (s: SceneState | undefined) => string;
}

const stateList = (): string => BUILDING_STATES.map((k) => `${STATE_VISUALS[k].icon} ${STATE_VISUALS[k].label}`).join(', ');

export const TOPICS: HelpTopic[] = [
  {
    id: 'colours',
    strong: ['colour', 'colours', 'color', 'colors', 'legend'],
    question: 'What do the building colours mean?',
    keywords: ['colour', 'color', 'colours', 'colors', 'green', 'red', 'orange', 'blue', 'purple', 'grey', 'gray', 'teal', 'state', 'states', 'mean', 'building', 'buildings', 'legend', 'icon'],
    answer: (s) =>
      `Each building is a file. Its colour, icon and label show what the agent did to it in this run: ${stateList()}. ` +
      'Kinds: ' + Object.values(KIND_VISUALS).map((k) => `${k.icon} ${k.label}`).join(', ') + '. ' +
      (s ? `Right now: ${BUILDING_STATES.filter((k) => s.stats[k] > 0 && k !== 'idle').map((k) => `${s.stats[k]} ${STATE_VISUALS[k].label.toLowerCase()}`).join(', ') || 'nothing touched yet'}. ` : '') +
      'The legend (bottom left) lists them all.',
  },
  {
    id: 'review',
    strong: ['hunk', 'hunks', 'review', 'accept', 'reject'],
    question: 'How do I review and accept or reject changes?',
    keywords: ['review', 'accept', 'reject', 'hunk', 'hunks', 'diff', 'approve', 'proposal', 'proposed', 'change', 'changes'],
    answer: () =>
      'When the agent proposes changes, VS Code opens a diff and a review menu. Choose Accept all, Reject all, or Review by group…; inside a group you can review hunk by hunk ' +
      '(accept or reject each). Esc rejects everything not yet decided. Nothing is written until you accept, and only the hunks you accept are written, as one undo step.',
  },
  {
    id: 'undo',
    strong: ['undo', 'rollback', 'revert', 'checkpoint'],
    question: 'How do I undo a change?',
    keywords: ['undo', 'revert', 'rollback', 'roll back', 'checkpoint', 'restore', 'go back', 'mistake'],
    answer: () =>
      'Run "CodeCraft: Undo Last Change" to revert the last applied change set (only if the files are still exactly what CodeCraft wrote). ' +
      'To go further back, "CodeCraft: Roll Back to Checkpoint" (or Roll back… in the agent panel) offers every checkpoint of the last run: before the first change and after each applied group.',
  },
  {
    id: 'stop',
    strong: ['stop', 'cancel', 'abort'],
    question: 'How do I stop a run?',
    keywords: ['stop', 'cancel', 'abort', 'halt', 'kill', 'pause run'],
    answer: () =>
      'Run "CodeCraft: Stop Run" from the Command Palette. It closes an open review, refuses anything still queued, stops the test command and cancels the TrueForge session. ' +
      'Changes you already accepted stay applied (use Undo Last Change to revert them).',
  },
  {
    id: 'failover',
    strong: ['failover', 'fallback', 'outage', 'retrying', 'quota'],
    question: 'How does failover work?',
    keywords: ['failover', 'fail over', 'fallback', 'backup', 'power', 'plant', 'provider', 'retry', 'retrying', 'rate limit', 'quota', 'error', 'outage', 'recovered'],
    answer: (s) =>
      'CodeCraft retries a temporary provider problem a few times (rate limits wait for the hint the provider gives; outages retry twice). If the main model still fails, or its key is rejected, ' +
      'it switches to the fallback model and continues the same task; changes you accepted stay applied. A per-provider circuit breaker pauses a failing provider for a while. ' +
      `The power plant shows this: ${Object.values(POWER_VISUALS).map((p) => `${p.icon} ${p.label}`).join(', ')}.` +
      (s ? ` Right now it is ${POWER_VISUALS[s.power.status].label.toLowerCase()}${s.power.model ? ` (${s.power.model})` : ''}.` : ''),
  },
  {
    id: 'models',
    strong: ['models'],
    question: 'How do I switch models?',
    keywords: ['switch model', 'change model', 'model', 'models', 'primary', 'fallback model', 'gemini', 'provider key', 'api key', 'settings'],
    answer: () =>
      'Set "codecraft.primaryModel" and "codecraft.fallbackModel" in VS Code Settings to model names from your TrueForge providers (for example provider/model). ' +
      'Provider keys live only in TrueForge Settings, never in CodeCraft. Use "Test providers" in the agent panel to check both models.',
  },
  {
    id: 'tasks',
    strong: ['task1', 'task2', 'task3', 'tasks', 'scenario', 'scenarios'],
    question: 'How do I run the three tasks?',
    keywords: ['task', 'tasks', 'task1', 'task2', 'task3', 'three tasks', 'scenario', 'scenarios', 'flask', 'demo'],
    answer: () =>
      'The three tasks are written out in docs/TASKS.md and run against the Flask fixture in fixtures/flask. Open that folder, open the agent panel and paste a task, or run ' +
      '"npm run scenario -- task1" (task2, task3) from the CodeCraft repo. The scenarios need TrueForge running and a working provider; they make real model calls.',
  },
  {
    id: 'modes',
    strong: ['journey', 'architecture', 'replay'],
    question: 'What do Journey, Architecture and Replay do?',
    keywords: ['journey', 'architecture', 'replay', 'mode', 'modes', 'path', 'roads', 'districts', 'play back', 'playback'],
    answer: () =>
      'Agent Journey shows the path the agent took in this run (yellow line, numbered stops) with buildings coloured by state. Architecture colours buildings by kind and highlights the ' +
      'import roads between districts. Replay plays a finished run from the journal again (play, pause, speed, position slider; Back to live returns to the current run).',
  },
  {
    id: 'cost',
    strong: ['cost', 'tokens', 'token', 'elapsed'],
    question: 'What does the cost panel show?',
    keywords: ['cost', 'tokens', 'token', 'speed', 'elapsed', 'time', 'price', 'money', 'files read', 'how many files'],
    answer: () =>
      'The Cost and speed section of the agent panel shows the active model, input and output tokens (and an estimated cost when TrueForge reports one), elapsed time, and how many ' +
      'files the agent read out of all indexed files.',
  },
  {
    id: 'scout',
    strong: ['scout', 'mute', 'tips'],
    question: 'Who is Scout, and can I mute it?',
    keywords: ['scout', 'who are you', 'guide', 'mute', 'quiet', 'hide', 'tips', 'tip', 'lantern'],
    answer: () =>
      "I'm Scout, Code Town's guide. I walk to whatever the agent is working on and say it in plain words. Click a building and I'll walk there and open the file. " +
      'I only show things: I never edit files, run tasks or call a model. To mute me and my tips, set "codecraft.scout" to "muted".',
  },
  {
    id: 'now',
    strong: ['happening'],
    question: 'What is happening right now?',
    keywords: ['now', 'happening', 'status', 'doing', 'current', 'progress', 'what is the agent'],
    answer: (s) => {
      if (!s) return 'No run is loaded yet.';
      const b = s.activeBuildingId ? s.buildings[s.activeBuildingId] : undefined;
      const t = s.tests ? ` The last test run ${s.tests.passed ? 'passed' : 'failed'}.` : '';
      return `${s.scout.bubble}${b ? ` (${b.path}: ${b.label.toLowerCase()})` : ''}. The provider is ${POWER_VISUALS[s.power.status].label.toLowerCase()}.${t}`;
    },
  },
  {
    id: 'tests',
    strong: ['confidence', 'risky', 'regression'],
    question: 'What do the test marks and confidence tags mean?',
    keywords: ['test', 'tests', 'confidence', 'sure', 'check this', 'risky', 'regression', 'passed', 'failing'],
    answer: () =>
      'Test marks come from real test runs: ✓ tests pass, ✗ tests fail, · not run yet. Confidence tags rate each change group: sure (small, planned, covered by tests), check this ' +
      '(larger, untested or used elsewhere), risky (outside the plan, very large, widely used, or tests broke). If a test that passed before fails after a change, CodeCraft tries exactly one automatic fix.',
  },
];

export const SUGGESTED: string[] = ['colours', 'review', 'undo', 'stop', 'failover', 'modes'].map((id) => TOPICS.find((t) => t.id === id)!.question);

export const UNKNOWN_ANSWER =
  "I don't know that one yet. The README covers setup, every command and setting, and docs/TRUST.md and docs/CODETOWN.md explain reviews, failover and the town. Try one of the suggested questions.";

/** Minimum score for an answer: one phrase, or two words. */
export const MIN_SCORE = 2;

const normalize = (q: string): string => q.toLowerCase().replace(/[^a-z0-9\s.-]/g, ' ').replace(/\s+/g, ' ').trim();

export function scoreTopic(topic: HelpTopic, question: string): number {
  const q = ` ${normalize(question)} `;
  let score = 0;
  for (const k of topic.keywords) {
    if (k.includes(' ')) {
      if (q.includes(` ${k} `)) score += 2;
    } else if (q.includes(` ${k} `) || q.includes(` ${k}s `)) score += 1;
  }
  for (const k of topic.strong ?? []) if (q.includes(` ${k} `)) score += 1; // strong words count double in total
  // the suggested question itself always matches its topic
  if (normalize(question) === normalize(topic.question)) score += 10;
  return score;
}

export interface HelpAnswer {
  topic?: string;
  answer: string;
  /** Follow-up questions to offer. */
  suggestions: string[];
}

/** Words to highlight in an answer bubble (the topic's strongest words first). */
export function answerKeywords(topic: string | undefined): string[] {
  const t = topic ? TOPICS.find((x) => x.id === topic) : undefined;
  return t ? [...(t.strong ?? []), ...t.keywords] : ['README', 'Scout'];
}

export function askScout(question: string, scene?: SceneState): HelpAnswer {
  const ranked = TOPICS.map((t) => ({ t, score: scoreTopic(t, question) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < MIN_SCORE || !normalize(question)) return { answer: UNKNOWN_ANSWER, suggestions: SUGGESTED };
  const more = ranked.slice(1).filter((r) => r.score >= MIN_SCORE).map((r) => r.t.question);
  return { topic: best.t.id, answer: best.t.answer(scene), suggestions: (more.length ? more : SUGGESTED.filter((q) => q !== best.t.question)).slice(0, 4) };
}

/** A dismissible context tip for a scene change (never blocking; shown only when Scout is not muted). */
export interface Tip {
  id: string;
  text: string;
}

export function tipFor(prev: SceneState | undefined, next: SceneState): Tip | undefined {
  if (!prev) return undefined;
  if (next.power.status === 'failed_over' && prev.power.status !== 'failed_over')
    return { id: 'failover', text: 'The main model stopped, so CodeCraft switched to the backup model and kept going. Your accepted changes are safe. Ask me "How does failover work?"' };
  if (next.power.status === 'recovered' && prev.power.status !== 'recovered') return { id: 'recovered', text: 'The main model works again.' };
  if (next.stats.proposed > prev.stats.proposed && prev.stats.proposed === 0 && prev.stats.applied === 0)
    return { id: 'first-review', text: 'The agent proposed a change: review it in the editor. Accept or reject whole groups or single hunks; Esc rejects.' };
  if (next.stats.failed > prev.stats.failed) return { id: 'failing', text: 'A test fails after the change. CodeCraft tries one automatic fix; you can also Undo Last Change or roll back.' };
  return undefined;
}
