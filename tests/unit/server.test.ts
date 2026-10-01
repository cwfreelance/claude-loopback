import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkRoot } from "../../src/server.ts";

describe("defaultWorkRoot", () => {
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
