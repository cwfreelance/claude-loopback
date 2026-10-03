import { z } from "zod";
import { AppError, ERROR_CODES, type ErrorCode } from "../errors.ts";
import { deeperThan } from "../json-depth.ts";
import type { PromptInput } from "../service/prompt-service.ts";

const MAX_PROMPT_CHARS = 200_000;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
// systemPrompt and jsonSchema travel in argv, which Windows caps at ~32K characters.
const MAX_SYSTEM_PROMPT_CHARS = 16 * 1024;
const MAX_JSON_SCHEMA_CHARS = 16 * 1024;
const MAX_JSON_SCHEMA_DEPTH = 64;
const MAX_TOOLS = 32;

/** Request body for both prompt routes. Unknown fields are rejected. */
export const promptRequest = z.strictObject({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe("Up to 200 000 characters"),
  attachments: z
    .array(z.strictObject({ name: z.string().min(1).max(200), content: z.string() }))
    .max(MAX_ATTACHMENTS)
    .refine(
      (files) =>
        files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) <=
        MAX_ATTACHMENT_BYTES,
      { message: `attachments may total at most ${MAX_ATTACHMENT_BYTES} bytes` },
    )
    .optional()
    .describe("Up to 20 text files { name, content }, 2 MB total, put before the prompt"),
  model: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("One of LOOPBACK_ALLOWED_MODELS; default LOOPBACK_DEFAULT_MODEL"),
  systemPrompt: z
    .string()
    .max(MAX_SYSTEM_PROMPT_CHARS)
    .optional()
    .describe("Added to Claude Code's system prompt, up to 16 KB"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("How hard Claude thinks; low is fastest"),
  jsonSchema: z
    .record(z.string(), z.unknown())
    // Checked first, iteratively: JSON.stringify throws RangeError on very deep input.
    .refine((schema) => !deeperThan(schema, MAX_JSON_SCHEMA_DEPTH), {
      message: `may nest at most ${MAX_JSON_SCHEMA_DEPTH} levels deep`,
      abort: true,
    })
    .refine((schema) => JSON.stringify(schema).length <= MAX_JSON_SCHEMA_CHARS, {
      message: `must serialize to at most ${MAX_JSON_SCHEMA_CHARS} characters`,
    })
    .optional()
    .describe("JSON Schema for the answer, which then arrives in structuredOutput"),
  tools: z
    .array(z.string().min(1).max(64))
    .max(MAX_TOOLS)
    .optional()
    .describe("Tools to enable, only from LOOPBACK_ALLOWED_TOOLS (none by default)"),
  timeoutMs: z
    .number()
    .int()
    .optional()
    .describe("1000 up to LOOPBACK_MAX_TIMEOUT_MS; default LOOPBACK_DEFAULT_TIMEOUT_MS"),
});

/**
 * Validates a parsed JSON body. The error names the first offending field and what was
 * expected, never the value itself.
 */
export function parsePromptRequest(body: unknown): PromptInput {
  const parsed = promptRequest.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join(".") : "body";
  // Zod's unrecognized_keys message quotes the client's key names: never echo them.
  const rule =
    issue?.code === "unrecognized_keys" ? "unknown field" : (issue?.message ?? "invalid");
  throw new AppError("invalid_request", `${field}: ${rule}`);
}

// Response shapes. The server builds these bodies itself; the schemas exist for the OpenAPI
// document and for tests that check real responses against it.
const usage = z
  .strictObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
  })
  .describe("Token counts: inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens");

export const promptResponse = z.strictObject({
  id: z.string().describe("Request id, also sent as the X-Request-Id header"),
  text: z.string().describe("The answer"),
  structuredOutput: z.unknown().optional().describe("Present when jsonSchema was given"),
  model: z.string().describe("The model that ran"),
  stopReason: z.string().nullable().describe("Why the run stopped, e.g. end_turn"),
  durationMs: z.number().describe("How long the run took"),
  queueMs: z.number().describe("Time spent waiting for a free slot"),
  usage,
  costUsd: z.number().describe("The CLI's client-side cost estimate"),
});

export const readyResponse = z.strictObject({
  ready: z.boolean(),
  cli: z.strictObject({
    loggedIn: z.boolean(),
    version: z.string().optional(),
    reason: z.string().optional().describe("Why the CLI is not ready"),
  }),
  queue: z.strictObject({ active: z.number().int(), waiting: z.number().int() }),
});

export const healthResponse = z.strictObject({ status: z.literal("ok") });

export const errorResponse = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES as unknown as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    requestId: z.string(),
  }),
});

export const streamStart = z.strictObject({ model: z.string() });
export const streamDelta = z.strictObject({ text: z.string() });
export const streamRetry = z.strictObject({
  attempt: z.number().int(),
  maxRetries: z.number().int(),
  delayMs: z.number(),
  error: z.string().describe("API error category, e.g. overloaded or rate_limit"),
});
