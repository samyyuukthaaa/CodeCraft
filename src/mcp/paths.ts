// Pure path policy for every editor tool. Paths are workspace-relative, forward-slash, no traversal.
const DENY: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)out(\/|$)/,
  /(^|\/)\.vscode-test(\/|$)/,
];

export class PathError extends Error {}

/** Returns a normalized workspace-relative path or throws PathError. */
export function normalizeRelPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 400) throw new PathError('invalid path');
  if (input.includes('\0')) throw new PathError('invalid path');
  const p = input.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new PathError('absolute paths are not allowed');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new PathError('path traversal is not allowed');
    parts.push(seg);
  }
  if (parts.length === 0) throw new PathError('invalid path');
  const out = parts.join('/');
  if (isDenied(out)) throw new PathError('path is not accessible to agents');
  return out;
}

export function isDenied(relPath: string): boolean {
  return DENY.some((re) => re.test(relPath));
}
