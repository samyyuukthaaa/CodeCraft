// Pure configuration module: no VS Code or SDK imports, so it is unit-testable and reusable.
export interface CodeCraftConfig {
  baseUrl: string;
  primaryModel: string;
  fallbackModel: string;
}

export const DEFAULT_CONFIG: CodeCraftConfig = {
  baseUrl: 'http://localhost:8790',
  primaryModel: 'google-gemini/gemini-3-1-flash-lite',
  fallbackModel: 'groq/gpt-oss-120b',
};

export const PRIMARY_AGENT_NAME = 'codecraft-primary';
export const FALLBACK_AGENT_NAME = 'codecraft-fallback';

/** Identical for both agents so a failover never changes behaviour, only the model. */
export const AGENT_INSTRUCTIONS =
  'You are the CodeCraft coding agent running inside a VS Code extension. ' +
  'Be concise. Never ask for or repeat API keys or other secrets. ' +
  'Use the codecraft-editor tools to work on the workspace: read_file before propose_write on any existing file, ' +
  'send the complete new file content in propose_write, and run_tests to check your work. ' +
  'propose_write only proposes: the user reviews each hunk, so report exactly what the tool result says was applied, ' +
  'and never claim a change was made or that tests passed unless a tool result confirms it.';

export const AGENT_DESCRIPTION = 'CodeCraft agent (managed by the CodeCraft VS Code extension)';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function validateBaseUrl(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error('codecraft.baseUrl is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('codecraft.baseUrl must be http or https');
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    throw new Error('codecraft.baseUrl must be a loopback address (TrueForge standalone is localhost-only)');
  }
  return u.origin;
}

export function validateConfig(raw: Partial<CodeCraftConfig>): CodeCraftConfig {
  const defined = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const cfg: CodeCraftConfig = { ...DEFAULT_CONFIG, ...defined };
  cfg.baseUrl = validateBaseUrl(cfg.baseUrl);
  for (const key of ['primaryModel', 'fallbackModel'] as const) {
    if (!MODEL_NAME.test(cfg[key])) throw new Error(`codecraft.${key} is not a valid TrueForge model name`);
  }
  return cfg;
}
