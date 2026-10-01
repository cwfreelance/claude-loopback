import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { buildApp, errorBody, send } from "../helpers/app.ts";
import { RESULT } from "../helpers/backend.ts";
import { parseSse } from "../helpers/sse.ts";

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /v1/prompt/stream", () => {
  it("streams start, deltas and one final result event", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/prompt/stream", post({ prompt: "p" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const { events } = parseSse(await response.text());
    expect(events).toEqual([
      { event: "start", data: { model: "m-1" } },
      { event: "delta", data: { text: "pong" } },
      {
        event: "result",
        data: {
          id: response.headers.get("x-request-id"),
          text: "pong",
          model: "m-1",
          stopReason: "end_turn",
          durationMs: 10,
          queueMs: 0,
          usage: RESULT.usage,
          costUsd: RESULT.costUsd,
        },
      },
    ]);
  });

  it("streams retry events", async () => {
    const { app, backend } = buildApp();
    backend.script({
      events: [
        { type: "retry", attempt: 1, maxRetries: 10, delayMs: 500, error: "overloaded" },
        { type: "result", result: RESULT },
      ],
    });
    const { events } = parseSse(
      await (await send(app, "/v1/prompt/stream", post({ prompt: "p" }))).text(),
    );
    expect(events[0]).toEqual({
      event: "retry",
      data: { attempt: 1, maxRetries: 10, delayMs: 500, error: "overloaded" },
    });
  });

  it("reports a failure after the stream has started as one error event, then ends", async () => {
    const { app, backend } = buildApp();
    backend.script({
      events: [{ type: "start", model: "m-1" }],
      failAfterEvents: new AppError("timeout", "Claude did not finish within the time limit"),
    });
    const response = await send(app, "/v1/prompt/stream", post({ prompt: "p" }));
    expect(response.status).toBe(200);
    const { events } = parseSse(await response.text());
    expect(events).toEqual([
      { event: "start", data: { model: "m-1" } },
      {
        event: "error",
        data: {
          code: "timeout",
          message: "Claude did not finish within the time limit",
          requestId: response.headers.get("x-request-id"),
        },
      },
    ]);
  });

  it("never sends internal error details in the error event", async () => {
    const { app, backend } = buildApp();
    backend.script({ error: new Error("ENOENT C:\\Users\\me\\secret") });
    const { events } = parseSse(
      await (await send(app, "/v1/prompt/stream", post({ prompt: "p" }))).text(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "error",
      data: { code: "internal", message: "Internal server error" },
    });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it.each([
    ["an invalid body", { prompt: "" }, 400, "invalid_request"],
    ["a tool outside the allowlist", { prompt: "p", tools: ["Bash"] }, 400, "tool_not_allowed"],
    ["a model outside the allowlist", { prompt: "p", model: "gpt" }, 400, "model_not_allowed"],
  ])("answers %s with a plain JSON error, not a stream", async (_name, body, status, code) => {
    const { app, backend } = buildApp();
    const response = await send(app, "/v1/prompt/stream", post(body));
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await errorBody(response)).code).toBe(code);
    expect(backend.requests).toHaveLength(0);
  });

  it("answers a full queue with 429 and Retry-After before any stream starts", async () => {
    const { app, backend } = buildApp({ LOOPBACK_MAX_CONCURRENCY: "1", LOOPBACK_QUEUE_SIZE: "0" });
    backend.script({ hold: true });
    const first = send(app, "/v1/prompt/stream", post({ prompt: "one" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await send(app, "/v1/prompt/stream", post({ prompt: "two" }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
    expect((await errorBody(second)).code).toBe("queue_full");
    backend.release();
    await (await first).text();
  });

  it("sends heartbeat comments while the run is quiet", async () => {
    const { app, backend } = buildApp({}, undefined, { heartbeatMs: 20 });
    backend.script({ hold: true });
    const response = send(app, "/v1/prompt/stream", post({ prompt: "p" }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    backend.release();
    const { comments, events } = parseSse(await (await response).text());
    expect(comments).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.event).toBe("result");
  });

  it("requires the bearer token", async () => {
    const { app, backend } = buildApp();
    const response = await send(app, "/v1/prompt/stream", {
      ...post({ prompt: "p" }),
      token: null,
    });
    expect(response.status).toBe(401);
    expect(backend.requests).toHaveLength(0);
  });
});
