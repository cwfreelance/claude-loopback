import { once } from "node:events";
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN } from "../helpers/app.ts";
import { authHeaders, startLive } from "../helpers/live.ts";
import { waitForDeath } from "../helpers/process.ts";
import { parseSse, readUntil } from "../helpers/sse.ts";

const T = 20_000;
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/streams/${name}`, import.meta.url));

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function live(cli: Record<string, string>, config: Record<string, string> = {}) {
  const server = await startLive({ cli, config });
  servers.push(server);
  return server;
}

const stream = (url: string, body: unknown, init: RequestInit = {}) =>
  fetch(`${url}/v1/prompt/stream`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
    ...init,
  });

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /v1/prompt/stream against the CLI backend", () => {
  it(
    "streams the real capture as start, text deltas and a result",
    async () => {
      const { url } = await live({
        FAKE_CLAUDE_SCENARIO: "replay",
        FAKE_CLAUDE_FIXTURE: fixture("success.ndjson"),
      });
      const response = await stream(url, { prompt: "Reply with exactly the word: pong" });
      expect(response.status).toBe(200);
      const { events } = parseSse(await response.text());
      expect(events[0]).toEqual({ event: "start", data: { model: "claude-haiku-4-5-20251001" } });
      const text = events
        .filter((e) => e.event === "delta")
        .map((e) => (e.data as { text: string }).text)
        .join("");
      expect(text).toBe("pong");
      expect(events.filter((e) => e.event === "result" || e.event === "error")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ event: "result", data: { text: "pong" } });
    },
    T,
  );

  it(
    "ends with an error event when the run times out after the stream started",
    async () => {
      const { url, pids } = await live({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      const response = await stream(url, { prompt: "hi", timeoutMs: 1000 });
      const { events } = parseSse(await response.text());
      expect(events.map((e) => e.event)).toEqual(["start", "error"]);
      expect(events[1]).toMatchObject({ data: { code: "timeout" } });
      await waitForDeath(pids[0] as number);
    },
    T,
  );

  it(
    "kills the CLI and frees the slot when the client disconnects mid-stream",
    async () => {
      const { url, pids, service } = await live({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      const controller = new AbortController();
      const response = await stream(url, { prompt: "hi" }, { signal: controller.signal });
      const { reader } = await readUntil(response.body as ReadableStream<Uint8Array>, (text) =>
        text.includes("event: start"),
      );
      expect(pids).toHaveLength(1);
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitForDeath(pids[0] as number);
      await until(() => service.status().active === 0);
    },
    T,
  );

  it(
    "drops a client that stops reading, freeing its slot and killing the CLI",
    async () => {
      const { port, pids, service, workRoot } = await live(
        { FAKE_CLAUDE_SCENARIO: "delta-flood" },
        { LOOPBACK_STREAM_STALL_MS: "1000", LOOPBACK_MAX_CONCURRENCY: "1" },
      );
      const body = JSON.stringify({ prompt: "hi" });
      const socket = connect(port, "127.0.0.1");
      try {
        socket.write(
          [
            "POST /v1/prompt/stream HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            `Authorization: Bearer ${TOKEN}`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "",
            body,
          ].join("\r\n"),
        );
        await once(socket, "data");
        socket.pause(); // keep the connection open but never read again
        await until(() => service.status().active === 0, 10_000);
        await waitForDeath(pids[0] as number);
        await until(() => readdirSync(workRoot).length === 0);
      } finally {
        socket.destroy();
      }
    },
    T,
  );
});
