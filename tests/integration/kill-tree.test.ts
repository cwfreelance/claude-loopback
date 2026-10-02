import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { killTree } from "../../src/process/kill-tree.ts";
import { FAKE_CLAUDE, isAlive, waitForDeath } from "../helpers/process.ts";

const win32 = process.platform === "win32";

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid);
    } catch {}
  }
});

function spawnFake(scenario: string) {
  const child = spawn(process.execPath, [FAKE_CLAUDE], {
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", FAKE_CLAUDE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error("spawn failed");
  leftovers.push(child.pid);
  return { child, pid: child.pid };
}

async function grandchildOf(child: ReturnType<typeof spawnFake>["child"]): Promise<number> {
  if (!child.stdout) throw new Error("no stdout");
  for await (const line of createInterface({ input: child.stdout })) {
    const { pid } = JSON.parse(line) as { pid: number };
    leftovers.push(pid);
    return pid;
  }
  throw new Error("no output");
}

describe("killTree", () => {
  it.runIf(win32)(
    "kills a process and its detached grandchildren",
    async () => {
      const { child, pid } = spawnFake("grandchild");
      const grandchildPid = await grandchildOf(child);
      expect(isAlive(grandchildPid)).toBe(true);

      await killTree(pid);

      await waitForDeath(pid);
      await waitForDeath(grandchildPid);
    },
    20_000,
  );

  it("is needed: killing only the parent leaves the grandchild running", async () => {
    const { child, pid } = spawnFake("grandchild");
    const grandchildPid = await grandchildOf(child);
    process.kill(pid);
    await waitForDeath(pid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(grandchildPid)).toBe(true);
  }, 20_000);

  it.runIf(win32)(
    "resolves for a process that has already exited",
    async () => {
      const { child, pid } = spawnFake("lines");
      await new Promise((resolve) => child.once("exit", resolve));
      await waitForDeath(pid);
      await expect(killTree(pid)).resolves.toBeUndefined();
    },
    20_000,
  );
});
