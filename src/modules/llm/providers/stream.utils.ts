import type { LLMChunk } from "../llm.types";

/**
 * Reads a text body — SSE (`data:` lines) or NDJSON (one JSON object per
 * line) — and converts each non-empty line into an LLMChunk via `toChunk`.
 *
 * Guarantees a terminal `done: true` chunk even when the connection ends
 * without one (server dropped mid-stream), so consumers never hang waiting
 * for completion. Malformed lines are passed to `toChunk`, which decides
 * whether to skip them (null) — one bad line never aborts the stream.
 */
export async function* consumeTextStream(
  body: ReadableStream<Uint8Array>,
  toChunk: (line: string) => LLMChunk | null,
  provider: string,
  model: string,
): AsyncIterable<LLMChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  function* drain(line: string): Generator<LLMChunk> {
    const normalized = line.replace(/\r$/, "");
    if (normalized.trim() === "") {
      return;
    }
    const chunk = toChunk(normalized);
    if (chunk !== null) {
      yield chunk;
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const chunk of drain(line)) {
          if (chunk.done) {
            sawDone = true;
          }
          yield chunk;
        }
        index = buffer.indexOf("\n");
      }
    }
    for (const chunk of drain(buffer)) {
      if (chunk.done) {
        sawDone = true;
      }
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) {
    yield { provider, model, delta: "", finishReason: null, done: true };
  }
}
