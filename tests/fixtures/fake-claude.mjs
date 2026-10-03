// Test double for the claude CLI, run as `node fake-claude.mjs`. FAKE_CLAUDE_SCENARIO picks the
// behaviour; tests never run the real CLI.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "echo";
const hang = () => setInterval(() => {}, 1 << 30);
const args = process.argv.slice(2);

/** @param {unknown} value */
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Probe commands answer the same way in every scenario.
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.287 (Claude Code)"}\n`);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  emit({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== "false", authMethod: "claude.ai" });
  process.exit(0);
}

switch (scenario) {
  case "replay": {
    // Replays a captured stream-json fixture, then exits like the real CLI did.
    await text(process.stdin);
    const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "0");
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const fixture = process.env.FAKE_CLAUDE_FIXTURE;
    if (fixture) process.stdout.write(readFileSync(fixture, "utf8"));
    const stderr = process.env.FAKE_CLAUDE_STDERR_FILE;
    if (stderr) process.stderr.write(readFileSync(stderr, "utf8"));
    process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? "0");
    break;
  }
  case "echo-result": {
    // Reports what it was given as the text of a valid result, so it is visible over HTTP.
    const stdin = await text(process.stdin);
    const report = {
      stdin,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      env: process.env,
    };
    emit({ type: "system", subtype: "init", model: "fake-model" });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(report),
      stop_reason: "end_turn",
      duration_ms: 1,
    });
    break;
  }
  case "delta-flood": {
    // Streams text deltas as fast as stdout accepts them, forever.
    emit({ type: "system", subtype: "init", model: "fake-model" });
    const line = `${JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "z".repeat(1024) },
      },
    })}\n`;
    const pump = () => {
      while (process.stdout.write(line)) {}
      process.stdout.once("drain", pump);
    };
    pump();
    break;
  }
  case "init-then-hang":
    emit({ type: "system", subtype: "init", model: "fake-model" });
    hang();
    break;
  case "garbage-then-hang":
    // A stray non-JSON line, then a line cut off mid-way (as a kill would leave it).
    process.stdout.write('not json at all\n{"type":"system","subtype":"ini');
    hang();
    break;
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
  case "exit-on-sigterm":
    // Exits cleanly when asked; says when it is listening, so a signal can't arrive too early.
    process.on("SIGTERM", () => process.exit(0));
    emit({ type: "ready" });
    hang();
    break;
  case "ignore-sigterm":
    process.on("SIGTERM", () => {});
    emit({ type: "ready" });
    hang();
    break;
  case "grandchild": {
    // On Windows, detached puts it outside this process's job object: only a real tree kill
    // (/T) takes it down, not the death of its parent. Elsewhere it stays in this process's
    // group (detached would be setsid, which escapes the group kill; see kill-tree.ts).
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
      detached: process.platform === "win32",
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
