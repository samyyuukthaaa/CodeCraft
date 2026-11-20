// Real-TrueForge smoke test: node out/scripts/smoke.js [model]
import { createSession, listModels, runTurn } from '../src/forge/client';
import { redact } from '../src/util/redact';

async function main(): Promise<void> {
  const base = process.env.FORGE_BASE_URL ?? 'http://localhost:8790';
  const model = process.argv[2] ?? 'google-gemini/gemini-3-1-flash-lite';
  const models = await listModels(base);
  console.log(`models registered: ${models.length}; requested model present: ${models.includes(model)}`);
  const sid = await createSession(base, model);
  const r = await runTurn(base, sid, 'Reply with exactly: CODECRAFT HELLO');
  console.log(`status=${r.status} model=${r.model ?? '-'} content=${redact(r.content ?? '')} error=${redact(r.errorMessage ?? '')}`);
  process.exitCode = r.status === 'done' ? 0 : 1;
}
main().catch((e) => {
  console.error(redact(String(e)));
  process.exitCode = 2;
});
