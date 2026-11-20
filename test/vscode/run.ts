// Downloads (once, into .vscode-test/) and launches a separate VS Code, loads CodeCraft from this folder,
// opens a temporary workspace and runs test/vscode/suite.ts inside it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codecraft-vscode-'));
  try {
    // VSCODE_EXECUTABLE=<path to Code.exe> reuses an installed VS Code instead of downloading one. Either way
    // it runs with its own throwaway user-data and extensions folders, separate from your normal profile.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codecraft-vscode-profile-'));
    await runTests({
      ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : {}),
      extensionDevelopmentPath: path.resolve('.'),
      extensionTestsPath: path.resolve('out/vscode/suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${path.join(profile, 'data')}`, `--extensions-dir=${path.join(profile, 'ext')}`],
    });
    fs.rmSync(profile, { recursive: true, force: true });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
