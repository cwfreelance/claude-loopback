import { randomBytes } from "node:crypto";
import type { ClaudeBackend, Effort, RunEvent, RunRequest, RunResult } from "../backends/types.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Queue, QueueStats } from "./queue.ts";

export interface Attachment {
  readonly name: string;
  readonly content: string;
}

/** A request body after HTTP-level validation; policy is checked again here. */
export interface PromptInput {
  readonly prompt: string;
  readonly attachments?: readonly Attachment[];
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly effort?: Effort;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
}

export interface RunContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
}

export interface RunHooks {
  /** Called once a slot is held, before the backend starts (e.g. to send SSE headers). */
  onQueued?(queueMs: number): void | Promise<void>;
  /** Called for every event except the result; awaited, so a slow writer applies backpressure. */
  onEvent?(event: Exclude<RunEvent, { type: "result" }>): void | Promise<void>;
}

export interface PromptService {
  /** Validates, queues and runs one prompt. The service owns the loop, so its slot is always freed. */
  run(
    input: PromptInput,
    context: RunContext,
    hooks?: RunHooks,
  ): Promise<{ result: RunResult; queueMs: number }>;
  status(): QueueStats;
}

export interface PromptServiceDeps {
  readonly backend: ClaudeBackend;
  readonly queue: Queue;
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Random tag suffix that attachment content can't guess (tests inject a fixed one). */
  readonly newBoundary?: () => string;
}

// The CLI caps piped stdin at 10 MB; leave headroom.
const STDIN_LIMIT_BYTES = 9 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1000;
// Printable names only: no quotes, angle brackets, ampersands or control characters.
const SAFE_ATTACHMENT_NAME = /^[^"<>&\p{Cc}]{1,200}$/u;

const randomBoundary = () => randomBytes(8).toString("hex");

/**
 * Attachments go ahead of the prompt as <file> blocks, so text context works with no tools at
 * all. Tags carry a per-request random boundary, so file content can't close its block and pose
 * as the owner's prompt.
 */
export function inlineAttachments(
  prompt: string,
  attachments: readonly Attachment[] | undefined,
  boundary: string,
): string {
  if (!attachments || attachments.length === 0) return prompt;
  const files = attachments.flatMap((file) => [
    `<file-${boundary} name="${file.name}">`,
    file.content,
    `</file-${boundary}>`,
  ]);
  return [`<attachments-${boundary}>`, ...files, `</attachments-${boundary}>`, "", prompt].join(
    "\n",
  );
}

export function createPromptService(deps: PromptServiceDeps): PromptService {
  const { backend, queue, config, clock, logger } = deps;
  const newBoundary = deps.newBoundary ?? randomBoundary;
  const invalid = (message: string) => new AppError("invalid_request", message);

  /** Requests may only narrow what the server allows; the effective model is always allowlisted. */
  function toRunRequest(input: PromptInput): RunRequest {
    const tools = input.tools ?? [];
    for (const tool of tools) {
      if (!config.allowedTools.includes(tool)) {
        throw new AppError("tool_not_allowed", "A requested tool is not enabled on this server");
      }
    }
    const model = input.model ?? config.defaultModel;
    if (!config.allowedModels.includes(model)) {
      throw new AppError("model_not_allowed", "The requested model is not enabled on this server");
    }
    const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > config.maxTimeoutMs
    ) {
      throw invalid(
        `timeoutMs must be a whole number from ${MIN_TIMEOUT_MS} to ${config.maxTimeoutMs}`,
      );
    }
    for (const file of input.attachments ?? []) {
      if (!SAFE_ATTACHMENT_NAME.test(file.name)) {
        throw invalid('Attachment names must be 1-200 printable characters without " < > &');
      }
    }
    const prompt = inlineAttachments(input.prompt, input.attachments, newBoundary());
    if (Buffer.byteLength(prompt, "utf8") > STDIN_LIMIT_BYTES) {
      throw new AppError("payload_too_large", "Prompt and attachments are too large together");
    }
    return {
      prompt,
      tools: [...tools],
      timeoutMs,
      model,
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.jsonSchema === undefined ? {} : { jsonSchema: input.jsonSchema }),
    };
  }

  async function execute(
    input: PromptInput,
    { signal }: RunContext,
    hooks: RunHooks,
    progress: { queueMs: number },
  ): Promise<RunResult> {
    const request = toRunRequest(input);
    const queuedAt = clock.now();
    const slot = await queue.acquire(signal);
    try {
      progress.queueMs = Math.max(0, clock.now() - queuedAt);
      await hooks.onQueued?.(progress.queueMs);
      for await (const event of backend.stream(request, signal)) {
        if (event.type === "result") return event.result;
        await hooks.onEvent?.(event);
      }
      throw new AppError("cli_protocol_error", "Claude CLI exited without a result");
    } finally {
      slot.release();
    }
  }

  async function run(input: PromptInput, context: RunContext, hooks: RunHooks = {}) {
    const progress = { queueMs: 0 };
    try {
      const result = await execute(input, context, hooks, progress);
      logger.info(
        {
          requestId: context.requestId,
          queueMs: progress.queueMs,
          model: result.model,
          durationMs: result.durationMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
        },
        "prompt finished",
      );
      return { result, queueMs: progress.queueMs };
    } catch (error) {
      logger.info(
        {
          requestId: context.requestId,
          queueMs: progress.queueMs,
          code: error instanceof AppError ? error.code : "internal",
        },
        "prompt failed",
      );
      throw error;
    }
  }

  return { run, status: () => queue.stats() };
}
