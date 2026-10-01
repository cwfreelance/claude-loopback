import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StartupError } from "../../src/startup-error.ts";
import { TOKEN } from "../helpers/app.ts";
import { authHeaders, startLive } from "../helpers/live.ts";
import { scratchRoot, waitForDeath } from "../helpers/process.ts";

const T = 20_000;
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/streams/${name}`, import.meta.url));

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function live(options: Parameters<typeof startLive>[0] = {}) {
  const server = await startLive(options);
  servers.push(server);
  return server;
}

async function startupError(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError;
}

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("startup checks", () => {
  it(
    "refuses to start with a CLI older than the minimum supported version",
    async () => {
      const error = await startupError(
        startLive({ cli: { FAKE_CLAUDE_VERSION: "2.1.200 (Claude Code)" } }),
      );
      expect(error.message).toContain("2.1.259");
    },
    T,
  );

  it(
    "refuses to start when the CLI's version can't be read",
    async () => {
      await startupError(startLive({ cli: { FAKE_CLAUDE_VERSION: "not a version" } }));
    },
    T,
  );

  it(
    "starts when the CLI is logged out, but reports not ready",
    async () => {
      const server = await live({ cli: { FAKE_CLAUDE_LOGGED_IN: "false" } });
      const response = await fetch(`${server.url}/ready`, { headers: authHeaders });
      expect(response.status).toBe(503);
      expect(server.logs().some((entry) => entry.level === 40)).toBe(true);
    },
    T,
  );

  it(
    "sweeps work dirs left behind by a previous run",
    async () => {
      const workRoot = path.join(scratchRoot(), "work");
      mkdirSync(path.join(workRoot, "req-leftover"), { recursive: true });
      writeFileSync(path.join(workRoot, "req-leftover", "partial.txt"), "x");
      await live({ workRoot });
      expect(existsSync(path.join(workRoot, "req-leftover"))).toBe(false);
    },
    T,
  );

  it(
    "refuses a second instance on the same work root until the first one stops",
    async () => {
      const workRoot = path.join(scratchRoot(), "work");
      const first = await startLive({ workRoot });
      const error = await startupError(startLive({ workRoot }));
      expect(error.message).toContain("already running");
      await first.close();
      await live({ workRoot }); // the lock was released
    },
    T,
  );

  it(
    "explains a port that is already in use, and releases the lock",
    async () => {
      const holder = createServer();
      holder.listen(0, "127.0.0.1");
      await once(holder, "listening");
      const { port } = holder.address() as AddressInfo;
      const workRoot = path.join(scratchRoot(), "work");
      try {
        const error = await startupError(
          startLive({ workRoot, config: { LOOPBACK_PORT: String(port) } }),
        );
        expect(error.message).toContain(`cannot listen on 127.0.0.1:${port}`);
        await live({ workRoot }); // the failed start released the lock
      } finally {
        holder.close();
      }
    },
    T,
  );
});

describe("graceful shutdown", () => {
  it(
    "lets an in-flight run finish within the grace period",
    async () => {
      const server = await startLive({
        cli: {
          FAKE_CLAUDE_SCENARIO: "replay",
          FAKE_CLAUDE_FIXTURE: fixture("success.ndjson"),
          FAKE_CLAUDE_DELAY_MS: "500",
        },
      });
      const response = fetch(`${server.url}/v1/prompt`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ prompt: "hi" }),
      });
      await until(() => server.pids.length === 1);
      await server.close({ graceMs: 10_000 });
      const done = await response;
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({ text: "pong" });
    },
    T,
  );

  it(
    "aborts runs that outlast the grace period with 503 shutting_down, then releases the lock",
    async () => {
      const workRoot = path.join(scratchRoot(), "work");
      const server = await startLive({ workRoot, cli: { FAKE_CLAUDE_SCENARIO: "init-then-hang" } });
      const response = fetch(`${server.url}/v1/prompt`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ prompt: "hi" }),
      });
      await until(() => server.pids.length === 1);
      await server.close({ graceMs: 300 });
      const done = await response;
      expect(done.status).toBe(503);
      expect(((await done.json()) as { error: { code: string } }).error.code).toBe("shutting_down");
      await waitForDeath(server.pids[0] as number);
      await live({ workRoot }); // the lock was released
    },
    T,
  );

  it(
    "finishes even when a streaming client has stopped reading",
    async () => {
      const server = await startLive({ cli: { FAKE_CLAUDE_SCENARIO: "delta-flood" } });
      const body = JSON.stringify({ prompt: "hi" });
      const socket = connect(server.port, "127.0.0.1");
      socket.on("error", () => {});
      try {
        socket.write(
          [
            "POST /v1/prompt/stream HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            `Authorization: Bearer ${TOKEN}`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "",
            body,
          ].join("\r\n"),
        );
        await once(socket, "data");
        socket.pause();
        const started = Date.now();
        await server.close({ graceMs: 200 });
        expect(Date.now() - started).toBeLessThan(10_000);
        await waitForDeath(server.pids[0] as number);
      } finally {
        socket.destroy();
      }
    },
    T,
  );
});
