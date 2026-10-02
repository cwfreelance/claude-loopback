import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
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

  it("can't be blocked by another program creating a pipe name derived from the path alone", async () => {
    const root = workRoot();
    const predictable = createHash("sha256")
      .update(path.resolve(root).toLowerCase())
      .digest("hex")
      .slice(0, 32);
    const squatter = createServer();
    await new Promise<void>((resolve) =>
      squatter.listen(`\\\\.\\pipe\\loopback-${predictable}`, resolve),
    );
    try {
      await (await acquireInstanceLock(root)).release();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("recovers when another program squats the current lock name (e.g. seen in a pipe listing)", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release(); // creates the salt
    const salt = readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim();
    const name = createHash("sha256")
      .update(`${path.resolve(root).toLowerCase()}|${salt}`)
      .digest("hex")
      .slice(0, 32);
    // A squatter accepts connections but can't answer the challenge without the salt.
    const squatter = createServer((socket) => socket.on("data", () => socket.end("nope")));
    await new Promise<void>((resolve) => squatter.listen(`\\\\.\\pipe\\loopback-${name}`, resolve));
    try {
      const lock = await acquireInstanceLock(root);
      // The genuine holder is still recognized afterwards.
      await refused(acquireInstanceLock(root));
      await lock.release();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 20_000);

  it("refuses to start when the holder doesn't answer: it may be a stalled instance", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    const salt = readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim();
    const name = createHash("sha256")
      .update(`${path.resolve(root).toLowerCase()}|${salt}`)
      .digest("hex")
      .slice(0, 32);
    const sockets: Socket[] = [];
    // Accepts, never replies (like a paused process).
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(`\\\\.\\pipe\\loopback-${name}`, resolve));
    try {
      expect((await refused(acquireInstanceLock(root))).message).toContain("not responding");
      expect(readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim()).toBe(salt);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 40_000);

  it("keeps the same lock across restarts and processes (the salt persists)", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    const holder = spawn(process.execPath, [HOLDER, root], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    try {
      await once(holder.stdout as NodeJS.ReadableStream, "data");
      await refused(acquireInstanceLock(root));
    } finally {
      holder.kill();
    }
  }, 20_000);

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
