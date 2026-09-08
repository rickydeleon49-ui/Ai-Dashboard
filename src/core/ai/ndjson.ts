/**
 * Incremental newline-delimited JSON.
 *
 * Ollama streams one JSON object per line, and a chunk boundary lands wherever
 * the network puts it — mid-object, mid-multibyte-character, or between the
 * object and its newline. Parsing per chunk therefore fails intermittently and
 * only under load, which is the worst kind of bug to find later. This keeps the
 * tail of an incomplete line until the rest arrives.
 *
 * Pure, synchronous and dependency-free so it can be tested exhaustively
 * without a server.
 */
export interface NdjsonParser {
  /** Feeds a decoded chunk and returns whatever complete objects it finished. */
  push(chunk: string): unknown[];
  /** Call once the stream ends; returns a trailing object with no newline. */
  flush(): unknown[];
}

export class NdjsonParseError extends Error {
  readonly line: string;
  constructor(line: string) {
    super("The AI service sent a response that could not be read.");
    this.name = "NdjsonParseError";
    // Bounded: a malformed line can be megabytes, and this ends up in a log.
    this.line = line.slice(0, 400);
  }
}

export function createNdjsonParser(): NdjsonParser {
  let buffer = "";

  const take = (line: string, out: unknown[]) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      throw new NdjsonParseError(trimmed);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      const out: unknown[] = [];

      let index = buffer.indexOf("\n");
      while (index !== -1) {
        take(buffer.slice(0, index), out);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      return out;
    },

    flush() {
      const out: unknown[] = [];
      take(buffer, out);
      buffer = "";
      return out;
    },
  };
}
