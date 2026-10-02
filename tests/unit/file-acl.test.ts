import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restrictToCurrentUser } from "../../src/file-acl.ts";
import { aclSids, currentUserSid, makeSharedDir, SID } from "../helpers/acl.ts";
import { scratchRoot } from "../helpers/process.ts";

describe("restrictToCurrentUser", () => {
  it("leaves only the current user and SYSTEM on a file that inherited shared access", async () => {
    const dir = scratchRoot();
    makeSharedDir(dir);
    const file = path.join(dir, "secret.env");
    writeFileSync(file, "LOOPBACK_TOKEN=x\n");
    expect(aclSids(file)).toContain(SID.authenticatedUsers); // the precondition really holds

    await restrictToCurrentUser(file);

    expect(aclSids(file).sort()).toEqual([currentUserSid(), SID.system].sort());
  }, 20_000);

  it("rejects when the file doesn't exist", async () => {
    await expect(restrictToCurrentUser(path.join(scratchRoot(), "missing.env"))).rejects.toThrow();
  }, 20_000);
});
