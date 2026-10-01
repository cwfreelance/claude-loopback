export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One run, already validated and narrowed by the service layer. */
export interface RunRequest {
  /** The full prompt text sent on stdin (attachments already inlined). */
  readonly prompt: string;
  /** Tools to enable; a subset of the server allowlist. Empty means none. */
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly effort?: Effort;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface BackendStatus {
  readonly ready: boolean;
  readonly loggedIn: boolean;
  readonly version?: string;
  /** Why the backend is not ready; safe to show to the authenticated owner. */
  readonly reason?: string;
}

/** Routes and the service only ever see this; CliBackend now, ApiBackend (BYOK) later. */
export interface ClaudeBackend {
  probe(): Promise<BackendStatus>;
  /** Emits start/delta/retry events and ends with exactly one result event, or throws AppError. */
  stream(request: RunRequest, signal: AbortSignal): AsyncGenerator<RunEvent>;
  run(request: RunRequest, signal: AbortSignal): Promise<RunResult>;
}

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
