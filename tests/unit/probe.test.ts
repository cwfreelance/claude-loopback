import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSupportedVersion,
  parseVersion,
  resolveClaudePath,
} from "../../src/backends/cli/probe.ts";
import { AppError } from "../../src/errors.ts";
import { scratchRoot } from "../helpers/process.ts";

describe("parseVersion", () => {
  it.each([
    ["2.1.287 (Claude Code)\n", "2.1.287"],
    ["2.1.259", "2.1.259"],
    ["10.0.1 (Claude Code)", "10.0.1"],
  ])("reads %j as %s", (output, version) => {
    expect(parseVersion(output)).toBe(version);
  });

  it.each(["", "Claude Code", "2.1", "v2.1.287"])("rejects %j", (output) => {
    expect(parseVersion(output)).toBeUndefined();
  });
});

describe("isSupportedVersion", () => {
  it.each([
    ["2.1.259", true],
    ["2.1.287", true],
    ["2.2.0", true],
    ["3.0.0", true],
    ["10.0.0", true],
    ["2.1.258", false],
    ["2.0.999", false],
    ["1.9.999", false],
  ])("%s → %s", (version, supported) => {
    expect(isSupportedVersion(version)).toBe(supported);
  });
});

describe("resolveClaudePath", () => {
  function dirWith(...files: string[]) {
    const dir = path.join(scratchRoot(), "bin");
    mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(path.join(dir, file), "");
    return dir;
  }

  const unavailable = async (promise: Promise<string>) => {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_unavailable");
    return error as AppError;
  };

  it("uses the configured path when the file exists", async () => {
    const exe = path.join(dirWith("claude.exe"), "claude.exe");
    expect(await resolveClaudePath(exe, {})).toBe(exe);
  });

  it("fails when the configured path does not exist", async () => {
    await unavailable(resolveClaudePath(path.join(scratchRoot(), "claude.exe"), {}));
  });

  it("finds claude.exe on PATH, whatever the variable's casing", async () => {
    const empty = dirWith();
    const bin = dirWith("claude.exe");
    expect(await resolveClaudePath(undefined, { Path: `${empty};${bin}` })).toBe(
      path.join(bin, "claude.exe"),
    );
  });

  it("refuses a .cmd shim and says how to fix it", async () => {
    const bin = dirWith("claude.cmd");
    const error = await unavailable(resolveClaudePath(undefined, { PATH: bin }));
    expect(error.message).toContain("LOOPBACK_CLAUDE_PATH");
  });

  it("ignores relative PATH entries", async () => {
    const bin = dirWith("claude.exe");
    const relative = path.relative(process.cwd(), bin);
    await unavailable(resolveClaudePath(undefined, { PATH: `.;${relative}` }));
  });

  it("fails when claude.exe is nowhere on PATH", async () => {
    await unavailable(resolveClaudePath(undefined, { PATH: dirWith() }));
  });
});
