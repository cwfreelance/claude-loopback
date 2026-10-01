import { z } from "zod";
import { AppError } from "../errors.ts";
import type { PromptInput } from "../service/prompt-service.ts";

const MAX_PROMPT_CHARS = 200_000;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
// systemPrompt and jsonSchema travel in argv, which Windows caps at ~32K characters.
const MAX_SYSTEM_PROMPT_CHARS = 16 * 1024;
const MAX_JSON_SCHEMA_CHARS = 16 * 1024;
const MAX_TOOLS = 32;

/** Request body for both prompt routes. Unknown fields are rejected. */
export const promptRequest = z.strictObject({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  attachments: z
    .array(z.strictObject({ name: z.string().min(1).max(200), content: z.string() }))
    .max(MAX_ATTACHMENTS)
    .refine(
      (files) =>
        files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) <=
        MAX_ATTACHMENT_BYTES,
      { message: `attachments may total at most ${MAX_ATTACHMENT_BYTES} bytes` },
    )
    .optional(),
  model: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  jsonSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => JSON.stringify(schema).length <= MAX_JSON_SCHEMA_CHARS, {
      message: `must serialize to at most ${MAX_JSON_SCHEMA_CHARS} characters`,
    })
    .optional(),
  tools: z.array(z.string().min(1).max(64)).max(MAX_TOOLS).optional(),
  timeoutMs: z.number().int().optional(),
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
