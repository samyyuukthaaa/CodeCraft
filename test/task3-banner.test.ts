// Task C banner check: the expected model names are derived from the configuration (codecraft.fallbackModel, and
// codecraft.primaryModel or the invalid-key model standing in for it), and the check stays strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { failoverBanner } from '../src/trueforge/errors';
import { DEFAULT_CONFIG, validateConfig } from '../src/trueforge/config';
import { bannerNamesTakeover, expectedBannerModels } from './scenarios/banner';

const KEY401 = '[Model Error] Request failed (401): Invalid API Key';
const STAND_IN = 'codecraft-test-badkey/gpt-oss-120b';

test('derivation: the fallback comes from codecraft.fallbackModel, the primary from codecraft.primaryModel or its stand-in', () => {
  assert.deepEqual(expectedBannerModels(DEFAULT_CONFIG), { primary: DEFAULT_CONFIG.primaryModel, fallback: DEFAULT_CONFIG.fallbackModel });
  assert.deepEqual(expectedBannerModels(validateConfig({}), STAND_IN), { primary: STAND_IN, fallback: DEFAULT_CONFIG.fallbackModel });
  const swapped = validateConfig({ primaryModel: 'a/one', fallbackModel: 'b/two' });
  assert.deepEqual(expectedBannerModels(swapped), { primary: 'a/one', fallback: 'b/two' });
});

test('strict: the real banner for the configured models passes; any other fallback, primary, code or wording fails', () => {
  const m = expectedBannerModels(validateConfig({}), STAND_IN);
  const real = failoverBanner(m.primary, m.fallback, KEY401);
  assert.equal(bannerNamesTakeover(real, m), true, real);
  assert.equal(bannerNamesTakeover(failoverBanner(m.primary, 'google-gemini/some-other-model', KEY401), m), false, 'a different fallback');
  assert.equal(bannerNamesTakeover(failoverBanner('x/other', m.fallback, KEY401), m), false, 'a different refused primary');
  assert.equal(bannerNamesTakeover(failoverBanner(m.primary, m.fallback, '[Model Error] Request failed (503): overloaded'), m), false, 'not a rejected key');
  assert.equal(bannerNamesTakeover(real.replace(' automatically', ''), m), false, 'not automatic');
  assert.equal(bannerNamesTakeover('', m), false);
  // swapping the configured models changes what is expected (nothing hard-coded)
  const other = { primary: STAND_IN, fallback: 'google-gemini/gemini-3-5-flash-lite' };
  assert.equal(bannerNamesTakeover(real, other), m.fallback === other.fallback);
});

test('task3 scenario: no hard-coded model name in the banner check; the other checks are all still there', () => {
  const src = fs.readFileSync('test/scenarios/task3.ts', 'utf8');
  assert.doesNotMatch(src, /gemini/);
  assert.match(src, /expectedBannerModels\(validateConfig\(\{\}\), TEST_MODEL_REF\)/);
  assert.match(src, /bannerNamesTakeover\(banner, expected\) && sw\?\.toModel === expected\.fallback/);
  for (const name of [
    'exactly one automatic switch, from the invalid-key agent to codecraft-fallback',
    'the switch was caused by the rejected key (HTTP 401)',
    'no user action before the takeover (0 approvals, 0 reviews) and nothing written at that moment',
    'TASKS.md: the second configured model took over (run finished on codecraft-fallback)',
    'the fallback did the work: it proposed a change to src/flask/helpers.py (rejected by the scripted user)',
    'TASKS.md: git status shows no files changed',
    'TASKS.md: the user sees a clear message (key rejected, where to fix it, nothing changed)',
  ])
    assert.ok(src.includes(name), name);
});
