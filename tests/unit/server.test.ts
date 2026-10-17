import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkRoot } from "../../src/server.ts";
import { StartupError } from "../../src/startup-error.ts";

const win32 = process.platform === "win32";

describe.runIf(win32)("defaultWorkRoot", () => {
  it("uses %LOCALAPPDATA%\\loopback\\work", () => {
    expect(defaultWorkRoot({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
      path.join("C:\\Users\\me\\AppData\\Local", "loopback", "work"),
    );
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", "AppData\\Local"],
    ["a UNC share", "\\\\server\\share"],
  ])("falls back to the OS temp dir when LOCALAPPDATA is %s", (_name, value) => {
    expect(defaultWorkRoot({ LOCALAPPDATA: value })).toBe(
      path.join(os.tmpdir(), "loopback", "work"),
    );
  });
});

describe.runIf(!win32)("defaultWorkRoot", () => {
  it("uses $XDG_CACHE_HOME/claude-loopback/work", () => {
    expect(defaultWorkRoot({ XDG_CACHE_HOME: "/home/me/.cache" })).toBe(
      "/home/me/.cache/claude-loopback/work",
    );
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", ".cache"],
  ])("falls back to $HOME/.cache when XDG_CACHE_HOME is %s", (_name, value) => {
    expect(defaultWorkRoot({ HOME: "/home/me", XDG_CACHE_HOME: value })).toBe(
      "/home/me/.cache/claude-loopback/work",
    );
  });

  it.each([[undefined], [""], ["relative/dir"]])(
    "refuses to guess when neither XDG_CACHE_HOME nor HOME is an absolute path (HOME %s)",
    (home) => {
      expect(() => defaultWorkRoot({ XDG_CACHE_HOME: "", HOME: home })).toThrow(StartupError);
      expect(() => defaultWorkRoot({ XDG_CACHE_HOME: "", HOME: home })).toThrow(/HOME/);
    },
  );
});
