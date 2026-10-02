import { z } from "zod";
import { ERROR_CODES, type ErrorCode, errorStatus } from "../errors.ts";
import {
  errorResponse,
  healthResponse,
  promptRequest,
  promptResponse,
  readyResponse,
  streamDelta,
  streamRetry,
  streamStart,
} from "./schemas.ts";

type Json = Record<string, unknown>;

/** JSON Schema (draft 2020-12, as OpenAPI 3.1 uses) for one Zod schema. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io }) as Json;
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ "application/json": { schema: ref(name) } });

/** One response entry per status, naming the error codes that use it. */
function errorResponses(statuses: number[]): Json {
  return Object.fromEntries(
    statuses.map((status) => {
      const codes = ERROR_CODES.filter((code: ErrorCode) => errorStatus(code) === status);
      return [String(status), { description: codes.join(", "), content: json("Error") }];
    }),
  );
}

const STREAM_DESCRIPTION = [
  "Server-sent events. `start` {model}, `delta` {text} and `retry` {attempt, maxRetries,",
  "delayMs, error} arrive as the run progresses, then exactly one `result` (the PromptResponse",
  "body) or `error` (the Error body), then the stream ends. `: ping` comments are sent every",
  "15 s. Errors before the run holds a queue slot are plain JSON responses instead.",
].join(" ");

/**
 * The OpenAPI 3.1 document, generated from the same Zod schemas the server validates with.
 * `pnpm run openapi` writes it to docs/openapi.json; a test keeps the two in sync.
 */
export function buildOpenApiDocument(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "claude-loopback",
      version: "1.0.0",
      description:
        "Personal, localhost-only HTTP bridge that runs prompts through Claude Code's headless " +
        "mode (claude -p). Bound to 127.0.0.1; every route except /health and /openapi.json " +
        "needs the bearer token from LOOPBACK_TOKEN.",
    },
    servers: [{ url: "http://127.0.0.1:7337" }],
    security: [{ bearer: [] }],
    paths: {
      "/health": {
        get: {
          summary: "Process is alive",
          security: [],
          responses: { 200: { description: "Alive", content: json("Health") } },
        },
      },
      "/openapi.json": {
        get: {
          summary: "This document",
          security: [],
          responses: {
            200: {
              description: "OpenAPI 3.1 document",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/ready": {
        get: {
          summary: "Claude CLI found, supported and logged in; queue counters",
          responses: {
            200: { description: "Ready", content: json("Ready") },
            503: { description: "Not ready (see cli.reason)", content: json("Ready") },
            ...errorResponses([401, 403, 429]),
          },
        },
      },
      "/v1/prompt": {
        post: {
          summary: "Run a prompt and wait for the result",
          requestBody: { required: true, content: json("PromptRequest") },
          responses: {
            200: { description: "Finished run", content: json("PromptResponse") },
            ...errorResponses([400, 401, 403, 413, 415, 429, 502, 503, 504]),
          },
        },
      },
      "/v1/prompt/stream": {
        post: {
          summary: "Run a prompt and stream its progress as server-sent events",
          requestBody: { required: true, content: json("PromptRequest") },
          responses: {
            200: {
              description: STREAM_DESCRIPTION,
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errorResponses([400, 401, 403, 413, 415, 429, 503]),
          },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        PromptRequest: jsonSchema(promptRequest, "input"),
        PromptResponse: jsonSchema(promptResponse, "output"),
        Ready: jsonSchema(readyResponse, "output"),
        Health: jsonSchema(healthResponse, "output"),
        Error: jsonSchema(errorResponse, "output"),
        StreamStart: jsonSchema(streamStart, "output"),
        StreamDelta: jsonSchema(streamDelta, "output"),
        StreamRetry: jsonSchema(streamRetry, "output"),
      },
    },
  };
}
