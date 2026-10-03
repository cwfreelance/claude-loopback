import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Clock } from "../clock.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { killTreeSync as defaultKillTreeSync } from "./kill-tree.ts";
import type { TempDirs } from "./temp-dir.ts";

export interface RunSpec {
  /** Absolute path of the executable; never resolved through a shell. */
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  /** The complete child environment. Nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type KillReason = "timeout" | "aborted" | "output_too_large" | "shutdown";

export interface ProcessExit {
  readonly code: number | null;
  readonly killReason: KillReason | undefined;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface ProcessRun {
  readonly pid: number;
  /**
   * Raw stdout, pulled on demand so a slow consumer pushes back on the child. Single use.
   * Abandoning it early (break/return/throw) kills the process. A consumer that starts too late
   * gets an error rather than a silently empty stream.
   */
  readonly stdout: AsyncIterable<Buffer>;
  /** Resolves after the process has exited, stdio has closed and the temp dir is removed. */
  readonly exit: Promise<ProcessExit>;
  /** Kills the whole process tree. Idempotent; the first reason is the one reported. */
  kill(reason: KillReason): Promise<void>;
}

export interface ProcessRunner {
  start(spec: RunSpec): Promise<ProcessRun>;
  /**
   * Last resort before a forced exit: kills every active run's whole tree, synchronously. (The
   * job object only guarantees the direct children die with the server.)
   */
  killAllSync(): void;
}

export interface RunnerDeps {
  readonly tempDirs: TempDirs;
  /** Kills a process tree; rejects if it could not, so the runner can fall back. */
  readonly killTree: (pid: number) => Promise<void>;
  /** Synchronous variant for killAllSync (default: taskkill /T /F via execFileSync). */
  readonly killTreeSync?: (pid: number) => void;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxStdoutBytes?: number;
  readonly stderrTailBytes?: number;
  /** After exit, how long an unread or abandoned stdout may stay open before it is cut off. */
  readonly closeGraceMs?: number;
  /** Unread stdout held before the pipe is paused (and the child blocks on write). */
  readonly stdoutBufferBytes?: number;
}

const DEFAULT_MAX_STDOUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 2000;
const DEFAULT_STDOUT_BUFFER_BYTES = 1024 * 1024;

type Consumer = "idle" | "active" | "done";

async function spawnChild(spec: RunSpec, cwd: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(spec.command, [...spec.args], {
    cwd,
    env: { ...spec.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX: its own process group, so killTree can take the whole tree down and a Ctrl+C in
    // the server's terminal doesn't reach it. Never on Windows: there, detached would take the
    // child out of the job object that ends it with the server.
    detached: process.platform !== "win32",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

/** Resolves true if `promise` settles within `ms`, false otherwise. Leaves no timer behind. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise.then(() => true),
      delay(ms, false, { ref: false, signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}

export function createProcessRunner(deps: RunnerDeps): ProcessRunner {
  const { tempDirs, clock, logger } = deps;
  const maxStdoutBytes = deps.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const stderrTailBytes = deps.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const closeGraceMs = deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const killTreeSync = deps.killTreeSync ?? defaultKillTreeSync;
  // Force-kill hooks of the runs still alive, for killAllSync.
  const active = new Set<() => void>();

  async function start(spec: RunSpec): Promise<ProcessRun> {
    const cwd = await tempDirs.create();
    const started = clock.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await spawnChild(spec, cwd);
    } catch (error) {
      await tempDirs.remove(cwd);
      throw new AppError("cli_unavailable", "Claude CLI could not be started", { cause: error });
    }
    const pid = child.pid as number;

    // Attach every listener synchronously, so a fast exit can't be missed. Plain listeners, not
    // events.once(): that rejects on 'error', which would leave an unhandled rejection.
    let hasExited = false;
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        hasExited = true;
        resolve(code);
      });
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.on("error", (error) => logger.warn({ pid, err: error }, "child process error"));
    child.stdin.on("error", () => {}); // EPIPE: the child exited before reading all of stdin

    // stdout is read into our own queue: Node discards a pipe's unread data when it closes, so
    // relying on the stream's buffer would silently lose output for a late reader. The pipe is
    // paused at the high-water mark, so the child still blocks when nobody reads.
    const bufferBytes = deps.stdoutBufferBytes ?? DEFAULT_STDOUT_BUFFER_BYTES;
    const queue: Buffer[] = [];
    let queuedBytes = 0;
    let stdoutEnded = false;
    let stdoutFailure: Error | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      queue.push(chunk);
      queuedBytes += chunk.length;
      if (queuedBytes >= bufferBytes) child.stdout.pause();
      notify();
    });
    child.stdout.on("end", () => {
      stdoutEnded = true;
      notify();
    });
    child.stdout.on("close", () => {
      if (!stdoutEnded) stdoutFailure ??= new Error("stdout cut off before it was fully read");
      notify();
    });
    child.stdout.on("error", () => {});

    let stderrTail = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      const joined = Buffer.concat([stderrTail, chunk]);
      stderrTail = joined.subarray(Math.max(0, joined.length - stderrTailBytes));
    });

    let killReason: KillReason | undefined;
    let killing: Promise<void> | undefined;
    const kill = (reason: KillReason): Promise<void> => {
      // Once exited, the PID may already belong to another process: never kill it.
      if (killing || hasExited) return killing ?? Promise.resolve();
      killReason = reason;
      logger.info({ pid, reason }, "killing process tree");
      killing = deps.killTree(pid).catch((error: unknown) => {
        logger.warn({ pid, err: error }, "tree kill failed; terminating the process only");
        child.kill(); // through the handle, so it can't hit a reused PID
      });
      return killing;
    };

    const forceKill = () => {
      if (hasExited) return;
      killReason ??= "shutdown";
      killTreeSync(pid);
    };
    active.add(forceKill);

    const cutOff = (why: string) => {
      logger.warn({ pid, why }, "cutting off stdout after exit");
      stdoutFailure ??= new Error(`stdout cut off: ${why}`);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    // Deadlines stay armed until stdio closes: before exit they kill the tree; after exit they
    // cut off a pipe that some straggler or stalled reader is still holding open.
    const onDeadline = (reason: KillReason) => (hasExited ? cutOff(reason) : void kill(reason));
    const timer = clock.setTimeout(() => onDeadline("timeout"), spec.timeoutMs);
    const onAbort = () => onDeadline("aborted");
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.end(spec.stdin, "utf8");

    // Read through a function: narrowing would otherwise assume the generator never changes it.
    const reader: { state: Consumer } = { state: "idle" };
    const readerState = (): Consumer => reader.state;
    async function* stdout(): AsyncGenerator<Buffer> {
      reader.state = "active";
      let finished = false;
      try {
        let total = 0;
        for (;;) {
          const chunk = queue.shift();
          if (chunk === undefined) {
            // Queue drained: a cut-off stream fails rather than ending quietly.
            if (stdoutFailure) throw stdoutFailure;
            if (stdoutEnded) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          queuedBytes -= chunk.length;
          if (child.stdout.isPaused() && queuedBytes < bufferBytes / 2) child.stdout.resume();
          total += chunk.length;
          if (total > maxStdoutBytes) {
            const fits = chunk.length - (total - maxStdoutBytes);
            if (fits > 0) yield chunk.subarray(0, fits);
            void kill("output_too_large");
            return;
          }
          yield chunk;
        }
        finished = true;
      } finally {
        reader.state = "done";
        if (!finished) void kill("aborted");
      }
    }

    const exit = (async (): Promise<ProcessExit> => {
      const code = await exited;
      // A reader that is still pulling gets everything; only an unread or abandoned stream is
      // cut off after the grace period.
      while (readerState() !== "active" && !(await settlesWithin(closed, closeGraceMs))) {
        const state = readerState();
        if (state !== "active") cutOff(state === "idle" ? "never read" : "abandoned");
      }
      await closed;
      active.delete(forceKill);
      clock.clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      await killing;
      await tempDirs.remove(cwd);
      const durationMs = Math.max(0, clock.now() - started);
      logger.debug({ pid, code, killReason, durationMs }, "process exited");
      return { code, killReason, stderrTail: stderrTail.toString("utf8"), durationMs };
    })();

    logger.debug({ pid }, "process started");
    return { pid, stdout: stdout(), exit, kill };
  }

  function killAllSync(): void {
    for (const forceKill of active) forceKill();
  }

  return { start, killAllSync };
}
