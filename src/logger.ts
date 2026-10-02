import { styleText } from "node:util";
import { type DestinationStream, destination, type Logger, pino } from "pino";
import { isColorSupported, prettyFactory } from "pino-pretty";
import type { LogLevel } from "./config.ts";
import { AppError } from "./errors.ts";
import { formatLine } from "./log-format.ts";

export type { Logger };

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly logPrompts: boolean;
  readonly destination?: DestinationStream;
  /** "json" (default): one JSON object per line. "pretty": one readable line, for a terminal. */
  readonly format?: "json" | "pretty";
  /** Pretty format only. Default: on when the terminal supports it (honours NO_COLOR). */
  readonly colorize?: boolean;
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
  "stderrTail",
];

// Redact each key at the root and up to three levels down (enough for a request object with
// headers nested inside another object). Log calls should pass flat, purpose-built objects;
// this is the safety net, not the primary control.
const pathsFor = (keys: string[]) =>
  keys.flatMap((key) => {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
    return [segment.replace(/^\./, ""), `*${segment}`, `*.*${segment}`, `*.*.*${segment}`];
  });

// Type, code and (when safe) message only: no stack and no cause chain, which may wrap CLI
// stderr or paths. AppError messages are client-safe by contract; any other message may quote
// request content (e.g. JSON.parse errors echo the body), so it counts as content.
function errorSerializer(logPrompts: boolean) {
  return (error: unknown) => {
    if (!(error instanceof Error)) {
      return logPrompts ? { type: typeof error, message: String(error) } : { type: typeof error };
    }
    const code = (error as { code?: unknown }).code;
    const showMessage = logPrompts || error instanceof AppError;
    return {
      type: error.name,
      ...(showMessage ? { message: error.message } : {}),
      ...(code === undefined ? {} : { code }),
    };
  };
}

/**
 * Formats each JSON line pino writes into one readable line, synchronously (no worker thread),
 * then writes it on. Redaction and serializers have already run by then.
 */
function prettyStream(target: DestinationStream, colorize: boolean): DestinationStream {
  const prettify = prettyFactory({
    colorize,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
    hideObject: true,
    // formatLine colors the parts of the message itself; the time is dimmed.
    customColors: "message:reset",
    useOnlyCustomProps: false,
    customPrettifiers: {
      time: (time) =>
        colorize ? styleText("dim", String(time), { validateStream: false }) : String(time),
    },
    messageFormat: (log, _messageKey, _levelLabel, { colors }) => formatLine(log, colors),
  });
  return { write: (line: string) => target.write(prettify(line)) };
}

/**
 * Logger that always redacts credentials and, unless enabled, prompt/output contents. Writes
 * JSON lines, or readable (optionally colored) lines in the pretty format.
 */
export function createLogger(options: LoggerOptions): Logger {
  const keys = options.logPrompts ? CREDENTIAL_KEYS : [...CREDENTIAL_KEYS, ...CONTENT_KEYS];
  // A terminal gets synchronous writes, so log lines and the startup banner stay in order.
  const target = options.destination ?? destination({ dest: 1, sync: options.format === "pretty" });
  return pino(
    {
      level: options.level,
      base: undefined,
      redact: { paths: pathsFor(keys), censor: "[redacted]" },
      serializers: { err: errorSerializer(options.logPrompts) },
    },
    options.format === "pretty"
      ? prettyStream(target, options.colorize ?? isColorSupported)
      : target,
  );
}
