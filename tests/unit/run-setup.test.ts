import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettingsFile, readSettings, runSetup, type SetupOptions } from "../../src/setup.ts";
import { scratchRoot } from "../helpers/process.ts";

function setup(overrides: Partial<SetupOptions> = {}) {
  const lines: string[] = [];
  const file = overrides.file ?? path.join(scratchRoot(), "config.env");
  const promise = runSetup({
    file,
    template: "LOOPBACK_TOKEN=\n",
    label: "config.env",
    rerun: "claude-loopback setup",
    next: "claude-loopback",
    env: {},
    print: (line) => lines.push(line),
    ...overrides,
  });
  return promise.then((problems) => ({ problems, output: lines.join("\n"), file }));
}

/** An empty file named claude.exe: it resolves, but can't run (so the real CLI is never used). */
function dummyClaude(): string {
  const file = path.join(scratchRoot(), "claude.exe");
  writeFileSync(file, "");
  return file;
}

describe("runSetup", () => {
  it("creates the settings and is ready when checks are skipped", async () => {
    const { problems, output, file } = await setup({ skipChecks: true });
    expect(problems).toBe(0);
    expect(output).toContain("created config.env with a new random token");
    expect(output).toContain("readable only by your account");
    expect(output).toContain("Ready. Next: claude-loopback");
    expect(output).not.toContain(/^LOOPBACK_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]);
  }, 20_000);

  it("reports a claude.exe that can't run, naming the settings file to fix", async () => {
    const dir = scratchRoot();
    const file = path.join(dir, "config.env");
    writeFileSync(file, `LOOPBACK_CLAUDE_PATH=${dummyClaude()}\n`);
    const { problems, output } = await setup({ file });
    expect(problems).toBe(1);
    expect(output).toContain("Node.js");
    expect(output).toContain("could not run");
    expect(output).toContain("set LOOPBACK_CLAUDE_PATH in config.env");
    expect(output).toContain("1 thing(s) to fix above, then run claude-loopback setup again.");
  }, 20_000);

  it("reports a claude.exe that doesn't exist", async () => {
    const { problems, output } = await setup({
      env: { LOOPBACK_CLAUDE_PATH: path.join(scratchRoot(), "missing", "claude.exe") },
    });
    expect(problems).toBe(1);
    expect(output).toContain("install Claude Code");
  }, 20_000);

  it("checks the settings the way the server will, before running anything", async () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, "LOOPBACK_CLAUDE_PATH=bin\\claude.exe\nLOOPBACK_PORT=nope\n");
    const { problems, output } = await setup({ file });
    expect(problems).toBe(1);
    expect(output).toContain("LOOPBACK_CLAUDE_PATH");
    expect(output).toContain("LOOPBACK_PORT");
    expect(output).not.toContain("could not run");
  }, 20_000);

  it("reports a settings file it can't write instead of crashing", async () => {
    const file = path.join(scratchRoot(), "config.env");
    mkdirSync(file); // a folder where the file should be
    const { problems, output } = await setup({ file, skipChecks: true });
    expect(problems).toBe(1);
    expect(output).toContain("could not write config.env");
  }, 20_000);

  it("warns, when asked to, about a project outside the user folder", async () => {
    const outside = await setup({
      skipChecks: true,
      warnOutsideProfile: true,
      env: { USERPROFILE: path.join(scratchRoot(), "someone-else") },
    });
    expect(outside.problems).toBe(0);
    expect(outside.output).toContain("outside your user folder");
    const notAsked = await setup({
      skipChecks: true,
      env: { USERPROFILE: path.join(scratchRoot(), "someone-else") },
    });
    expect(notAsked.output).not.toContain("outside your user folder");
  }, 20_000);
});

describe("defaultSettingsFile", () => {
  it("uses %APPDATA%\\claude-loopback\\config.env", () => {
    expect(defaultSettingsFile({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" })).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\claude-loopback\\config.env",
    );
  });

  it.each([[undefined], [""], ["relative\\dir"], ["\\\\server\\share"]])(
    "falls back to the user profile folder when APPDATA is %s",
    (appData) => {
      const env = {
        USERPROFILE: "C:\\Users\\me",
        ...(appData === undefined ? {} : { APPDATA: appData }),
      };
      expect(defaultSettingsFile(env)).toBe("C:\\Users\\me\\.claude-loopback\\config.env");
    },
  );

  it.each([[undefined], ["relative\\dir"], ["\\\\server\\share"]])(
    "refuses to guess when neither APPDATA nor USERPROFILE is a drive path (USERPROFILE %s)",
    (profile) => {
      const env = { APPDATA: "", ...(profile === undefined ? {} : { USERPROFILE: profile }) };
      expect(() => defaultSettingsFile(env)).toThrow(/APPDATA/);
    },
  );
});

describe("readSettings", () => {
  it("lets an environment variable override the file whatever its letter case", () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, "LOOPBACK_PORT=8080\n");
    const settings = readSettings(file, { Loopback_Port: "9090" });
    expect(settings.LOOPBACK_PORT).toBe("9090");
    expect(
      Object.keys(settings).filter((key) => key.toUpperCase() === "LOOPBACK_PORT"),
    ).toHaveLength(1);
  });

  it("reads the file, with environment variables taking precedence", () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, '# comment\nLOOPBACK_PORT=8080\nLOOPBACK_LOG_LEVEL="debug"\n');
    expect(readSettings(file, { LOOPBACK_PORT: "9090" })).toMatchObject({
      LOOPBACK_PORT: "9090",
      LOOPBACK_LOG_LEVEL: "debug",
    });
  });
});
