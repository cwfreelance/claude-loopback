import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { type Clock, systemClock } from "../../clock.ts";
import { AppError } from "../../errors.ts";
import type { Logger } from "../../logger.ts";
import type { ProcessRunner } from "../../process/runner.ts";
import type { BackendStatus, ClaudeBackend, RunEvent, RunRequest, RunResult } from "../types.ts";
import { buildArgs } from "./args.ts";
import { classifyOutcome } from "./classify.ts";
import { isSupportedVersion, MIN_CLI_VERSION, parseVersion } from "./probe.ts";
import { type CliOutcome, interpretCliStream, splitLines } from "./stream-parser.ts";

const execFileAsync = promisify(execFile);

/** Runs a short CLI command (e.g. --version) and resolves with its stdout. */
export type ExecCli = (args: readonly string[]) => Promise<string>;

export interface CliBackendDeps {
  readonly runner: ProcessRunner;
  /** Absolute path of claude.exe (tests: node). */
  readonly command: string;
  /** Arguments placed before loopback's own (tests: the fake CLI script). */
  readonly prefixArgs?: readonly string[];
  /** The server tool allowlist; buildArgs refuses anything outside it. */
  readonly allowedTools: readonly string[];
  /** The complete child environment, from buildChildEnv. */
  readonly env: Readonly<Record<string, string>>;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly exec?: ExecCli;
  readonly probeTtlMs?: number;
}

const DEFAULT_PROBE_TTL_MS = 30_000;
const cancelled = () => new AppError("cancelled", "Run was cancelled");
const PROBE_TIMEOUT_MS = 15_000;

function defaultExec(
  command: string,
  prefix: readonly string[],
  env: Record<string, string>,
): ExecCli {
  return async (args) => {
    const { stdout } = await execFileAsync(command, [...prefix, ...args], {
      env,
      cwd: os.tmpdir(),
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout;
  };
}

export function createCliBackend(deps: CliBackendDeps): ClaudeBackend {
  const { runner, command, logger } = deps;
  const prefix = deps.prefixArgs ?? [];
  const env = { ...deps.env };
  const clock = deps.clock ?? systemClock;
  const exec = deps.exec ?? defaultExec(command, prefix, env);
  const probeTtlMs = deps.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;

  async function* stream(request: RunRequest, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const args = buildArgs(request, { allowedTools: deps.allowedTools });
    if (signal.aborted) throw cancelled();
    const run = await runner.start({
      command,
      args: [...prefix, ...args],
      stdin: request.prompt,
      env,
      timeoutMs: request.timeoutMs,
      signal,
    });
    const events = interpretCliStream(splitLines(run.stdout), logger);
    let finished = false;
    try {
      let outcome: CliOutcome;
      try {
        for (let next = await events.next(); ; next = await events.next()) {
          if (next.done) {
            outcome = next.value;
            break;
          }
          yield next.value;
        }
      } catch (error) {
        // A kill truncates the last line, so the reason for the kill (or the client's cancel)
        // explains a parse failure better than the garbled output does.
        await run.kill("aborted");
        const exit = await run.exit;
        if (signal.aborted) throw cancelled();
        if (exit.killReason !== undefined && exit.killReason !== "aborted") {
          classifyOutcome({}, exit, clock.now());
        }
        throw error instanceof AppError
          ? error
          : new AppError("cli_failed", "Claude CLI output could not be read", { cause: error });
      }
      const exit = await run.exit;
      logger.info(
        { pid: run.pid, code: exit.code, killReason: exit.killReason, durationMs: exit.durationMs },
        "claude run finished",
      );
      const result = classifyOutcome(outcome, exit, clock.now());
      if (request.jsonSchema !== undefined && result.structuredOutput === undefined) {
        throw new AppError("cli_failed", "Claude did not return structured output");
      }
      finished = true;
      yield { type: "result", result };
    } finally {
      if (!finished) {
        // Abandoned or failed: close the parser chain (so stdout counts as abandoned), make sure
        // the process is gone, and wait for cleanup.
        await events.return(undefined as never).catch(() => {});
        await run.kill("aborted");
        await run.exit;
      }
    }
  }

  async function run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    for await (const event of stream(request, signal)) {
      if (event.type === "result") return event.result;
    }
    throw new AppError("cli_protocol_error", "Claude CLI exited without a result");
  }

  async function probeOnce(): Promise<BackendStatus> {
    let version: string | undefined;
    try {
      version = parseVersion(await exec(["--version"]));
    } catch (error) {
      logger.warn({ err: error }, "claude --version failed");
      return { ready: false, loggedIn: false, reason: "Claude CLI could not be run" };
    }
    if (version === undefined) {
      return { ready: false, loggedIn: false, reason: "Could not read the Claude CLI version" };
    }
    if (!isSupportedVersion(version)) {
      return {
        ready: false,
        loggedIn: false,
        version,
        reason: `Claude CLI ${version} is older than the minimum supported ${MIN_CLI_VERSION}`,
      };
    }
    let loggedIn = false;
    try {
      const status: unknown = JSON.parse(await exec(["auth", "status", "--json"]));
      loggedIn =
        typeof status === "object" &&
        status !== null &&
        "loggedIn" in status &&
        status.loggedIn === true;
    } catch (error) {
      logger.warn({ err: error }, "claude auth status failed");
    }
    return loggedIn
      ? { ready: true, loggedIn: true, version }
      : {
          ready: false,
          loggedIn: false,
          version,
          reason: "Claude CLI is not logged in; run `claude` and /login",
        };
  }

  // The promise is cached, so concurrent callers share one in-flight probe (probeOnce never
  // rejects) instead of each spawning their own claude.exe processes.
  let cached: { at: number; status: Promise<BackendStatus> } | undefined;
  function probe(): Promise<BackendStatus> {
    const now = clock.now();
    if (cached && now - cached.at < probeTtlMs) return cached.status;
    const status = probeOnce();
    cached = { at: now, status };
    return status;
  }

  return { probe, stream, run };
}
