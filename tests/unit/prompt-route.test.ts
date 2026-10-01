import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { buildApp, errorBody, send } from "../helpers/app.ts";
import { RESULT } from "../helpers/backend.ts";

const post = (body: unknown, raw = false) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: raw ? (body as string) : JSON.stringify(body),
});

describe("POST /v1/prompt", () => {
  it("runs the prompt and returns the result", async () => {
    const { app, backend } = buildApp();
    const response = await send(app, "/v1/prompt", post({ prompt: "Say pong" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      id: response.headers.get("x-request-id"),
      text: "pong",
      model: "m-1",
      stopReason: "end_turn",
      durationMs: 10,
      queueMs: 0,
      usage: RESULT.usage,
      costUsd: RESULT.costUsd,
    });
    expect(backend.requests[0]).toMatchObject({ prompt: "Say pong" });
  });

  it("includes structured output when the run produced it", async () => {
    const { app, backend } = buildApp();
    backend.script({
      events: [{ type: "result", result: { ...RESULT, structuredOutput: { answer: 42 } } }],
    });
    const response = await send(
      app,
      "/v1/prompt",
      post({ prompt: "q", jsonSchema: { type: "object" } }),
    );
    expect(await response.json()).toMatchObject({ structuredOutput: { answer: 42 } });
  });

  it("passes every accepted field through to the backend", async () => {
    const { app, backend } = buildApp({
      LOOPBACK_ALLOWED_TOOLS: "WebSearch",
      LOOPBACK_ALLOWED_MODELS: "sonnet,haiku",
    });
    const response = await send(
      app,
      "/v1/prompt",
      post({
        prompt: "p",
        attachments: [{ name: "a.txt", content: "A" }],
        model: "haiku",
        systemPrompt: "s",
        effort: "high",
        jsonSchema: { type: "object" },
        tools: ["WebSearch"],
        timeoutMs: 5000,
      }),
    );
    expect(response.status).toBe(200);
    expect(backend.requests[0]).toMatchObject({
      model: "haiku",
      systemPrompt: "s",
      effort: "high",
      jsonSchema: { type: "object" },
      tools: ["WebSearch"],
      timeoutMs: 5000,
    });
    expect(backend.requests[0]?.prompt).toContain("A");
  });

  it.each<[string, unknown]>([
    ["a missing prompt", {}],
    ["an empty prompt", { prompt: "" }],
    ["a non-string prompt", { prompt: 42 }],
    ["an unknown field", { prompt: "p", temperature: 1 }],
    ["an over-long prompt", { prompt: "x".repeat(200_001) }],
    [
      "too many attachments",
      {
        prompt: "p",
        attachments: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, content: "" })),
      },
    ],
    [
      "oversized attachments",
      { prompt: "p", attachments: [{ name: "a", content: "x".repeat(2 * 1024 * 1024 + 1) }] },
    ],
    [
      "an attachment with an unknown field",
      { prompt: "p", attachments: [{ name: "a", content: "", path: "C:\\x" }] },
    ],
    ["an empty attachment name", { prompt: "p", attachments: [{ name: "", content: "" }] }],
    ["a jsonSchema that is an array", { prompt: "p", jsonSchema: [] }],
    ["an oversized jsonSchema", { prompt: "p", jsonSchema: { d: "x".repeat(16 * 1024) } }],
    ["an over-long systemPrompt", { prompt: "p", systemPrompt: "x".repeat(16 * 1024 + 1) }],
    ["an unknown effort", { prompt: "p", effort: "ultra" }],
    ["tools that are not an array", { prompt: "p", tools: "WebSearch" }],
    ["a non-numeric timeout", { prompt: "p", timeoutMs: "5000" }],
    ["a JSON array body", [{ prompt: "p" }]],
  ])("rejects %s with 400 before running anything", async (_name, body) => {
    const { app, backend } = buildApp({ LOOPBACK_MAX_BODY_BYTES: String(8 * 1024 * 1024) });
    const response = await send(app, "/v1/prompt", post(body));
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_request");
    expect(backend.requests).toHaveLength(0);
  });

  it("names the offending field without echoing its value", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/prompt", post({ prompt: "p", effort: "SECRET-VALUE" }));
    const { message } = await errorBody(response);
    expect(message).toContain("effort");
    expect(message).not.toContain("SECRET-VALUE");
  });

  it("does not echo unknown field names, however long or sensitive", async () => {
    const { app } = buildApp();
    const body = {
      prompt: "p",
      "sk-ant-SECRET-KEY-NAME": 1,
      attachments: [{ name: "a", content: "", NESTED_SECRET: 1 }],
    };
    const first = await send(app, "/v1/prompt", post(body));
    const { message } = await errorBody(first);
    expect(first.status).toBe(400);
    expect(message).not.toMatch(/SECRET/);
    expect(message.length).toBeLessThan(200);
  });

  it("rejects malformed JSON with 400", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/prompt", post("{not json", true));
    expect(response.status).toBe(400);
  });

  it.each([
    ["a tool outside the allowlist", { prompt: "p", tools: ["Bash"] }, 400, "tool_not_allowed"],
    ["a model outside the allowlist", { prompt: "p", model: "gpt" }, 400, "model_not_allowed"],
  ])("maps %s to its error", async (_name, body, status, code) => {
    const { app } = buildApp();
    const response = await send(app, "/v1/prompt", post(body));
    expect(response.status).toBe(status);
    expect((await errorBody(response)).code).toBe(code);
  });

  it("passes backend errors through with their status and Retry-After", async () => {
    const { app, backend } = buildApp();
    backend.script({
      error: new AppError("usage_limit", "Claude subscription usage limit reached", {
        retryAfterSeconds: 120,
      }),
    });
    const response = await send(app, "/v1/prompt", post({ prompt: "p" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect((await errorBody(response)).code).toBe("usage_limit");
  });

  it("requires the bearer token", async () => {
    const { app, backend } = buildApp();
    const response = await send(app, "/v1/prompt", { ...post({ prompt: "p" }), token: null });
    expect(response.status).toBe(401);
    expect(backend.requests).toHaveLength(0);
  });
});

describe("GET /ready", () => {
  it("reports ready with the CLI version and queue counters", async () => {
    const { app } = buildApp();
    const response = await send(app, "/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      cli: { loggedIn: true, version: "2.1.287" },
      queue: { active: 0, waiting: 0 },
    });
  });

  it("returns 503 with the reason when the CLI is not ready", async () => {
    const { app, backend } = buildApp();
    backend.status = { ready: false, loggedIn: false, version: "2.1.287", reason: "not logged in" };
    const response = await send(app, "/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ready: false,
      cli: { loggedIn: false, reason: "not logged in" },
    });
  });

  it("requires the bearer token", async () => {
    const { app } = buildApp();
    expect((await send(app, "/ready", { token: null })).status).toBe(401);
  });
});
