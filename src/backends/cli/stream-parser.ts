import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { deeperThan } from "../../json-depth.ts";
import type { Logger } from "../../logger.ts";
import type { RunEvent, RunResult } from "../types.ts";

export interface SplitOptions {
  /** Longest accepted line, in characters (default 1 MiB). */
  readonly maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

const lineTooLong = () =>
  new AppError("cli_protocol_error", "Claude CLI produced an oversized output line");

/**
 * Splits raw stdout into NDJSON lines. Chunks may end anywhere, including inside a multibyte
 * character, so bytes go through a StringDecoder and partial lines are held back.
 */
export async function* splitLines(
  chunks: AsyncIterable<Buffer>,
  { maxLineLength = DEFAULT_MAX_LINE_LENGTH }: SplitOptions = {},
): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  // The partial line is kept as pieces and joined once, so long lines aren't rescanned.
  let pending: string[] = [];
  let pendingLength = 0;
  const complete = function* (raw: string) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length > maxLineLength) throw lineTooLong();
    if (line.trim() !== "") yield line;
  };
  for await (const chunk of chunks) {
    let text = decoder.write(chunk);
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n")) {
      pending.push(text.slice(0, newline));
      const line = pending.join("");
      pending = [];
      pendingLength = 0;
      yield* complete(line);
      text = text.slice(newline + 1);
    }
    if (text !== "") {
      pending.push(text);
      pendingLength += text.length;
      if (pendingLength > maxLineLength) throw lineTooLong();
    }
  }
  yield* complete(pending.join("") + decoder.end());
}

export interface CliOutcome {
  /** The CLI's single `result` line, if one arrived. */
  readonly result?: {
    readonly isError: boolean;
    readonly subtype: string | undefined;
    readonly terminalReason: string | undefined;
    readonly value: RunResult;
  };
  /** Latest unresolved API error category (assistant error message or api_retry). */
  readonly errorCategory?: string;
  /** Latest subscription rate-limit status (`resetsAt` is epoch seconds). */
  readonly rateLimit?: { readonly status: string; readonly resetsAt?: number };
}

const resultLine = z.looseObject({
  type: z.literal("result"),
  subtype: z.string().optional(),
  terminal_reason: z.string().optional(),
  is_error: z.boolean(),
  result: z.string().default(""),
  stop_reason: z.string().nullable().default(null),
  duration_ms: z.number(),
  total_cost_usd: z.number().default(0),
  usage: z
    .looseObject({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .default({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" ? value : 0);

// Categories reach clients and logs; anything that isn't a CLI identifier becomes "unknown".
const SAFE_CATEGORY = /^[a-z_]{1,40}$/;
const category = (value: unknown) =>
  typeof value === "string" && SAFE_CATEGORY.test(value) ? value : "unknown";

// JSON.stringify throws past a few thousand levels; nothing legitimate comes close to this.
const MAX_STRUCTURED_DEPTH = 256;

function toRunResult(line: z.infer<typeof resultLine>, model: string | undefined): RunResult {
  return {
    text: line.result,
    ...(line.structured_output === undefined ? {} : { structuredOutput: line.structured_output }),
    model: model ?? Object.keys(line.modelUsage ?? {})[0] ?? "unknown",
    stopReason: line.stop_reason,
    durationMs: line.duration_ms,
    usage: {
      inputTokens: line.usage.input_tokens,
      outputTokens: line.usage.output_tokens,
      cacheReadTokens: line.usage.cache_read_input_tokens,
      cacheCreationTokens: line.usage.cache_creation_input_tokens,
    },
    costUsd: line.total_cost_usd,
  };
}

/**
 * Maps the CLI's stream-json events onto loopback's RunEvents: `start` from system/init, `delta`
 * from top-level text deltas (never thinking, tool input or subagent text), `retry` from
 * api_retry. The single `result` line and error signals are returned for classifyOutcome.
 * Unknown event types are ignored; one malformed line is tolerated, a second is fatal, as is a
 * second result line. Deltas after the result are dropped.
 */
export async function* interpretCliStream(
  lines: AsyncIterable<string>,
  logger: Logger,
): AsyncGenerator<RunEvent, CliOutcome> {
  let model: string | undefined;
  let errorCategory: string | undefined;
  let rateLimit: CliOutcome["rateLimit"];
  let result: CliOutcome["result"];
  let malformed = 0;

  for await (const line of lines) {
    let event: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) throw new Error("not an object");
      event = parsed;
    } catch {
      malformed++;
      if (malformed > 1) {
        throw new AppError("cli_protocol_error", "Claude CLI produced malformed output");
      }
      logger.warn({ length: line.length }, "skipping a malformed CLI output line");
      continue;
    }

    const topLevel = event.parent_tool_use_id === undefined || event.parent_tool_use_id === null;
    switch (event.type) {
      case "system":
        if (event.subtype === "init" && typeof event.model === "string") {
          model = event.model;
          yield { type: "start", model };
        } else if (event.subtype === "api_retry") {
          const error = category(event.error);
          errorCategory = error;
          yield {
            type: "retry",
            attempt: num(event.attempt),
            maxRetries: num(event.max_retries),
            delayMs: num(event.retry_delay_ms),
            error,
          };
        }
        break;
      case "stream_event": {
        const inner = event.event;
        if (
          result === undefined &&
          topLevel &&
          isObject(inner) &&
          inner.type === "content_block_delta" &&
          isObject(inner.delta) &&
          inner.delta.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          yield { type: "delta", text: inner.delta.text };
        }
        break;
      }
      case "assistant":
        // A normal top-level message means any earlier retry recovered.
        if (topLevel) errorCategory = event.error === undefined ? undefined : category(event.error);
        break;
      case "rate_limit_event": {
        const info = event.rate_limit_info;
        if (isObject(info) && typeof info.status === "string") {
          rateLimit = {
            status: info.status,
            ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
          };
        }
        break;
      }
      case "result": {
        if (result !== undefined) {
          throw new AppError("cli_protocol_error", "Claude CLI produced more than one result");
        }
        const parsed = resultLine.safeParse(event);
        if (!parsed.success || deeperThan(parsed.data.structured_output, MAX_STRUCTURED_DEPTH)) {
          throw new AppError("cli_protocol_error", "Claude CLI produced an unreadable result");
        }
        result = {
          isError: parsed.data.is_error,
          subtype: parsed.data.subtype,
          terminalReason: parsed.data.terminal_reason,
          value: toRunResult(parsed.data, model),
        };
        break;
      }
    }
  }

  return {
    ...(result === undefined ? {} : { result }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  };
}
