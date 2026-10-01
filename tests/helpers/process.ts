import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../src/clock.ts";
import { systemClock } from "../../src/clock.ts";
import { createLogger } from "../../src/logger.ts";
import { killTree } from "../../src/process/kill-tree.ts";
import { createProcessRunner, type RunSpec } from "../../src/process/runner.ts";
import { createTempDirs } from "../../src/process/temp-dir.ts";

export const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

/** A fresh, empty directory under the OS temp dir for one test. */
export function scratchRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "loopback-test-"));
}

export function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level: "debug", logPrompts: false, destination });
  return {
    logger,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export interface RunnerOptions {
  clock?: Clock;
  maxStdoutBytes?: number;
  stderrTailBytes?: number;
  closeGraceMs?: number;
  stdoutBufferBytes?: number;
}

/** The real runner with real temp dirs and tree kill, rooted in a scratch dir. */
export function makeRunner({ clock = systemClock, ...limits }: RunnerOptions = {}) {
  const root = scratchRoot();
  const { logger, entries } = captureLogger();
  const tempDirs = createTempDirs({ root: path.join(root, "work"), logger });
  const runner = createProcessRunner({ tempDirs, killTree, clock, logger, ...limits });
  return { runner, root, workRoot: path.join(root, "work"), logs: entries };
}

/** A RunSpec that runs the fake CLI with the given scenario. */
export function fakeSpec(scenario: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    command: process.execPath,
    args: [FAKE_CLAUDE],
    stdin: "",
    env: {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      FAKE_CLAUDE_SCENARIO: scenario,
    },
    timeoutMs: 30_000,
    ...overrides,
  };
}

export async function collect(stream: AsyncIterable<Buffer>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString("utf8");
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until the process is gone; rejects after the deadline. */
export async function waitForDeath(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
