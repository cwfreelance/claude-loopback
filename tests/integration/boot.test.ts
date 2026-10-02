import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLive } from "../helpers/live.ts";
import { scratchRoot } from "../helpers/process.ts";
import { startServer, stopServers, TOKEN } from "../helpers/server.ts";

const win32 = process.platform === "win32";

/** An empty file named claude.exe: it resolves, but can't run. */
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

  it("reports what the startup banner needs: CLI status and settings", async () => {
    const server = await startLive({ config: { LOOPBACK_MAX_CONCURRENCY: "3" } });
    live.push(server);
    expect(server.cli).toMatchObject({ ready: true, loggedIn: true });
    expect(server.cli.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(server.config).toMatchObject({ maxConcurrency: 3, defaultModel: "sonnet" });
    expect(server.pretty).toBe(false); // a log destination was given: JSON
  }, 20_000);

  it("drops the plaintext token from the settings it was given once it is loaded", async () => {
    const server = await startLive();
    live.push(server);
    expect(server.env).not.toHaveProperty("LOOPBACK_TOKEN");
    const ready = await fetch(`${server.url}/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ready.status).toBe(200);
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

  it.runIf(win32)(
    "refuses to start when claude.exe can't be run, without a stack trace",
    async () => {
      const server = startServer({
        LOOPBACK_TOKEN: TOKEN,
        LOOPBACK_PORT: "0",
        LOOPBACK_CLAUDE_PATH: dummyClaude(),
        // Keep the lock and work dirs out of the real %LOCALAPPDATA%.
        LOCALAPPDATA: scratchRoot(),
      });
      const [code] = await once(server.child, "exit");
      expect(code).toBe(1);
      expect(server.stderr()).toContain("loopback: ");
      expect(server.stderr()).toContain("Claude CLI");
      expect(server.stderr()).not.toMatch(/\n\s+at /);
      expect(server.stdout()).not.toContain("listening");
    },
    20_000,
  );

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
