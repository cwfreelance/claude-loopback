import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { DestinationStream } from "pino";
import { createApp } from "./app.ts";
import { createCliBackend } from "./backends/cli/cli-backend.ts";
import { buildChildEnv } from "./backends/cli/env.ts";
import { resolveClaudePath } from "./backends/cli/probe.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { killTree } from "./process/kill-tree.ts";
import { createProcessRunner, type ProcessRunner } from "./process/runner.ts";
import { createTempDirs } from "./process/temp-dir.ts";
import { createPromptService, type PromptService } from "./service/prompt-service.ts";
import { createQueue } from "./service/queue.ts";

export interface StartOptions {
  /** Where LOOPBACK_* settings come from (a snapshot of process.env in production). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests only: run this command (e.g. node + the fake CLI) instead of resolving claude.exe. */
  readonly claude?: {
    readonly command: string;
    readonly prefixArgs?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  };
  /** Per-request work dirs go under here (default %LOCALAPPDATA%\loopback\work). */
  readonly workRoot?: string;
  readonly logDestination?: DestinationStream;
  /** Tests only: observe or wrap the process runner. */
  readonly wrapRunner?: (runner: ProcessRunner) => ProcessRunner;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  /** Where per-request work dirs are created. */
  readonly workRoot: string;
  readonly service: PromptService;
  close(): Promise<void>;
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * %LOCALAPPDATA%loopbackwork, or the OS temp dir when LOCALAPPDATA isn't a drive-absolute path:
 * an empty or relative value would otherwise resolve inside the current directory (the repo).
 */
export function defaultWorkRoot(env: Readonly<Record<string, string | undefined>>): string {
  const base = env.LOCALAPPDATA;
  const root = base !== undefined && DRIVE_ABSOLUTE.test(base) ? base : os.tmpdir();
  return path.join(root, "loopback", "work");
}

/**
 * Builds every layer (config → logger → runner → CLI backend → queue → service → app) and
 * listens on 127.0.0.1. Throws ConfigError for bad settings and AppError(cli_unavailable) when
 * claude.exe can't be found, before anything listens.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { env } = options;
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    logPrompts: config.logPrompts,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  });
  const clock = systemClock;

  const command = options.claude?.command ?? (await resolveClaudePath(config.claudePath, env));
  const workRoot = options.workRoot ?? defaultWorkRoot(env);
  const baseRunner = createProcessRunner({
    tempDirs: createTempDirs({ root: workRoot, logger }),
    killTree,
    clock,
    logger,
  });
  const runner = options.wrapRunner ? options.wrapRunner(baseRunner) : baseRunner;
  const backend = createCliBackend({
    runner,
    command,
    prefixArgs: options.claude?.prefixArgs ?? [],
    allowedTools: config.allowedTools,
    env: { ...buildChildEnv(env), ...options.claude?.env },
    logger,
    clock,
  });
  const queue = createQueue({
    maxConcurrency: config.maxConcurrency,
    queueSize: config.queueSize,
    maxWaitMs: config.queueTimeoutMs,
    clock,
  });
  const service = createPromptService({ backend, queue, config, clock, logger });
  const app = createApp({ config, logger, service, backend, clock });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  await once(server, "listening"); // rejects on 'error', e.g. port already in use
  const { port } = server.address() as AddressInfo;
  logger.info({ host: config.host, port }, "listening");

  return {
    host: config.host,
    port,
    workRoot,
    service,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
