export interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses an SSE body into its events (data parsed as JSON) and counts comment lines. */
export function parseSse(body: string): { events: SseEvent[]; comments: number } {
  const events: SseEvent[] = [];
  let comments = 0;
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) comments++;
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return { events, comments };
}

/** Reads a streaming body until `stop` returns true for the text so far (or the stream ends). */
export async function readUntil(
  body: ReadableStream<Uint8Array>,
  stop: (text: string) => boolean,
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!stop(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { text, reader };
}
