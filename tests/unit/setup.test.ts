import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { aclSids, grantExplicitly, makeSharedDir, onlyOwnerAccess, SID } from "../helpers/acl.ts";
import { scratchRoot } from "../helpers/process.ts";

const win32 = process.platform === "win32";
const darwin = process.platform === "darwin";
const homeVar = win32 ? "USERPROFILE" : "HOME";

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

// Spawns the setup script, which can take seconds on a busy Windows machine.
describe("pnpm run setup", { timeout: 20_000 }, () => {
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

  it.runIf(win32)(
    "locks a new .env to the current user even in a folder every account can write",
    () => {
      const dir = scratchRoot();
      makeSharedDir(dir);
      expect(run(dir).status).toBe(0);
      expect(onlyOwnerAccess(path.join(dir, ".env"))).toBe(true);
    },
    20_000,
  );

  it.runIf(!win32)("locks a new .env to the current user", () => {
    const dir = scratchRoot();
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("readable only by your account");
    expect(onlyOwnerAccess(path.join(dir, ".env"))).toBe(true);
  });

  it.runIf(win32)(
    "also locks down an existing .env whose token it keeps",
    () => {
      const dir = scratchRoot();
      makeSharedDir(dir);
      writeFileSync(
        path.join(dir, ".env"),
        "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n",
      );
      expect(run(dir).status).toBe(0);
      expect(aclSids(path.join(dir, ".env"))).not.toContain(SID.authenticatedUsers);
    },
    20_000,
  );

  it.runIf(!win32)("also locks down an existing .env whose token it keeps", () => {
    const dir = scratchRoot();
    const env = path.join(dir, ".env");
    writeFileSync(env, "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n");
    chmodSync(env, 0o666);
    expect(onlyOwnerAccess(env)).toBe(false); // the precondition really holds
    expect(run(dir).status).toBe(0);
    expect(onlyOwnerAccess(env)).toBe(true);
    expect(readFileSync(env, "utf8")).toBe(
      "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\n",
    );
  });

  it.runIf(win32)(
    "drops access another account was explicitly given to an existing .env",
    () => {
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
    },
    20_000,
  );

  it.runIf(!win32)(
    "says how to make the project folder private when other accounts can enter it",
    () => {
      const dir = scratchRoot();
      chmodSync(dir, 0o750);
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`chmod 700 ${dir}`);
      expect(onlyOwnerAccess(path.join(dir, ".env"))).toBe(true); // the file is still private
    },
  );

  it.runIf(darwin)(
    "says how to drop an access control list that lets other accounts into the project folder",
    () => {
      const dir = scratchRoot();
      makeSharedDir(dir);
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`chmod -N ${dir}`);
      expect(onlyOwnerAccess(path.join(dir, ".env"))).toBe(true); // the file is still private
    },
  );

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
    const outside = run(dir, { [homeVar]: path.join(scratchRoot(), "someone-else") });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toContain("outside your user folder");
    const inside = run(dir, { [homeVar]: path.dirname(dir) });
    expect(inside.stdout).not.toContain("outside your user folder");
  });

  it("creates a minimal .env when there is no .env.example", () => {
    const dir = scratchRoot();
    expect(run(dir).status).toBe(0);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toMatch(
      /^LOOPBACK_TOKEN=[A-Za-z0-9_-]{43}\n$/,
    );
  });
});
