import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { AppError, type ErrorCode } from "../../src/errors.ts";
import { createPromptService, type PromptInput } from "../../src/service/prompt-service.ts";
import { createQueue } from "../../src/service/queue.ts";
import { FakeClock, TOKEN } from "../helpers/app.ts";
import { FakeBackend, flush, RESULT } from "../helpers/backend.ts";
import { captureLogger } from "../helpers/process.ts";

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    LOOPBACK_TOKEN: TOKEN,
    LOOPBACK_ALLOWED_TOOLS: "WebSearch",
    LOOPBACK_ALLOWED_MODELS: "sonnet,haiku",
    LOOPBACK_DEFAULT_TIMEOUT_MS: "120000",
    LOOPBACK_MAX_TIMEOUT_MS: "600000",
    ...env,
  });
  const clock = new FakeClock();
  const backend = new FakeBackend();
  const log = captureLogger();
  const queue = createQueue({
    maxConcurrency: config.maxConcurrency,
    queueSize: config.queueSize,
    maxWaitMs: config.queueTimeoutMs,
    clock,
  });
  const service = createPromptService({
    backend,
    queue,
    config,
    clock,
    logger: log.logger,
    newBoundary: () => "b0und",
  });
  return { service, backend, clock, queue, log };
}

const ctx = (signal = new AbortController().signal) => ({ signal, requestId: "req-1" });

async function code(promise: Promise<unknown>): Promise<ErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe("prompt service: building the run request", () => {
  it("applies server defaults, including the default model, to a minimal input", async () => {
    const { service, backend } = setup();
    await service.run({ prompt: "hi" }, ctx());
    expect(backend.requests).toEqual([
      { prompt: "hi", tools: [], timeoutMs: 120_000, model: "sonnet" },
    ]);
  });

  it("forwards optional fields that are within policy", async () => {
    const { service, backend } = setup();
    const schema = { type: "object" };
    await service.run(
      {
        prompt: "hi",
        model: "haiku",
        systemPrompt: "be brief",
        effort: "low",
        jsonSchema: schema,
        tools: ["WebSearch"],
        timeoutMs: 5000,
      },
      ctx(),
    );
    expect(backend.requests[0]).toEqual({
      prompt: "hi",
      model: "haiku",
      systemPrompt: "be brief",
      effort: "low",
      jsonSchema: schema,
      tools: ["WebSearch"],
      timeoutMs: 5000,
    });
  });

  it("inlines attachments ahead of the prompt inside a per-request boundary", async () => {
    const { service, backend } = setup();
    await service.run(
      {
        prompt: "Summarise these.",
        attachments: [
          { name: "notes.txt", content: "first file" },
          { name: "data 2.csv", content: "a,b\n1,2" },
        ],
      },
      ctx(),
    );
    expect(backend.requests[0]?.prompt).toBe(
      [
        "<attachments-b0und>",
        '<file-b0und name="notes.txt">',
        "first file",
        "</file-b0und>",
        '<file-b0und name="data 2.csv">',
        "a,b\n1,2",
        "</file-b0und>",
        "</attachments-b0und>",
        "",
        "Summarise these.",
      ].join("\n"),
    );
  });

  it("uses a fresh random boundary by default", async () => {
    const config = loadConfig({ LOOPBACK_TOKEN: TOKEN });
    const clock = new FakeClock();
    const backend = new FakeBackend();
    const queue = createQueue({ maxConcurrency: 2, queueSize: 2, maxWaitMs: 1000, clock });
    const service = createPromptService({
      backend,
      queue,
      config,
      clock,
      logger: captureLogger().logger,
    });
    const input = { prompt: "p", attachments: [{ name: "a.txt", content: "x" }] };
    await service.run(input, ctx());
    await service.run(input, ctx());
    const boundaries = backend.requests.map(
      (request) => /<attachments-([0-9a-f]{16,})>/.exec(request.prompt)?.[1],
    );
    expect(boundaries[0]).toBeDefined();
    expect(boundaries[0]).not.toBe(boundaries[1]);
  });

  it.each<[string, PromptInput, ErrorCode]>([
    ["a tool outside the allowlist", { prompt: "hi", tools: ["Bash"] }, "tool_not_allowed"],
    ["a model outside the allowlist", { prompt: "hi", model: "opus" }, "model_not_allowed"],
    ["a timeout above the server maximum", { prompt: "hi", timeoutMs: 600_001 }, "invalid_request"],
    ["a timeout below one second", { prompt: "hi", timeoutMs: 999 }, "invalid_request"],
    ["a zero timeout", { prompt: "hi", timeoutMs: 0 }, "invalid_request"],
    ["a negative timeout", { prompt: "hi", timeoutMs: -1 }, "invalid_request"],
    ["a fractional timeout", { prompt: "hi", timeoutMs: 1500.5 }, "invalid_request"],
    [
      "an attachment name with a quote",
      { prompt: "hi", attachments: [{ name: 'a" b="x', content: "" }] },
      "invalid_request",
    ],
    [
      "an attachment name with a tag",
      { prompt: "hi", attachments: [{ name: "a<b>", content: "" }] },
      "invalid_request",
    ],
    [
      "an attachment name with a newline",
      { prompt: "hi", attachments: [{ name: "a\nb", content: "" }] },
      "invalid_request",
    ],
  ])("rejects %s without calling the backend", async (_name, input, expected) => {
    const { service, backend } = setup();
    expect(await code(service.run(input, ctx()))).toBe(expected);
    expect(backend.requests).toHaveLength(0);
  });

  it("rejects a prompt that would exceed the CLI's stdin limit", async () => {
    const { service, backend } = setup({ LOOPBACK_MAX_BODY_BYTES: String(8 * 1024 * 1024) });
    const big = "x".repeat(5 * 1024 * 1024);
    const input = { prompt: big, attachments: [{ name: "a.txt", content: big }] };
    expect(await code(service.run(input, ctx()))).toBe("payload_too_large");
    expect(backend.requests).toHaveLength(0);
  });
});

describe("prompt service: running", () => {
  it("returns the backend result with the time spent queued", async () => {
    const { service } = setup();
    expect(await service.run({ prompt: "hi" }, ctx())).toEqual({ result: RESULT, queueMs: 0 });
  });

  it("calls onQueued once a slot is held, then onEvent for each non-result event", async () => {
    const { service } = setup();
    const calls: unknown[] = [];
    const outcome = await service.run({ prompt: "hi" }, ctx(), {
      onQueued: (queueMs) => {
        calls.push({ queued: queueMs });
      },
      onEvent: (event) => {
        calls.push(event);
      },
    });
    expect(calls).toEqual([
      { queued: 0 },
      { type: "start", model: "m-1" },
      { type: "delta", text: "pong" },
    ]);
    expect(outcome.result).toEqual(RESULT);
  });

  it("does not call onQueued when validation or queueing fails", async () => {
    const { service } = setup({ LOOPBACK_MAX_CONCURRENCY: "1", LOOPBACK_QUEUE_SIZE: "0" });
    let queued = 0;
    const hooks = {
      onQueued: () => {
        queued++;
      },
    };
    expect(await code(service.run({ prompt: "hi", model: "opus" }, ctx(), hooks))).toBe(
      "model_not_allowed",
    );
    expect(queued).toBe(0);
  });

  it("passes the caller's signal to the backend", async () => {
    const { service, backend } = setup();
    const controller = new AbortController();
    await service.run({ prompt: "hi" }, ctx(controller.signal));
    expect(backend.signals[0]).toBe(controller.signal);
  });

  it("never runs more than the concurrency limit at once, and measures queue time", async () => {
    const { service, backend, clock } = setup({ LOOPBACK_MAX_CONCURRENCY: "1" });
    backend.script({ hold: true });
    const first = service.run({ prompt: "one" }, ctx());
    await flush();
    const second = service.run({ prompt: "two" }, ctx());
    await flush();
    expect(backend.running).toBe(1);
    expect(service.status()).toEqual({ active: 1, waiting: 1 });
    clock.advance(4000);
    backend.release();
    await first;
    expect((await second).queueMs).toBe(4000);
    expect(service.status()).toEqual({ active: 0, waiting: 0 });
  });

  it("drops a queued request whose client goes away, without running it", async () => {
    const { service, backend } = setup({ LOOPBACK_MAX_CONCURRENCY: "1" });
    backend.script({ hold: true });
    const first = service.run({ prompt: "one" }, ctx());
    await flush();
    const controller = new AbortController();
    const second = code(service.run({ prompt: "two" }, ctx(controller.signal)));
    await flush();
    controller.abort();
    expect(await second).toBe("cancelled");
    expect(service.status()).toEqual({ active: 1, waiting: 0 });
    backend.release();
    await first;
    expect(backend.requests).toHaveLength(1);
  });

  it("frees the slot when the backend fails", async () => {
    const { service, backend } = setup({ LOOPBACK_MAX_CONCURRENCY: "1" });
    backend.script({ error: new AppError("cli_failed", "boom") });
    expect(await code(service.run({ prompt: "one" }, ctx()))).toBe("cli_failed");
    expect(await service.run({ prompt: "two" }, ctx())).toMatchObject({ result: RESULT });
  });

  it("frees the slot and stops the backend when an event handler throws", async () => {
    const { service, backend } = setup({ LOOPBACK_MAX_CONCURRENCY: "1" });
    const failing = service.run({ prompt: "one" }, ctx(), {
      onEvent: () => {
        throw new Error("socket closed");
      },
    });
    await expect(failing).rejects.toThrow("socket closed");
    expect(backend.running).toBe(0);
    expect(service.status()).toEqual({ active: 0, waiting: 0 });
    expect(await service.run({ prompt: "two" }, ctx())).toMatchObject({ result: RESULT });
  });

  it("frees the slot when onQueued throws", async () => {
    const { service, backend } = setup({ LOOPBACK_MAX_CONCURRENCY: "1" });
    const failing = service.run({ prompt: "one" }, ctx(), {
      onQueued: () => {
        throw new Error("headers failed");
      },
    });
    await expect(failing).rejects.toThrow("headers failed");
    expect(backend.requests).toHaveLength(0);
    expect(service.status()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("prompt service: logging", () => {
  it("logs a finished run without its prompt or output", async () => {
    const { service, log } = setup();
    await service.run({ prompt: "PRIVATE PROMPT", systemPrompt: "PRIVATE SYSTEM" }, ctx());
    const entry = log.entries().find((line) => line.msg === "prompt finished");
    expect(entry).toMatchObject({ requestId: "req-1", queueMs: 0, model: "m-1" });
    expect(JSON.stringify(log.entries())).not.toMatch(/PRIVATE|pong/);
  });

  it.each<[string, PromptInput, Record<string, string>]>([
    ["a policy rejection", { prompt: "PRIVATE", model: "opus" }, {}],
    [
      "a full queue",
      { prompt: "PRIVATE" },
      { LOOPBACK_MAX_CONCURRENCY: "1", LOOPBACK_QUEUE_SIZE: "0" },
    ],
  ])("logs exactly one failure line for %s", async (_name, input, env) => {
    const { service, backend, log } = setup(env);
    backend.script({ hold: true });
    if (env.LOOPBACK_QUEUE_SIZE === "0") void service.run({ prompt: "holder" }, ctx());
    await flush();
    await service.run(input, ctx()).catch(() => {});
    const failures = log.entries().filter((line) => line.msg === "prompt failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ requestId: "req-1", code: expect.any(String) });
    expect(JSON.stringify(log.entries())).not.toContain("PRIVATE");
    backend.release();
  });

  it("marks client cancellations distinctly from CLI failures", async () => {
    const { service, log } = setup();
    await service.run({ prompt: "hi" }, ctx(AbortSignal.abort())).catch(() => {});
    expect(log.entries().find((line) => line.msg === "prompt failed")).toMatchObject({
      code: "cancelled",
    });
  });
});
