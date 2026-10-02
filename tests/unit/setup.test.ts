import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { aclSids, grantExplicitly, makeSharedDir, onlyOwnerAccess, SID } from "../helpers/acl.ts";
import { scratchRoot } from "../helpers/process.ts";

const win32 = process.platform === "win32";

const SCRIPT = fileURLToPath(new URL("../../scripts/setup.ts", import.meta.url));
const EXAMPLE = "# Required.\nLOOPBACK_TOKEN=\n\n# Optional.\n# LOOPBACK_PORT=7337\n";

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--skip-checks"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

const tokenIn = (file: string) => /^LOOPBACK_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1];

describe.runIf(win32)("pnpm run setup", () => {
  it("creates .env from .env.example with a fresh, valid token it never prints", () => {
    const dir = scratchRoot();
    writeFileSync(path.join(dir, ".env.example"), EXAMPLE);
    const result = run(dir);
    expect(result.status).toBe(0);
    const env = path.join(dir, ".env");
    const token = tokenIn(env) ?? "";
    expect(() => loadConfig({ LOOPBACK_TOKEN: token })).not.toThrow();
    expect(readFileSync(env, "utf8")).toBe(
      EXAMPLE.replace("LOOPBACK_TOKEN=", `LOOPBACK_TOKEN=${token}`),
    );
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout).toContain("created .env");
  });

  it("gives every run a different token", () => {
    const tokens = [scratchRoot(), scratchRoot()].map((dir) => {
      writeFileSync(path.join(dir, ".env.example"), EXAMPLE);
      run(dir);
      return tokenIn(path.join(dir, ".env"));
    });
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("fills an empty token in an existing .env and keeps the rest", () => {
    const dir = scratchRoot();
    writeFileSync(path.join(dir, ".env"), "LOOPBACK_PORT=8080\nLOOPBACK_TOKEN=\n");
    expect(run(dir).status).toBe(0);
    const text = readFileSync(path.join(dir, ".env"), "utf8");
    expect(text).toMatch(/^LOOPBACK_PORT=8080\nLOOPBACK_TOKEN=[A-Za-z0-9_-]{43}\n$/);
  });

  it("leaves a .env that already has a token untouched", () => {
    const dir = scratchRoot();
    const original =
      "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\nLOOPBACK_PORT=8080\n";
    writeFileSync(path.join(dir, ".env"), original);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(original);
    expect(result.stdout).toContain("already");
  });

  it("locks a new .env to the current user even in a folder every account can write", () => {
    const dir = scratchRoot();
    makeSharedDir(dir);
    expect(run(dir).status).toBe(0);
    expect(onlyOwnerAccess(path.join(dir, ".env"))).toBe(true);
  }, 20_000);

  it("also locks down an existing .env whose token it keeps", () => {
    const dir = scratchRoot();
    makeSharedDir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n",
    );
    expect(run(dir).status).toBe(0);
    expect(aclSids(path.join(dir, ".env"))).not.toContain(SID.authenticatedUsers);
  }, 20_000);

  it("drops access another account was explicitly given to an existing .env", () => {
    const dir = scratchRoot();
    const env = path.join(dir, ".env");
    writeFileSync(env, "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n");
    grantExplicitly(env, SID.authenticatedUsers);
    expect(aclSids(env)).toContain(SID.authenticatedUsers); // the precondition really holds
    expect(run(dir).status).toBe(0);
    expect(onlyOwnerAccess(env)).toBe(true);
    expect(readFileSync(env, "utf8")).toBe(
      "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n",
    );
  }, 20_000);

  it("replaces a token too weak for the server (e.g. from an older version)", () => {
    const dir = scratchRoot();
    writeFileSync(path.join(dir, ".env"), "LOOPBACK_TOKEN=kV3x9-Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S\n");
    const result = run(dir);
    expect(result.status).toBe(0);
    const token = tokenIn(path.join(dir, ".env")) ?? "";
    expect(() => loadConfig({ LOOPBACK_TOKEN: token })).not.toThrow();
    expect(result.stdout).toContain("replaced");
    expect(result.stdout).not.toContain(token);
  });

  it("warns when the project isn't inside your user folder", () => {
    const dir = scratchRoot();
    const outside = run(dir, { USERPROFILE: path.join(scratchRoot(), "someone-else") });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toContain("outside your user folder");
    expect(run(dir).stdout).not.toContain("outside your user folder");
  });

  it("creates a minimal .env when there is no .env.example", () => {
    const dir = scratchRoot();
    expect(run(dir).status).toBe(0);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toMatch(
      /^LOOPBACK_TOKEN=[A-Za-z0-9_-]{43}\n$/,
    );
  });
});
