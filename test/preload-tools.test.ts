// codecraft.preloadTools: TrueForge loads the editor tools into the model up front (preloadTools), instead of the
// call_tool wrapper. Default off. Only the agent manifest (MCP server entry and the one instruction line on how to
// reach the tools) changes; everything else is identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { EDITOR_SERVER_NAME, EDITOR_TOOLS } from '../src/mcp/constants';
import { schemas } from '../src/mcp/tools';
import { manifestFor, manifestMatches } from '../src/trueforge/client';
import { AGENT_INSTRUCTIONS, CALL_TOOL_LINE, DEFAULT_CONFIG, PRELOADED_TOOLS_LINE, instructionsFor, validateConfig } from '../src/trueforge/config';

test('preloadTools: off by default (config, validation and the VS Code setting)', () => {
  assert.equal(DEFAULT_CONFIG.preloadTools, false);
  assert.equal(validateConfig({}).preloadTools, false);
  assert.equal(validateConfig({ preloadTools: true }).preloadTools, true);
  assert.equal(validateConfig({ preloadTools: 'yes' as unknown as boolean }).preloadTools, false, 'only a real true turns it on');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } } };
  const s = pkg.contributes.configuration.properties['codecraft.preloadTools']!;
  assert.equal(s.type, 'boolean');
  assert.equal(s.default, false);
});

test('preloadTools ON: the MCP server entry preloads every editor tool; approvals stay; one instruction line changes', () => {
  assert.deepEqual([...EDITOR_TOOLS].sort(), Object.keys(schemas).sort(), 'the list matches the tools the server registers');
  const off = manifestFor('p/m');
  const on = manifestFor('p/m', { preloadTools: true });
  assert.deepEqual(off.mcpServers, [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: ['propose_write', 'propose_changes', 'run_tests'] }]);
  assert.deepEqual(on.mcpServers, [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: ['propose_write', 'propose_changes', 'run_tests'], preloadTools: [...EDITOR_TOOLS] }]);
  assert.equal(off.instructions, AGENT_INSTRUCTIONS);
  assert.ok(off.instructions!.includes(CALL_TOOL_LINE));
  assert.ok(on.instructions!.includes(PRELOADED_TOOLS_LINE) && !on.instructions!.includes('call_tool'), 'no call_tool advice when the tools are preloaded');
  assert.equal(instructionsFor(true).replace(PRELOADED_TOOLS_LINE, CALL_TOOL_LINE), AGENT_INSTRUCTIONS, 'only that line differs');
  assert.deepEqual(on.config, off.config);
  assert.equal(on.model.name, off.model.name);
});

test('preloadTools: switching it is a manifest change (the agent in TrueForge is updated), and a stored default [] matches OFF', () => {
  const off = manifestFor('p/m');
  const on = manifestFor('p/m', { preloadTools: true });
  assert.equal(manifestMatches(off, on), false);
  assert.equal(manifestMatches(on, off), false);
  assert.equal(manifestMatches(on, manifestFor('p/m', { preloadTools: true })), true);
  // observed live: TrueForge stores preloadTools: [] and preload: false as defaults
  const stored = { ...off, mcpServers: off.mcpServers!.map((m) => ({ ...m, preloadTools: [], preload: false, enableTools: ['@all'], disableTools: [] })) };
  assert.equal(manifestMatches(stored as typeof off, off), true);
});
