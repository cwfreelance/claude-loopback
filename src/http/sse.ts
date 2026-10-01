import type { Context } from "hono";
import { type SSEMessage, type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { RunEvent } from "../backends/types.ts";
import { AppError, toErrorResponse } from "../errors.ts";
import type { PromptInput, PromptService } from "../service/prompt-service.ts";
import type { AppEnv } from "./middleware.ts";
import { resultBody } from "./responses.ts";

export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface StreamOptions {
  readonly heartbeatMs: number;
  /** How long one write may wait on a client that stopped reading before the run is dropped. */
  readonly stallMs: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** SSE data for a progress event: the event minus its `type`, which becomes the SSE event name. */
function eventData({ type: _type, ...data }: Exclude<RunEvent, { type: "result" }>) {
  return data;
}

/**
 * Runs a prompt and streams it as SSE: `start`, `delta`, `retry`, then exactly one `result` or
 * `error`. Headers are sent only once the request holds a queue slot, so validation, policy and
 * queue errors (400/429/503) are still plain JSON responses with a real status. Each event is
 * written before the next is pulled, so a slow client slows the CLI down rather than buffering;
 * a client that stops reading altogether is dropped after `stallMs`, which frees its slot.
 */
export async function streamPrompt(
  c: Context<AppEnv>,
  service: PromptService,
  input: PromptInput,
  { heartbeatMs, stallMs }: StreamOptions,
): Promise<Response> {
  const requestId = c.get("requestId");
  const queued = deferred<void>();
  const sseReady = deferred<SSEStreamingApi>();

  // Aborts on client disconnect, and also when we drop a stalled client ourselves.
  const run = new AbortController();
  const clientSignal = c.req.raw.signal;
  if (clientSignal.aborted) run.abort();
  else clientSignal.addEventListener("abort", () => run.abort(), { once: true });

  async function write(sse: SSEStreamingApi, message: SSEMessage): Promise<void> {
    if (run.signal.aborted) throw new AppError("cancelled", "Client went away");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError("cancelled", "Client stopped reading the stream")),
        stallMs,
      );
    });
    try {
      await Promise.race([sse.writeSSE(message), stalled]);
    } catch (error) {
      // Cancelling the stream makes the stuck write settle and stops further writes.
      run.abort();
      sse.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const done = service.run(
    input,
    { signal: run.signal, requestId },
    {
      onQueued: () => queued.resolve(),
      onEvent: async (event) => {
        await write(await sseReady.promise, {
          event: event.type,
          data: JSON.stringify(eventData(event)),
        });
      },
    },
  );
  // Rejects here (before any header is sent) if validation or queueing fails.
  await Promise.race([queued.promise, done]);

  return streamSSE(c, async (sse) => {
    sseReady.resolve(sse);
    // Comments keep proxies and clients from timing out during long, quiet runs. Skipped while
    // one is still pending, so a stalled client can't pile them up.
    let pinging = false;
    const heartbeat = setInterval(() => {
      if (pinging || run.signal.aborted) return;
      pinging = true;
      void sse.write(": ping\n\n").finally(() => {
        pinging = false;
      });
    }, heartbeatMs);
    try {
      const { result, queueMs } = await done;
      await write(sse, {
        event: "result",
        data: JSON.stringify(resultBody(requestId, result, queueMs)),
      });
    } catch (error) {
      const { body } = toErrorResponse(error, requestId);
      await write(sse, { event: "error", data: JSON.stringify(body.error) }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  });
}
