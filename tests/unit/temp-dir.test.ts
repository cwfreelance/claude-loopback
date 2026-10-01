import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDirs } from "../../src/process/temp-dir.ts";
import { captureLogger, scratchRoot } from "../helpers/process.ts";

function setup(rm?: typeof import("node:fs/promises").rm) {
  const root = path.join(scratchRoot(), "work");
  const log = captureLogger();
  const tempDirs = createTempDirs({ root, logger: log.logger, ...(rm ? { rm } : {}) });
  return { root, tempDirs, ...log };
}

describe("createTempDirs", () => {
  it("creates a fresh, unique req-* directory under the root for each call", async () => {
    const { root, tempDirs } = setup();
    const a = await tempDirs.create();
    const b = await tempDirs.create();
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(path.dirname(dir)).toBe(root);
      expect(path.basename(dir)).toMatch(/^req-/);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it("removes a directory and everything in it", async () => {
    const { tempDirs } = setup();
    const dir = await tempDirs.create();
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "nested", "file.txt"), "data");
    await tempDirs.remove(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("treats removing a missing directory as success", async () => {
    const { root, tempDirs } = setup();
    await expect(tempDirs.remove(path.join(root, "req-gone"))).resolves.toBeUndefined();
  });

  it("refuses to remove anything outside its root", async () => {
    const { root, tempDirs, entries } = setup();
    const outside = path.join(path.dirname(root), "precious");
    mkdirSync(outside);
    await tempDirs.remove(outside);
    await tempDirs.remove(root);
    await tempDirs.remove(path.join(root, "req-x", "..", "..", "precious"));
    expect(existsSync(outside)).toBe(true);
    expect(entries().some((entry) => entry.level === 50)).toBe(true);
  });

  it("logs instead of throwing when removal keeps failing", async () => {
    const failing = (async () => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    }) as unknown as typeof import("node:fs/promises").rm;
    const { tempDirs, entries } = setup(failing);
    const dir = await tempDirs.create();
    await expect(tempDirs.remove(dir)).resolves.toBeUndefined();
    expect(entries().find((entry) => entry.level === 40)).toMatchObject({ code: "EBUSY" });
  });

  it("sweeps leftover req-* directories and leaves other entries alone", async () => {
    const { root, tempDirs } = setup();
    await tempDirs.create();
    const leftover = await tempDirs.create();
    writeFileSync(path.join(leftover, "partial.txt"), "x");
    writeFileSync(path.join(root, "pids.json"), "[]");
    expect(await tempDirs.sweep()).toBe(2);
    expect(readdirSync(root)).toEqual(["pids.json"]);
  });

  it("sweeps nothing when the root does not exist yet", async () => {
    const { tempDirs } = setup();
    expect(await tempDirs.sweep()).toBe(0);
  });
});
