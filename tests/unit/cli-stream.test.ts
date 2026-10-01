import { describe, expect, it } from "vitest";
import { interpretCliStream } from "../../src/backends/cli/stream-parser.ts";
import type { RunEvent } from "../../src/backends/types.ts";
import { AppError } from "../../src/errors.ts";
import { captureLogger } from "../helpers/process.ts";
import { drain, fixtureLines, fromArray } from "../helpers/streams.ts";

function interpret(lines: string[]) {
  const log = captureLogger();
  return { run: drain(interpretCliStream(fromArray(lines), log.logger)), log };
}

const deltaText = (events: RunEvent[]) =>
  events.map((event) => (event.type === "delta" ? event.text : "")).join("");

describe("interpretCliStream on real captures", () => {
  it("turns a successful run into start, text deltas and a result", async () => {
    const { items, returned } = await interpret(fixtureLines("success.ndjson")).run;
    expect(items[0]).toEqual({ type: "start", model: "claude-haiku-4-5-20251001" });
    expect(deltaText(items)).toBe("pong");
    expect(items.filter((event) => event.type === "result")).toEqual([]);
    expect(returned.result).toEqual({
      isError: false,
      subtype: "success",
      terminalReason: "completed",
      value: {
        text: "pong",
        model: "claude-haiku-4-5-20251001",
        stopReason: "end_turn",
        durationMs: expect.any(Number),
        usage: {
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          cacheReadTokens: expect.any(Number),
          cacheCreationTokens: expect.any(Number),
        },
        costUsd: expect.any(Number),
      },
    });
    expect(returned.result?.value.usage.inputTokens).toBeGreaterThan(0);
  });

  it("returns structured output and emits no deltas for the schema tool's JSON input", async () => {
    const { items, returned } = await interpret(fixtureLines("schema.ndjson")).run;
    expect(deltaText(items)).toBe("");
    expect(returned.result?.value.structuredOutput).toEqual({
      answer: "The capital of France is Paris.",
    });
    expect(returned.result?.isError).toBe(false);
  });

  it("reports an error result with its error category when not logged in", async () => {
    const { returned } = await interpret(fixtureLines("logged-out.ndjson")).run;
    expect(returned.result?.isError).toBe(true);
    expect(returned.errorCategory).toBe("authentication_failed");
  });

  it("records the latest rate-limit status", async () => {
    const { returned } = await interpret(fixtureLines("success.ndjson")).run;
    expect(returned.rateLimit).toEqual({ status: "allowed", resetsAt: 1_900_000_000 });
  });
});

describe("interpretCliStream on synthetic lines", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", model: "m-1" });
  const textDelta = (text: string, parent: string | null = null) =>
    JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    });
  const result = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      stop_reason: "end_turn",
      duration_ms: 12,
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2 },
      ...overrides,
    });

  it("ignores text from subagents", async () => {
    const { items } = await interpret([
      init,
      textDelta("mine"),
      textDelta("theirs", "toolu_1"),
      result(),
    ]).run;
    expect(deltaText(items)).toBe("mine");
  });

  it("never emits thinking, signatures or tool input as text", async () => {
    const delta = (inner: Record<string, unknown>) =>
      JSON.stringify({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: inner },
      });
    const lines = [
      init,
      delta({ type: "thinking_delta", thinking: "SECRET REASONING" }),
      delta({ type: "signature_delta", signature: "SIGNATURE" }),
      delta({ type: "input_json_delta", partial_json: '{"TOOL":' }),
      textDelta("visible"),
      result(),
    ];
    const { items } = await interpret(lines).run;
    expect(deltaText(items)).toBe("visible");
  });

  it("ignores event types it does not know", async () => {
    const lines = [init, JSON.stringify({ type: "brand_new_event", x: 1 }), result()];
    const { items, returned } = await interpret(lines).run;
    expect(items).toEqual([{ type: "start", model: "m-1" }]);
    expect(returned.result?.value.text).toBe("done");
  });

  it("defaults missing usage fields to zero", async () => {
    const { returned } = await interpret([init, result()]).run;
    expect(returned.result?.value.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("emits retry events and remembers their error category", async () => {
    const retry = JSON.stringify({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 4000,
      error_status: 429,
      error: "rate_limit",
    });
    const { items, returned } = await interpret([init, retry]).run;
    expect(items).toContainEqual({
      type: "retry",
      attempt: 2,
      maxRetries: 10,
      delayMs: 4000,
      error: "rate_limit",
    });
    expect(returned).toMatchObject({ errorCategory: "rate_limit" });
    expect(returned.result).toBeUndefined();
  });

  it("skips a single malformed line and logs it without its content", async () => {
    const { run, log } = interpret([init, "{not json SECRET", textDelta("ok"), result()]);
    const { items, returned } = await run;
    expect(deltaText(items)).toBe("ok");
    expect(returned.result?.value.text).toBe("done");
    expect(log.entries().some((entry) => entry.level === 40)).toBe(true);
    expect(JSON.stringify(log.entries())).not.toContain("SECRET");
  });

  it("fails with cli_protocol_error on a second malformed line", async () => {
    const error = await interpret([init, "{bad", "[also bad", result()]).run.catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("counts JSON that isn't an object as malformed", async () => {
    const error = await interpret([init, "42", '"text"', result()]).run.catch((e) => e);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("fails with cli_protocol_error when the result line lacks required fields", async () => {
    const broken = JSON.stringify({ type: "result", subtype: "success" });
    const error = await interpret([init, broken]).run.catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("replaces error categories that don't look like CLI identifiers", async () => {
    const retry = JSON.stringify({
      type: "system",
      subtype: "api_retry",
      error: "C:\\Users\\me\\leaked path",
    });
    const { items, returned } = await interpret([init, retry]).run;
    expect(items).toContainEqual(expect.objectContaining({ type: "retry", error: "unknown" }));
    expect(returned.errorCategory).toBe("unknown");
  });

  it("forgets an earlier retry category once a normal assistant message arrives", async () => {
    const retry = JSON.stringify({ type: "system", subtype: "api_retry", error: "rate_limit" });
    const assistant = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [] },
    });
    const { returned } = await interpret([init, retry, assistant]).run;
    expect(returned.errorCategory).toBeUndefined();
  });

  it("ignores deltas that arrive after the result", async () => {
    const { items } = await interpret([init, textDelta("before"), result(), textDelta("after")])
      .run;
    expect(deltaText(items)).toBe("before");
  });

  it("fails with cli_protocol_error on a second result line", async () => {
    const error = await interpret([init, result(), result({ is_error: true })]).run.catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("rejects structured output nested deeper than 256 levels", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 300; i++) deep = { d: deep };
    const error = await interpret([init, result({ structured_output: deep })]).run.catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("accepts structured output of ordinary depth", async () => {
    let nested: unknown = [1, 2, 3];
    for (let i = 0; i < 50; i++) nested = { level: i, nested };
    const { returned } = await interpret([init, result({ structured_output: nested })]).run;
    expect(returned.result?.value.structuredOutput).toEqual(nested);
  });

  it("falls back to the model in modelUsage when init is missing", async () => {
    const { returned } = await interpret([result({ modelUsage: { "m-2": {} } })]).run;
    expect(returned.result?.value.model).toBe("m-2");
  });
});
