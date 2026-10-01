// Stands in for the server process in crash tests: starts the fake CLI through the real runner,
// prints the child's PID, then waits to be killed. Run with `node runner-host.ts <work-root>`.
import { fileURLToPath } from "node:url";
import { systemClock } from "../../src/clock.ts";
import { createLogger } from "../../src/logger.ts";
import { killTree } from "../../src/process/kill-tree.ts";
import { createProcessRunner } from "../../src/process/runner.ts";
import { createTempDirs } from "../../src/process/temp-dir.ts";

const root = process.argv[2];
if (!root) throw new Error("usage: runner-host.ts <work-root>");
const logger = createLogger({ level: "silent", logPrompts: false });
const runner = createProcessRunner({
  tempDirs: createTempDirs({ root, logger }),
  killTree,
  clock: systemClock,
  logger,
});
const run = await runner.start({
  command: process.execPath,
  args: [fileURLToPath(new URL("./fake-claude.mjs", import.meta.url))],
  stdin: "",
  env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", FAKE_CLAUDE_SCENARIO: "hang" },
  timeoutMs: 600_000,
});
process.stdout.write(`${JSON.stringify({ childPid: run.pid })}\n`);
setInterval(() => {}, 1 << 30);
