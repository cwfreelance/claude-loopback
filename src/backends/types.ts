export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** The outcome of one successful run, independent of which backend produced it. */
export interface RunResult {
  readonly text: string;
  /** Present when the request asked for a JSON schema. */
  readonly structuredOutput?: unknown;
  readonly model: string;
  readonly stopReason: string | null;
  readonly durationMs: number;
  readonly usage: Usage;
  /** The backend's own cost estimate in USD (client-side for the CLI). */
  readonly costUsd: number;
}

/** What a streaming run emits. Failures are thrown as AppError, never emitted. */
export type RunEvent =
  | { readonly type: "start"; readonly model: string }
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      readonly error: string;
    }
  | { readonly type: "result"; readonly result: RunResult };
