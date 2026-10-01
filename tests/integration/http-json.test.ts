import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { authHeaders, startLive } from "../helpers/live.ts";
import { waitForDeath } from "../helpers/process.ts";

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

const prompt = (url: string, body: unknown, init: RequestInit = {}) =>
  fetch(`${url}/v1/prompt`, {
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

describe("POST /v1/prompt against the CLI backend", () => {
  it(
    "returns the CLI's answer",
    async () => {
      const { url } = await live({
        FAKE_CLAUDE_SCENARIO: "replay",
        FAKE_CLAUDE_FIXTURE: fixture("success.ndjson"),
      });
      const response = await prompt(url, { prompt: "Reply with exactly the word: pong" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        text: "pong",
        model: "claude-haiku-4-5-20251001",
        stopReason: "end_turn",
      });
    },
    T,
  );

  it(
    "answers 503 cli_not_authenticated for the real logged-out output",
    async () => {
      const { url } = await live({
        FAKE_CLAUDE_SCENARIO: "replay",
        FAKE_CLAUDE_FIXTURE: fixture("logged-out.ndjson"),
        FAKE_CLAUDE_EXIT: "1",
      });
      const response = await prompt(url, { prompt: "hi" });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "cli_not_authenticated",
      );
    },
    T,
  );

  it(
    "answers 504 and kills the CLI when the run times out",
    async () => {
      const { url, pids, service } = await live({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      const response = await prompt(url, { prompt: "hi", timeoutMs: 1000 });
      expect(response.status).toBe(504);
      await waitForDeath(pids[0] as number);
      expect(service.status()).toEqual({ active: 0, waiting: 0 });
    },
    T,
  );

  it(
    "kills the CLI and frees the slot when the client disconnects",
    async () => {
      const { url, pids, service } = await live({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      const controller = new AbortController();
      const request = prompt(url, { prompt: "hi" }, { signal: controller.signal }).catch(
        () => undefined,
      );
      await until(() => pids.length === 1);
      controller.abort();
      await request;
      await waitForDeath(pids[0] as number);
      await until(() => service.status().active === 0);
    },
    T,
  );
});
