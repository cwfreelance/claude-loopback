import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aclGrantsAccess, dropAclEntries, restrictToCurrentUser } from "../../src/file-acl.ts";
import { aclSids, makeSharedDir, onlyOwnerAccess, SID } from "../helpers/acl.ts";
import { scratchRoot } from "../helpers/process.ts";

const win32 = process.platform === "win32";
const darwin = process.platform === "darwin";

describe("restrictToCurrentUser", () => {
  it.runIf(win32)(
    "leaves no other account on a file that inherited shared access",
    async () => {
      const dir = scratchRoot();
      makeSharedDir(dir);
      const file = path.join(dir, "secret.env");
      writeFileSync(file, "LOOPBACK_TOKEN=x\n");
      expect(aclSids(file)).toContain(SID.authenticatedUsers); // the precondition really holds

      await restrictToCurrentUser(file);

      expect(onlyOwnerAccess(file)).toBe(true);
    },
    20_000,
  );

  it.runIf(darwin)("leaves no other account on a file that inherited shared access", async () => {
    const dir = scratchRoot();
    makeSharedDir(dir);
    const file = path.join(dir, "secret.env");
    writeFileSync(file, "LOOPBACK_TOKEN=x\n");
    chmodSync(file, 0o600);
    expect(onlyOwnerAccess(file)).toBe(false); // the entry alone makes it readable

    await restrictToCurrentUser(file);

    expect(onlyOwnerAccess(file)).toBe(true);
  });

  it.runIf(!win32)("leaves no other account on a file everyone could read", async () => {
    const file = path.join(scratchRoot(), "secret.env");
    writeFileSync(file, "LOOPBACK_TOKEN=x\n");
    chmodSync(file, 0o666);
    expect(onlyOwnerAccess(file)).toBe(false); // the precondition really holds

    await restrictToCurrentUser(file);

    expect(onlyOwnerAccess(file)).toBe(true);
  });

  it("rejects when the file doesn't exist", async () => {
    await expect(restrictToCurrentUser(path.join(scratchRoot(), "missing.env"))).rejects.toThrow();
  }, 20_000);
});

describe("dropAclEntries", () => {
  it.runIf(darwin)(
    "rejects when the entries can't be cleared, even if none grants access",
    async () => {
      const file = path.join(scratchRoot(), "secret.env");
      writeFileSync(file, "");
      execFileSync("/bin/chmod", ["+a", "group:everyone deny delete", file]);
      // Immutable: chmod -N is refused, and not as unsupported (the one refusal tolerated), while
      // the only entry listed grants nothing.
      execFileSync("/usr/bin/chflags", ["uchg", file]);
      try {
        expect(await aclGrantsAccess(file)).toBe(false); // the precondition really holds

        await expect(dropAclEntries(file)).rejects.toThrow();
      } finally {
        execFileSync("/usr/bin/chflags", ["nouchg", file]);
      }
    },
  );
});
