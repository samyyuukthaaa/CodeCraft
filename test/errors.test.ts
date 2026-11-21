// Every input below is an error text actually observed from TrueForge 0.185.1 on 2026-11-20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, failoverBanner, failureMessage, retryDelayMs } from '../src/trueforge/errors';

const OBSERVED = {
  key401: '[Model Error] Request failed (401): Invalid API Key',
  quota429: '[Model Error] Request failed (429): You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits.',
  demand503: '[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  headersTimeout: '[Model Error] Cannot connect to API: Headers Timeout Error',
  reset: '[Model Error] Request failed (200): Failed to process successful response: Failed to process successful response: terminated: read ECONNRESET',
  temp400: '[Model Error] Request failed (400): * GenerateContentRequest.generation_config.temperature: temperature must be in the range [0.0, 2.0].',
  bare400: '[Model Error] Request failed (400): Bad Request',
};

test('classifyError: observed texts map to the right class and status', () => {
  assert.deepEqual(classifyError(OBSERVED.key401), { cls: 'invalid_or_revoked_key', status: 401 });
  assert.deepEqual(classifyError(OBSERVED.quota429), { cls: 'rate_limit', status: 429 });
  assert.deepEqual(classifyError(OBSERVED.demand503), { cls: 'unavailable_or_timeout', status: 503 });
  assert.deepEqual(classifyError(OBSERVED.headersTimeout), { cls: 'unavailable_or_timeout', status: undefined });
  assert.deepEqual(classifyError(OBSERVED.reset), { cls: 'unavailable_or_timeout', status: 200 });
  assert.deepEqual(classifyError(OBSERVED.temp400), { cls: 'bad_request', status: 400 });
  // A bare 400 is NOT claimed to be a key problem: it cannot be told apart from other bad requests.
  assert.deepEqual(classifyError(OBSERVED.bare400), { cls: 'bad_request', status: 400 });
  assert.equal(classifyError('something new').cls, 'unknown');
  // observed on this machine during a network problem
  assert.deepEqual(classifyError('[Model Error] Cannot connect to API: certificate has expired'), { cls: 'tls_error', status: undefined });
  assert.match(failureMessage('m', '[Model Error] Cannot connect to API: certificate has expired'), /\(TLS\) connection failed\. Check this machine's clock, proxy or network; retrying will not help\./);
});

test('daily quota (observed live): never retried, banner and message say "daily quota"', () => {
  const daily = '[Model Error] Request failed (429): You exceeded your current quota ... * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500, model: gemini-3.5-flash-lite, description: Generate content requests per day limit exceeded on Free Tier. Please retry in 41.2s.';
  const perMinute = '[Model Error] Request failed (429): ... limit: 15, model: gemini-3.5-flash-lite, description: Generate content requests per minute limit exceeded on Free Tier. Please retry in 41.2s.';
  assert.equal(retryDelayMs(daily, 0), undefined);
  assert.equal(retryDelayMs(perMinute, 0, () => 0), 41200);
  assert.match(failoverBanner('a/m1', 'b/m2', daily), /stopped because it used up its daily quota \(HTTP 429\)/);
  assert.match(failureMessage('b/m2', daily), /^b\/m2 has used up its daily quota \(HTTP 429\)\. It resets once a day/);
});

test('failoverBanner: plain words, names both models, says the key was rejected, never a key value', () => {
  const dummy = 'DUMMY-INVALID-KEY-FOR-CODECRAFT-TESTS';
  const b = failoverBanner('codecraft-test-badkey/gpt-oss-120b', 'google-gemini/gemini-3-5-flash-lite', `${OBSERVED.key401} (key ${dummy})`);
  assert.equal(
    b,
    'Provider key rejected: update it in TrueForge Settings. The primary model codecraft-test-badkey/gpt-oss-120b was refused (HTTP 401); CodeCraft switched to the fallback model google-gemini/gemini-3-5-flash-lite automatically and is continuing your request.',
  );
  assert.ok(!b.includes(dummy));
  assert.match(failoverBanner('a', 'b', OBSERVED.demand503), /unavailable or timed out \(HTTP 503\)/);
});

test('failureMessage: clear, actionable, honest about files', () => {
  assert.equal(
    failureMessage('codecraft-test-badkey/gpt-oss-120b', OBSERVED.key401),
    'Provider key rejected (HTTP 401) for codecraft-test-badkey/gpt-oss-120b: update it in TrueForge Settings. Nothing was changed in your files.',
  );
  assert.match(failureMessage('m', OBSERVED.quota429), /rate limit or quota \(HTTP 429\)/);
  assert.match(failureMessage('m', OBSERVED.key401, ['src/a.py']), /Changes you accepted earlier in this run stay applied: src\/a\.py\.$/);
  const fake = 'AIza' + 'Z'.repeat(35);
  assert.ok(!failureMessage('m', `weird failure ${fake}`).includes(fake));
});
