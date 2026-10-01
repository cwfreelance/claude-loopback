import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface Config {
  /** SHA-256 of LOOPBACK_TOKEN. The plaintext is never kept, so config can't leak it. */
  readonly tokenDigest: Buffer;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly claudePath: string | undefined;
  readonly maxConcurrency: number;
  readonly queueSize: number;
  readonly queueTimeoutMs: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly allowedTools: readonly string[];
  readonly allowedModels: readonly string[];
  readonly maxBodyBytes: number;
  readonly rateLimitPerMin: number;
  readonly corsOrigins: readonly string[];
  readonly logLevel: LogLevel;
  readonly logPrompts: boolean;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// The CLI caps piped stdin at 10 MB; keep request bodies well below it.
const MAX_BODY_BYTES_CAP = 8 * 1024 * 1024;
// RFC 6750 token68 charset: ASCII only, so header bytes and .env text always agree.
const TOKEN_CHARS = /^[A-Za-z0-9._~+/-]+=*$/;
const MIN_DISTINCT_TOKEN_CHARS = 8;
// Drive-letter absolute path only: no UNC (\\server), device (\\?\) or drive-relative paths.
const DRIVE_PATH = /^[A-Za-z]:[\\/][^:]*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;

const int = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`))
    .default(fallback);

const list = (item: RegExp | ((value: string) => boolean), what: string, fallback: string[]) =>
  z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .refine(
            (value) => (item instanceof RegExp ? item.test(value) : item(value)),
            `each entry must be ${what}`,
          ),
      ),
    )
    .default(fallback);

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    LOOPBACK_TOKEN: z
      .string({ error: "is required (generate one with `pnpm run token`)" })
      .min(32, "must be at least 32 characters (generate one with `pnpm run token`)")
      .regex(TOKEN_CHARS, "must use only A-Z a-z 0-9 . _ ~ + / - (and trailing =)")
      .refine(
        (value) => new Set(value).size >= MIN_DISTINCT_TOKEN_CHARS,
        "is too repetitive (generate one with `pnpm run token`)",
      ),
    LOOPBACK_HOST: z
      .literal("127.0.0.1", {
        error: "must be 127.0.0.1; loopback is the only supported bind address",
      })
      .default("127.0.0.1"),
    LOOPBACK_PORT: int(0, 65_535, 7337),
    LOOPBACK_CLAUDE_PATH: z
      .string()
      .refine(
        (value) =>
          DRIVE_PATH.test(value) && path.win32.basename(value).toLowerCase() === "claude.exe",
        "must be an absolute drive path to claude.exe, e.g. C:\\Users\\me\\.local\\bin\\claude.exe",
      )
      .optional(),
    LOOPBACK_MAX_CONCURRENCY: int(1, 16, 2),
    LOOPBACK_QUEUE_SIZE: int(0, 1000, 10),
    LOOPBACK_QUEUE_TIMEOUT_MS: int(0, 3_600_000, 60_000),
    LOOPBACK_DEFAULT_TIMEOUT_MS: int(1000, 3_600_000, 120_000),
    LOOPBACK_MAX_TIMEOUT_MS: int(1000, 3_600_000, 600_000),
    LOOPBACK_ALLOWED_TOOLS: list(TOOL_NAME, "a plain tool name such as WebSearch", []),
    LOOPBACK_ALLOWED_MODELS: list(MODEL_NAME, "a model alias or id", [
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]),
    LOOPBACK_MAX_BODY_BYTES: int(1024, MAX_BODY_BYTES_CAP, 4 * 1024 * 1024),
    LOOPBACK_RATE_LIMIT_PER_MIN: int(1, 10_000, 30),
    LOOPBACK_CORS_ORIGINS: list(isOrigin, "an origin such as http://127.0.0.1:3000", []),
    LOOPBACK_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
        error: "must be one of fatal, error, warn, info, debug, trace, silent",
      })
      .default("info"),
    LOOPBACK_LOG_PROMPTS: z
      .enum(["true", "false", "1", "0"], { error: "must be true, false, 1 or 0" })
      .transform((value) => value === "true" || value === "1")
      .default(false),
  })
  .strict()
  .superRefine((env, ctx) => {
    if (env.LOOPBACK_DEFAULT_TIMEOUT_MS > env.LOOPBACK_MAX_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["LOOPBACK_DEFAULT_TIMEOUT_MS"],
        message: "must not exceed LOOPBACK_MAX_TIMEOUT_MS",
      });
    }
  });

/**
 * Removes LOOPBACK_TOKEN and every ANTHROPIC_* variable from `env` (normally process.env) after
 * config is loaded, so no child process can inherit them even by mistake.
 */
export function scrubSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key === "LOOPBACK_TOKEN" || key.startsWith("ANTHROPIC_")) delete env[key];
  }
}

/**
 * Reads and validates LOOPBACK_* variables. Empty strings count as unset; unknown LOOPBACK_*
 * names are rejected so typos fail loudly. Error messages never include the values.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const relevant = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => key.startsWith("LOOPBACK_") && value !== ""),
  );
  const parsed = schema.safeParse(relevant);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `${key}: is not a known setting`)
        : [`${String(issue.path[0])}: ${issue.message}`],
    );
    throw new ConfigError(issues);
  }
  const e = parsed.data;
  return Object.freeze({
    tokenDigest: createHash("sha256").update(e.LOOPBACK_TOKEN).digest(),
    host: e.LOOPBACK_HOST,
    port: e.LOOPBACK_PORT,
    claudePath: e.LOOPBACK_CLAUDE_PATH,
    maxConcurrency: e.LOOPBACK_MAX_CONCURRENCY,
    queueSize: e.LOOPBACK_QUEUE_SIZE,
    queueTimeoutMs: e.LOOPBACK_QUEUE_TIMEOUT_MS,
    defaultTimeoutMs: e.LOOPBACK_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: e.LOOPBACK_MAX_TIMEOUT_MS,
    allowedTools: Object.freeze(e.LOOPBACK_ALLOWED_TOOLS),
    allowedModels: Object.freeze(e.LOOPBACK_ALLOWED_MODELS),
    maxBodyBytes: e.LOOPBACK_MAX_BODY_BYTES,
    rateLimitPerMin: e.LOOPBACK_RATE_LIMIT_PER_MIN,
    corsOrigins: Object.freeze(e.LOOPBACK_CORS_ORIGINS),
    logLevel: e.LOOPBACK_LOG_LEVEL,
    logPrompts: e.LOOPBACK_LOG_PROMPTS,
  });
}
