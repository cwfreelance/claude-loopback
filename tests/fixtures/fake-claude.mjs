// Test double for the claude CLI, run as `node fake-claude.mjs`. FAKE_CLAUDE_SCENARIO picks the
// behaviour; tests never run the real CLI.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "echo";
const hang = () => setInterval(() => {}, 1 << 30);

/** @param {unknown} value */
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

switch (scenario) {
  case "echo": {
    // Reports what it was given, and leaves a file behind in its working directory.
    const stdin = await text(process.stdin);
    writeFileSync("scratch.txt", "left behind");
    emit({
      type: "echo",
      stdin,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      envKeys: Object.keys(process.env).sort(),
    });
    break;
  }
  case "fail":
    process.stderr.write("something went wrong\n");
    process.exitCode = 3;
    break;
  case "big-stderr":
    process.stderr.write(`${"x".repeat(200_000)}END-OF-STDERR`);
    process.exitCode = 1;
    break;
  case "hang":
    hang();
    break;
  case "grandchild": {
    // Detached, so it is outside this process's job object: only a real tree kill (/T)
    // takes it down, not the death of its parent.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    emit({ type: "grandchild", pid: child.pid });
    hang();
    break;
  }
  case "flood": {
    const chunk = "y".repeat(64 * 1024);
    const pump = () => {
      while (process.stdout.write(chunk)) {}
      process.stdout.once("drain", pump);
    };
    pump();
    break;
  }
  case "lines": {
    const count = Number(process.env.FAKE_CLAUDE_LINES ?? "3");
    for (let i = 0; i < count; i++) emit({ type: "line", i });
    break;
  }
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exitCode = 99;
}
