// Pure: what the journal records about a tool call's arguments. Paths, line ranges, queries and group intents
// only: never file contents, edit text or test output. The journal redacts the result again when it is written.

const MAX = 300;

const str = (v: unknown, max = 120): string | undefined => (typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, max) : undefined);

export function toolArgsSummary(tool: string, args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const parts: string[] = [];
  const add = (k: string, v: string | number | undefined): void => {
    if (v !== undefined && v !== '') parts.push(`${k}=${v}`);
  };
  switch (tool) {
    case 'read_file':
      add('path', str(a.path));
      add('lines', typeof a.startLine === 'number' ? `${a.startLine}-${typeof a.endLine === 'number' ? a.endLine : ''}` : undefined);
      break;
    case 'list_files':
      add('prefix', str(a.prefix));
      break;
    case 'list_related':
      add('path', str(a.path));
      break;
    case 'search_text':
      add('query', str(a.query, 80));
      add('prefix', str(a.prefix));
      break;
    case 'search_symbols':
      add('query', str(a.query, 80));
      add('kind', str(a.kind, 20));
      break;
    case 'submit_plan':
      add('files', Array.isArray(a.files) ? a.files.map((f) => str((f as { path?: unknown })?.path) ?? '?').join(',') : undefined);
      break;
    case 'propose_write':
      add('path', str(a.path));
      break;
    case 'propose_changes':
      add(
        'groups',
        Array.isArray(a.groups)
          ? a.groups
              .map((g) => {
                const gg = (g ?? {}) as { intent?: unknown; files?: unknown };
                const files = Array.isArray(gg.files) ? gg.files.map((f) => str((f as { path?: unknown })?.path) ?? '?').join(',') : '';
                return `${str(gg.intent, 40) ?? 'edit'}:${files}`;
              })
              .join(' | ')
          : undefined,
      );
      break;
    default:
      break; // run_tests and anything else: the tool name is enough
  }
  return parts.join(' ').slice(0, MAX);
}
