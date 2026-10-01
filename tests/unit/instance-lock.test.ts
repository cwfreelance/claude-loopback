import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/process/instance-lock.ts";
import { StartupError } from "../../src/startup-error.ts";
import { scratchRoot, waitForDeath } from "../helpers/process.ts";

const workRoot = () => path.join(scratchRoot(), "work");
const HOLDER = fileURLToPath(new URL("../fixtures/lock-holder.ts", import.meta.url));

async function refused(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError;
}

describe("acquireInstanceLock", () => {
  it("refuses a second holder for the same work root", async () => {
    const root = workRoot();
    const lock = await acquireInstanceLock(root);
    try {
      expect((await refused(acquireInstanceLock(root))).message).toContain("already running");
    } finally {
      await lock.release();
    }
  });

  it("can be taken again after release", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    await (await acquireInstanceLock(root)).release();
  });

  it("treats paths that differ only in case or form as the same work root", async () => {
    const root = workRoot();
    const lock = await acquireInstanceLock(root);
    try {
      await refused(acquireInstanceLock(root.toUpperCase()));
      await refused(acquireInstanceLock(path.join(root, "..", path.basename(root))));
    } finally {
      await lock.release();
    }
  });

  it("does not conflict across different work roots", async () => {
    const a = await acquireInstanceLock(workRoot());
    const b = await acquireInstanceLock(workRoot());
    await a.release();
    await b.release();
  });

  it("serialises simultaneous attempts: exactly one wins", async () => {
    const root = workRoot();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => acquireInstanceLock(root)),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it("is freed by the OS when the holder is killed without cleaning up", async () => {
    const root = workRoot();
    const holder = spawn(process.execPath, [HOLDER, root], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    try {
      await once(holder.stdout as NodeJS.ReadableStream, "data");
      await refused(acquireInstanceLock(root));
      holder.kill(); // TerminateProcess: no cleanup code runs
      await waitForDeath(holder.pid as number);
      await (await acquireInstanceLock(root)).release();
    } finally {
      holder.kill();
    }
  }, 20_000);
});
