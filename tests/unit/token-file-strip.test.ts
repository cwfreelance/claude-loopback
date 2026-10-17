import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureTokenFile } from "../../src/token-file.ts";
import { scratchRoot } from "../helpers/process.ts";

// Stripping a folder this process just made can't be made to fail, so the failure is simulated.
vi.mock("../../src/file-acl.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/file-acl.ts")>()),
  dropAclEntries: () => Promise.reject(new Error("entries kept")),
}));

describe.runIf(process.platform === "darwin")("ensureTokenFile", () => {
  it("writes nothing when the scratch folder can't be stripped of inherited entries", async () => {
    const dir = scratchRoot();
    const file = path.join(dir, "config.env");
    writeFileSync(file, "LOOPBACK_TOKEN=\n");

    await expect(ensureTokenFile(file, "")).rejects.toThrow("entries kept");

    expect(readFileSync(file, "utf8")).toBe("LOOPBACK_TOKEN=\n"); // not filled
    expect(readdirSync(dir)).toEqual(["config.env"]); // no scratch folder or file left behind
  });
});
