import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { ensureTokenFile, newToken } from "../../src/token-file.ts";
import { aclSids, grantExplicitly, makeSharedDir, onlyOwnerAccess, SID } from "../helpers/acl.ts";
import { scratchRoot } from "../helpers/process.ts";

const win32 = process.platform === "win32";

const TEMPLATE = "# Required.\nLOOPBACK_TOKEN=\n# LOOPBACK_PORT=7337\n";
const KEPT = "LOOPBACK_TOKEN=5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE\nLOOPBACK_PORT=8080\n";
const tokenIn = (file: string) => /^LOOPBACK_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1];
const usable = (token: string | undefined) => {
  expect(() => loadConfig({ LOOPBACK_TOKEN: token ?? "" })).not.toThrow();
};

describe("newToken", () => {
  it("makes a fresh 256-bit token the server accepts", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    usable(token);
    expect(newToken()).not.toBe(token);
  });
});

describe("ensureTokenFile", () => {
  it.runIf(win32)(
    "creates the file from the template with a new token",
    async () => {
      const file = path.join(scratchRoot(), "config.env");
      expect(await ensureTokenFile(file, TEMPLATE)).toEqual({
        outcome: "created",
        restricted: true,
      });
      const token = tokenIn(file);
      usable(token);
      expect(readFileSync(file, "utf8")).toBe(TEMPLATE.replace("TOKEN=", `TOKEN=${token}`));
    },
    20_000,
  );

  it("fills an empty token and keeps the other settings", async () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, "LOOPBACK_PORT=8080\nLOOPBACK_TOKEN=\n");
    expect((await ensureTokenFile(file, TEMPLATE)).outcome).toBe("filled");
    expect(readFileSync(file, "utf8")).toMatch(/^LOOPBACK_PORT=8080\nLOOPBACK_TOKEN=[\w-]{43}\n$/);
  }, 20_000);

  it("appends a token line when the file has none", async () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, "LOOPBACK_PORT=8080");
    expect((await ensureTokenFile(file, TEMPLATE)).outcome).toBe("filled");
    expect(readFileSync(file, "utf8")).toMatch(/^LOOPBACK_PORT=8080\nLOOPBACK_TOKEN=[\w-]{43}\n$/);
  }, 20_000);

  it("replaces a token the server would reject", async () => {
    const file = path.join(scratchRoot(), "config.env");
    writeFileSync(file, "LOOPBACK_TOKEN=too-short\nLOOPBACK_PORT=8080\n");
    expect((await ensureTokenFile(file, TEMPLATE)).outcome).toBe("replaced");
    usable(tokenIn(file));
    expect(readFileSync(file, "utf8")).toContain("LOOPBACK_PORT=8080\n");
  }, 20_000);

  it.runIf(win32)(
    "keeps a usable token and the file's contents exactly",
    async () => {
      const file = path.join(scratchRoot(), "config.env");
      writeFileSync(file, KEPT);
      expect(await ensureTokenFile(file, TEMPLATE)).toEqual({ outcome: "kept", restricted: true });
      expect(readFileSync(file, "utf8")).toBe(KEPT);
    },
    20_000,
  );

  it("keeps a usable token written in quotes (Node's env-file parser strips them)", async () => {
    const file = path.join(scratchRoot(), "config.env");
    const quoted = 'LOOPBACK_TOKEN="5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE"\n';
    writeFileSync(file, quoted);
    expect((await ensureTokenFile(file, TEMPLATE)).outcome).toBe("kept");
    expect(readFileSync(file, "utf8")).toBe(quoted);
  }, 20_000);

  it.runIf(win32)(
    "leaves no other account with access, whatever the file had",
    async () => {
      const dir = scratchRoot();
      makeSharedDir(dir);
      const file = path.join(dir, "config.env");
      writeFileSync(file, KEPT);
      grantExplicitly(file, SID.everyone);
      await ensureTokenFile(file, TEMPLATE);
      expect(onlyOwnerAccess(file)).toBe(true);
    },
    20_000,
  );

  it("leaves no temporary files behind", async () => {
    const dir = scratchRoot();
    await ensureTokenFile(path.join(dir, "config.env"), TEMPLATE);
    await ensureTokenFile(path.join(dir, "config.env"), TEMPLATE);
    expect(readdirSync(dir)).toEqual(["config.env"]);
  }, 20_000);
});
