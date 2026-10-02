import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { scratchRoot } from "../helpers/process.ts";
import { ROOT } from "../helpers/server.ts";

const CLI = path.join(ROOT, "src", "cli.ts");
const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** An empty file named claude.exe: it resolves, but can't run, so no test reaches the real CLI. */
function dummyClaude(): string {
  const file = path.join(scratchRoot(), "claude.exe");
  writeFileSync(file, "");
  return file;
}

/** A fresh user profile: per-user settings, work dirs and the lock all live in scratch dirs. */
function profile() {
  const appData = scratchRoot();
  return {
    appData,
    configFile: path.join(appData, "claude-loopback", "config.env"),
    env: { APPDATA: appData, LOCALAPPDATA: scratchRoot(), LOOPBACK_CLAUDE_PATH: dummyClaude() },
  };
}

function cli(args: string[], env: Record<string, string>, cwd = scratchRoot()) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("LOOPBACK_")),
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...inherited, ...env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
}

const tokenIn = (file: string) => /^LOOPBACK_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1];

describe("claude-loopback (the npm command)", () => {
  it("on first run creates the settings file with a new token it never prints, then starts", () => {
    const { configFile, env } = profile();
    const result = cli([], env);
    // The dummy claude.exe can't run, so startup stops at the CLI check, cleanly.
    expect(result.status).toBe(1);
    expect(existsSync(configFile)).toBe(true);
    const token = tokenIn(configFile) ?? "";
    expect(() => loadConfig({ LOOPBACK_TOKEN: token })).not.toThrow();
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout).toContain(configFile);
    expect(result.stderr).toContain("Claude CLI");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, 30_000);

  it("treats `start` the same as no command", () => {
    const { configFile, env } = profile();
    const result = cli(["start"], env);
    expect(result.status).toBe(1);
    expect(existsSync(configFile)).toBe(true);
    expect(result.stderr).toContain("Claude CLI");
  }, 30_000);

  it("keeps the token across runs", () => {
    const { configFile, env } = profile();
    cli([], env);
    const first = tokenIn(configFile);
    cli([], env);
    expect(tokenIn(configFile)).toBe(first);
  }, 30_000);

  it("reads settings from the file, with real environment variables taking precedence", () => {
    const { configFile, env } = profile();
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, "LOOPBACK_PORT=not-a-port\n");
    const fromFile = cli([], env);
    expect(fromFile.status).toBe(1);
    expect(fromFile.stderr).toContain("LOOPBACK_PORT");

    const overridden = cli([], { ...env, LOOPBACK_PORT: "0" });
    expect(overridden.status).toBe(1);
    expect(overridden.stderr).not.toContain("LOOPBACK_PORT");
    expect(overridden.stderr).toContain("Claude CLI");
  }, 30_000);

  it("ignores a .env in the current folder (it belongs to whatever project is there)", () => {
    const { env } = profile();
    const project = scratchRoot();
    writeFileSync(path.join(project, ".env"), "LOOPBACK_PORT=not-a-port\n");
    const result = cli([], env, project);
    expect(result.stderr).not.toContain("LOOPBACK_PORT");
    expect(result.stderr).toContain("Claude CLI");
  }, 30_000);

  it("`token` prints exactly the stored token, creating the settings if needed", () => {
    const { configFile, env } = profile();
    const result = cli(["token"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${tokenIn(configFile)}\n`);
    expect(cli(["token"], env).stdout).toBe(result.stdout);
  }, 30_000);

  it("`config` prints the settings file's path", () => {
    const { configFile, env } = profile();
    const result = cli(["config"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${configFile}\n`);
  }, 30_000);

  it("`setup` creates the settings, checks the machine and reports what to fix", () => {
    const { configFile, env } = profile();
    const result = cli(["setup"], env);
    expect(existsSync(configFile)).toBe(true);
    const token = tokenIn(configFile);
    // Node is fine; the dummy claude.exe can't run, which setup reports with a fix.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Node.js");
    expect(result.stdout).toContain("could not run");
    expect(result.stdout).toContain("claude-loopback setup");
    expect(result.stdout).not.toContain(token);

    cli(["setup"], env);
    expect(tokenIn(configFile)).toBe(token);
  }, 30_000);

  it.each([["--version"], ["-v"]])("%s prints the package version", (flag) => {
    const result = cli([flag], profile().env);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it.each([["--help"], ["-h"], ["help"]])("%s lists the commands", (flag) => {
    const result = cli([flag], profile().env);
    expect(result.status).toBe(0);
    for (const command of ["start", "setup", "token", "config"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("rejects an unknown command with usage and exit code 1, creating nothing", () => {
    const { configFile, env } = profile();
    const result = cli(["strat"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("strat");
    expect(result.stderr).toContain("Usage");
    expect(existsSync(configFile)).toBe(false);
  });
});
