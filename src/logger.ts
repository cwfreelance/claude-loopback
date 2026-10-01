import { type DestinationStream, destination, type Logger, pino } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly logPrompts: boolean;
  readonly destination?: DestinationStream;
}

const CREDENTIAL_KEYS = [
  "authorization",
  "Authorization",
  "token",
  "apiKey",
  "x-api-key",
  "cookie",
  "rawHeaders",
  "LOOPBACK_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];
const CONTENT_KEYS = [
  "prompt",
  "systemPrompt",
  "attachments",
  "output",
  "text",
  "result",
  "structuredOutput",
  "delta",
  "line",
  "body",
  "stderr",
];

// Redact each key at the root and up to three levels down (enough for a request object with
// headers nested inside another object). Log calls should pass flat, purpose-built objects;
// this is the safety net, not the primary control.
const pathsFor = (keys: string[]) =>
  keys.flatMap((key) => {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
    return [segment.replace(/^\./, ""), `*${segment}`, `*.*${segment}`, `*.*.*${segment}`];
  });

// Only type, message and code: no stack and no cause chain, which may wrap CLI stderr or paths.
function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  const code = (error as { code?: unknown }).code;
  return { type: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
}

/** JSON logger that always redacts credentials and, unless enabled, prompt/output contents. */
export function createLogger(options: LoggerOptions): Logger {
  const keys = options.logPrompts ? CREDENTIAL_KEYS : [...CREDENTIAL_KEYS, ...CONTENT_KEYS];
  return pino(
    {
      level: options.level,
      base: undefined,
      redact: { paths: pathsFor(keys), censor: "[redacted]" },
      serializers: { err: serializeError },
    },
    options.destination ?? destination(1),
  );
}
