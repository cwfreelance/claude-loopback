import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scratchRoot } from "../helpers/process.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/install-hooks.mjs", import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

/** A copy of the package's scripts/install-hooks.mjs at <root>/scripts, as an install has it. */
function packageAt(root: string): string {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  const script = path.join(root, "scripts", "install-hooks.mjs");
  copyFileSync(SCRIPT, script);
  return script;
}

const run = (script: string, cwd: string) =>
  spawnSync(process.execPath, [script], { cwd, encoding: "utf8", windowsHide: true });

const hooksPath = (repo: string) => git(repo, "config", "core.hooksPath").stdout.trim();

// Spawns git and node several times per test, which can take seconds on a busy Windows machine.
describe("scripts/install-hooks.mjs (the prepare step)", { timeout: 20_000 }, () => {
  it("succeeds without touching anything outside a git checkout (e.g. a ZIP download)", () => {
    const root = scratchRoot();
    const result = run(packageAt(root), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping");
  });

  it("points git at .githooks when the package is the root of its own checkout", () => {
    const repo = scratchRoot();
    git(repo, "init", "-q");
    const result = run(packageAt(repo), repo);
    expect(result.status).toBe(0);
    expect(hooksPath(repo)).toBe(".githooks");
  });

  it("never touches an enclosing repo the package was extracted or vendored into", () => {
    const outer = scratchRoot();
    git(outer, "init", "-q");
    const pkg = path.join(outer, "vendor", "claude-loopback");
    const result = run(packageAt(pkg), pkg);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping");
    expect(hooksPath(outer)).toBe("");
  });

  it("leaves a different hooks path that is already configured alone", () => {
    const repo = scratchRoot();
    git(repo, "init", "-q");
    git(repo, "config", "core.hooksPath", ".husky");
    const result = run(packageAt(repo), repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".husky");
    expect(hooksPath(repo)).toBe(".husky");
  });
});
