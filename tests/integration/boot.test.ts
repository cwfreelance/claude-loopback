import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLive } from "../helpers/live.ts";
import { scratchRoot } from "../helpers/process.ts";
import { startServer, stopServers, TOKEN, waitForListening } from "../helpers/server.ts";

/** An empty file named claude.exe: enough to start, since nothing runs it at boot. */
function dummyClaude(): string {
  const file = path.join(scratchRoot(), "claude.exe");
  writeFileSync(file, "");
  return file;
}

afterEach(stopServers);

const live: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((server) => server.close()));
});

describe("server startup", () => {
  it("serves /health on 127.0.0.1", async () => {
    const server = await startLive();
    live.push(server);
    expect(server.host).toBe("127.0.0.1");
    const response = await fetch(`${server.url}/health`);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(server.logs().find((entry) => entry.msg === "listening")).toMatchObject({
      host: "127.0.0.1",
      port: server.port,
    });
  }, 20_000);
});

describe("entry point (src/index.ts)", () => {
  it("refuses to start without a token and explains how to make one", async () => {
    const server = startServer({});
    const [code] = await once(server.child, "exit");
    expect(code).toBe(1);
    expect(server.stderr()).toContain("LOOPBACK_TOKEN");
    expect(server.stderr()).toContain("pnpm run token");
    expect(server.stdout()).not.toContain("listening");
  }, 20_000);

  it("refuses to bind a non-loopback host", async () => {
    const server = startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_HOST: "0.0.0.0" });
    const [code] = await once(server.child, "exit");
    expect(code).toBe(1);
    expect(server.stderr()).toContain("LOOPBACK_HOST");
  }, 20_000);

  it("starts, scrubs nothing it needs, and serves /health", async () => {
    const server = startServer({
      LOOPBACK_TOKEN: TOKEN,
      LOOPBACK_PORT: "0",
      LOOPBACK_CLAUDE_PATH: dummyClaude(),
    });
    const { port, host } = await waitForListening(server);
    expect(host).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await response.json()).toEqual({ status: "ok" });
  }, 20_000);

  it("explains a port that is already in use instead of crashing with a stack trace", async () => {
    const holder = createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const { port } = holder.address() as AddressInfo;
    try {
      const server = startServer({
        LOOPBACK_TOKEN: TOKEN,
        LOOPBACK_PORT: String(port),
        LOOPBACK_CLAUDE_PATH: dummyClaude(),
      });
      const [code] = await once(server.child, "exit");
      expect(code).toBe(1);
      expect(server.stderr()).toContain(`loopback: cannot listen on 127.0.0.1:${port}`);
      expect(server.stderr()).not.toMatch(/\n\s+at /);
    } finally {
      holder.close();
    }
  }, 20_000);

  it("refuses to start when claude.exe cannot be found", async () => {
    const server = startServer({
      LOOPBACK_TOKEN: TOKEN,
      LOOPBACK_PORT: "0",
      LOOPBACK_CLAUDE_PATH: "C:\\definitely\\missing\\claude.exe",
    });
    const [code] = await once(server.child, "exit");
    expect(code).toBe(1);
    expect(server.stderr()).toContain("LOOPBACK_CLAUDE_PATH");
    expect(server.stdout()).not.toContain("listening");
  }, 20_000);
});
