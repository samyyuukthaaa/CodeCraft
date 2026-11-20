// Incremental Server-Sent-Events parser. Pure; no I/O.
export interface SseParser {
  push(chunk: string): string[];
}

/** Returns the `data:` payloads of each complete SSE event as it arrives. */
export function createSseParser(): SseParser {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk.replace(/\r\n/g, '\n');
      const out: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) out.push(data);
      }
      return out;
    },
  };
}
