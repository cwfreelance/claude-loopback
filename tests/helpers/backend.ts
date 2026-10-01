import type {
  BackendStatus,
  ClaudeBackend,
  RunEvent,
  RunRequest,
  RunResult,
} from "../../src/backends/types.ts";

export const RESULT: RunResult = {
  text: "pong",
  model: "m-1",
  stopReason: "end_turn",
  durationMs: 10,
  usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
};

interface Script {
  events?: RunEvent[];
  error?: Error;
  /** When set, the run stays open until release() is called. */
  hold?: boolean;
}

/** A scriptable ClaudeBackend that records every request it receives. */
export class FakeBackend implements ClaudeBackend {
  readonly requests: RunRequest[] = [];
  readonly signals: AbortSignal[] = [];
  /** Runs currently inside stream(). */
  running = 0;
  status: BackendStatus = { ready: true, loggedIn: true, version: "2.1.287" };
  #scripts: Script[] = [];
  #releases: Array<() => void> = [];

  /** Queues the behaviour for the next run (default: start, delta, result). */
  script(script: Script): this {
    this.#scripts.push(script);
    return this;
  }

  /** Lets the oldest held run finish. */
  release(): void {
    this.#releases.shift()?.();
  }

  async probe(): Promise<BackendStatus> {
    return this.status;
  }

  async *stream(request: RunRequest, signal: AbortSignal): AsyncGenerator<RunEvent> {
    this.requests.push(request);
    this.signals.push(signal);
    const script = this.#scripts.shift() ?? {};
    this.running++;
    try {
      if (script.hold) await new Promise<void>((resolve) => this.#releases.push(resolve));
      if (script.error) throw script.error;
      yield* script.events ?? [
        { type: "start", model: "m-1" },
        { type: "delta", text: "pong" },
        { type: "result", result: RESULT },
      ];
    } finally {
      this.running--;
    }
  }

  async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    for await (const event of this.stream(request, signal)) {
      if (event.type === "result") return event.result;
    }
    throw new Error("no result");
  }
}

/** Resolves after pending microtasks and immediate callbacks have run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
