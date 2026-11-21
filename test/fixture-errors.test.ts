// P4: the error classifier against REAL TrueForge 0.185.1 turn.done error texts (test/fixtures/trueforge-errors.json,
// written by test/scenarios/capture-errors.ts). mock_* = a local test-only provider failing on purpose behind the
// real TrueForge; history_* = natural errors TrueForge recorded on this machine (real Gemini, Groq, network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorClass, classifyError, isDailyQuota, retryAfterMs } from '../src/trueforge/errors';
import { scanText } from '../src/util/secretScan';

interface Sample {
  id: string;
  source: string;
  status: string;
  message: string;
}
const FIXTURE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'trueforge-errors.json');
const samples = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { samples: Sample[] }).samples;
const errors = samples.filter((s) => s.status === 'error');

const EXPECTED: Record<string, ErrorClass> = {
  mock_rate_limit: 'rate_limit',
  mock_server_error: 'unavailable_or_timeout',
  mock_unavailable: 'unavailable_or_timeout',
  mock_context_too_large: 'context_too_large',
  mock_malformed_tool_call: 'bad_output', // "You have reached iteration limit of 512"
  mock_bad_json: 'bad_output', // "JSON parsing failed ... Unterminated string"
  mock_cut_stream: 'unavailable_or_timeout', // provider closed the stream: "(200) ... terminated: other side closed"
  mock_hang: 'unavailable_or_timeout', // "Headers Timeout Error" after 65 s
  unreachable_endpoint: 'unavailable_or_timeout', // ECONNREFUSED
  invalid_key: 'invalid_or_revoked_key',
  history_1: 'invalid_or_revoked_key',
  history_2: 'unavailable_or_timeout',
  history_3: 'unavailable_or_timeout',
  history_4: 'unavailable_or_timeout',
  history_5: 'bad_output',
  history_6: 'bad_output',
  history_7: 'context_too_large',
  history_8: 'unavailable_or_timeout',
  history_9: 'unavailable_or_timeout',
  history_10: 'rate_limit',
  history_11: 'rate_limit', // Gemini per-minute quota with "Please retry in 25.29s"
  history_12: 'unavailable_or_timeout', // Gemini "high demand" without a status code
  history_13: 'unavailable_or_timeout',
  history_14: 'unavailable_or_timeout', // read ECONNRESET
  history_15: 'tls_error', // certificate has expired (machine network problem)
  history_16: 'unavailable_or_timeout', // Connect Timeout Error
  history_17: 'unavailable_or_timeout',
  history_18: 'unavailable_or_timeout', // getaddrinfo ENOTFOUND
  history_19: 'unavailable_or_timeout',
  history_20: 'editor_tools_unreachable', // [MCP Error] CodeCraft's editor server not running
  history_21: 'bad_request',
  history_22: 'bad_request',
  history_23: 'bad_request',
  history_24: 'unknown', // 404 model does not exist: shown as-is, no retry
  history_25: 'bad_request',
  history_26: 'unknown',
  history_27: 'bad_request',
  history_28: 'unavailable_or_timeout', // "(200) ... terminated: read ECONNRESET"
};

test('fixture: every real error sample has an expected class, and the classifier agrees', () => {
  assert.ok(errors.length >= 30, `only ${errors.length} samples`);
  for (const s of errors) {
    assert.ok(s.id in EXPECTED, `no expectation for ${s.id}: ${s.message.slice(0, 120)}`);
    assert.equal(classifyError(s.message).cls, EXPECTED[s.id], `${s.id}: ${s.message.slice(0, 160)}`);
  }
});

test('fixture: all five P4 classes were OBSERVED live (none is only synthetic)', () => {
  const seen = new Set(errors.map((s) => classifyError(s.message).cls));
  for (const c of ['invalid_or_revoked_key', 'rate_limit', 'unavailable_or_timeout', 'bad_output', 'context_too_large'] as const) assert.ok(seen.has(c), c);
});

test('fixture: retry hints are read from real texts; a per-minute quota is not a daily quota', () => {
  const by = (id: string) => (errors.find((s) => s.id === id) as Sample).message;
  assert.equal(retryAfterMs(by('mock_rate_limit')), 7_000);
  assert.equal(retryAfterMs(by('history_11')), 25_297);
  assert.equal(isDailyQuota(by('history_11')), false);
  assert.equal(classifyError(by('mock_rate_limit')).status, 429);
  assert.equal(classifyError(by('invalid_key')).status, 401);
});

test('fixture: contains no secret (the dummy key is masked, keys never appear)', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  assert.deepEqual(scanText('trueforge-errors.json', text), []);
  assert.ok(!text.includes('DUMMY-INVALID-KEY'));
});
