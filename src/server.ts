import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { DestinationStream } from "pino";
import { createApp } from "./app.ts";
import { createCliBackend } from "./backends/cli/cli-backend.ts";
import { buildChildEnv } from "./backends/cli/env.ts";
import { isSupportedVersion, resolveClaudePath } from "./backends/cli/probe.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { acquireInstanceLock } from "./process/instance-lock.ts";
import { killTree } from "./process/kill-tree.ts";
import { createProcessRunner, type ProcessRunner } from "./process/runner.ts";
import { createTempDirs } from "./process/temp-dir.ts";
import { createPromptService, type PromptService } from "./service/prompt-service.ts";
import { createQueue } from "./service/queue.ts";
import { StartupError } from "./startup-error.ts";

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
  /** Graceful stop: see drain; then closes all connections and releases the instance lock. */
  close(options?: { graceMs?: number }): Promise<void>;
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

const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
// After in-flight runs are done, how long finished responses get to flush before every
// remaining connection (idle keep-alives, stalled streams) is dropped.
const FLUSH_MS = 1000;

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(
  app: { fetch: Parameters<typeof serve>[0]["fetch"] },
  host: string,
  port: number,
) {
  const server = serve({ fetch: app.fetch, hostname: host, port });
  try {
    await once(server, "listening");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      throw new StartupError(`cannot listen on ${host}:${port} (port in use or reserved)`, {
        cause: error,
      });
    }
    throw error;
  }
  return server as Server;
}

/**
 * Builds every layer and listens on 127.0.0.1, in this order:
 * config → claude.exe → instance lock → sweep leftover work dirs → CLI probe → listen.
 * Fails before listening with ConfigError (bad settings), AppError(cli_unavailable) (no
 * claude.exe) or StartupError (another instance, unusable or too old CLI, busy port). A CLI
 * that is merely logged out still starts; /ready reports it.
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
  const lock = await acquireInstanceLock(workRoot);
  try {
    const tempDirs = createTempDirs({ root: workRoot, logger });
    const swept = await tempDirs.sweep();
    if (swept > 0) logger.info({ swept }, "removed work dirs left by a previous run");

    const baseRunner = createProcessRunner({ tempDirs, killTree, clock, logger });
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

    const status = await backend.probe();
    if (status.version === undefined || !isSupportedVersion(status.version)) {
      throw new StartupError(status.reason ?? "Claude CLI is not usable");
    }
    if (!status.ready) {
      logger.warn(
        { reason: status.reason },
        "Claude CLI is not ready; /ready reports 503 until it is",
      );
    } else {
      logger.info({ version: status.version }, "Claude CLI ready");
    }

    const queue = createQueue({
      maxConcurrency: config.maxConcurrency,
      queueSize: config.queueSize,
      maxWaitMs: config.queueTimeoutMs,
      clock,
    });
    const service = createPromptService({ backend, queue, config, clock, logger });
    const app = createApp({ config, logger, service, backend, clock });
    const server = await listen(app, config.host, config.port);
    const { port } = server.address() as AddressInfo;
    logger.info({ host: config.host, port }, "listening");

    let closing: Promise<void> | undefined;
    const close = ({ graceMs = DEFAULT_SHUTDOWN_GRACE_MS }: { graceMs?: number } = {}) => {
      closing ??= (async () => {
        logger.info({ graceMs }, "shutting down");
        // Stop accepting; this resolves once every connection has closed.
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        await service.drain(graceMs);
        if (!(await settlesWithin(stopped, FLUSH_MS))) server.closeAllConnections();
        await stopped;
        await lock.release();
        logger.info("stopped");
      })();
      return closing;
    };

    return { host: config.host, port, workRoot, service, close };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
