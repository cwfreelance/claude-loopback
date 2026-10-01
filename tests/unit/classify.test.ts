import { describe, expect, it } from "vitest";
import { classifyOutcome } from "../../src/backends/cli/classify.ts";
import type { CliOutcome } from "../../src/backends/cli/stream-parser.ts";
import type { RunResult } from "../../src/backends/types.ts";
import { AppError, type ErrorCode } from "../../src/errors.ts";
import type { ProcessExit } from "../../src/process/runner.ts";
import { fixture } from "../helpers/streams.ts";

const NOW_MS = 1_899_999_000_000; // 1000 s before the fixtures' resetsAt (1_900_000_000)

const result: RunResult = {
  text: "pong",
  model: "m-1",
  stopReason: "end_turn",
  durationMs: 10,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.01,
};
const exit = (overrides: Partial<ProcessExit> = {}): ProcessExit => ({
  code: 0,
  killReason: undefined,
  stderrTail: "",
  durationMs: 10,
  ...overrides,
});
const errorResult = (text = "PRIVATE result text"): CliOutcome["result"] => ({
  isError: true,
  subtype: "success",
  terminalReason: "api_error",
  value: { ...result, text },
});
const success = (
  overrides: Partial<NonNullable<CliOutcome["result"]>> = {},
): NonNullable<CliOutcome["result"]> => ({
  isError: false,
  subtype: "success",
  terminalReason: "completed",
  value: result,
  ...overrides,
});

function classifyError(outcome: CliOutcome, processExit: ProcessExit): AppError {
  try {
    classifyOutcome(outcome, processExit, NOW_MS);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected classifyOutcome to throw");
}

describe("classifyOutcome", () => {
  it("returns a successful result", () => {
    expect(classifyOutcome({ result: success() }, exit(), NOW_MS)).toEqual(result);
  });

  it("accepts a success without a terminal reason (older CLIs)", () => {
    const outcome = { result: success({ terminalReason: undefined }) };
    expect(classifyOutcome(outcome, exit(), NOW_MS)).toEqual(result);
  });

  it("prefers a complete successful result over a late kill", () => {
    const outcome = { result: success() };
    expect(classifyOutcome(outcome, exit({ killReason: "timeout", code: null }), NOW_MS)).toEqual(
      result,
    );
  });

  it.each([
    ["an error subtype", success({ subtype: "error_max_structured_output_retries" })],
    ["a missing subtype", success({ subtype: undefined })],
    ["an error terminal reason", success({ terminalReason: "api_error" })],
    [
      "a deferred tool call",
      success({ value: { ...result, stopReason: "tool_deferred", text: "" } }),
    ],
  ])("does not treat is_error:false with %s as success", (_name, outcomeResult) => {
    expect(classifyError({ result: outcomeResult }, exit({ code: 1 })).code).toBe("cli_failed");
  });

  it.each<[string, CliOutcome, ErrorCode]>([
    [
      "auth failure",
      { result: errorResult(), errorCategory: "authentication_failed" },
      "cli_not_authenticated",
    ],
    [
      "org not allowed",
      { result: errorResult(), errorCategory: "oauth_org_not_allowed" },
      "cli_not_authenticated",
    ],
    ["rate limit category", { result: errorResult(), errorCategory: "rate_limit" }, "usage_limit"],
    [
      "rejected rate-limit status",
      { result: errorResult(), rateLimit: { status: "rejected", resetsAt: 1_900_000_000 } },
      "usage_limit",
    ],
    ["other API error", { result: errorResult(), errorCategory: "overloaded" }, "cli_failed"],
    ["error without category", { result: errorResult() }, "cli_failed"],
  ])("maps an error result (%s) to %s", (_name, outcome, code) => {
    const error = classifyError(outcome, exit({ code: 1 }));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("PRIVATE");
  });

  it("sets Retry-After from the rate-limit reset time", () => {
    const error = classifyError(
      {
        result: errorResult(),
        errorCategory: "rate_limit",
        rateLimit: { status: "rejected", resetsAt: 1_900_000_000 },
      },
      exit({ code: 1 }),
    );
    expect(error.retryAfterSeconds).toBe(1000);
  });

  it("omits Retry-After when the reset time is unknown or past", () => {
    const past = { status: "rejected", resetsAt: 1_000 };
    expect(
      classifyError({ result: errorResult(), rateLimit: past }, exit({ code: 1 }))
        .retryAfterSeconds,
    ).toBeUndefined();
  });

  it("caps Retry-After at seven days", () => {
    const error = classifyError(
      { result: errorResult(), rateLimit: { status: "rejected", resetsAt: 1e300 } },
      exit({ code: 1 }),
    );
    expect(error.retryAfterSeconds).toBe(7 * 24 * 3600);
  });

  it("understands a reset time given in milliseconds", () => {
    const error = classifyError(
      { result: errorResult(), rateLimit: { status: "rejected", resetsAt: 1_900_000_000_000 } },
      exit({ code: 1 }),
    );
    expect(error.retryAfterSeconds).toBe(1000);
  });

  it("does not treat an allowed rate-limit status as a usage limit", () => {
    const outcome = {
      result: errorResult(),
      rateLimit: { status: "allowed", resetsAt: 1_900_000_000 },
    };
    expect(classifyError(outcome, exit({ code: 1 })).code).toBe("cli_failed");
  });

  it.each<[ProcessExit["killReason"], ErrorCode]>([
    ["timeout", "timeout"],
    ["output_too_large", "output_too_large"],
    ["shutdown", "shutting_down"],
    ["aborted", "cli_failed"],
  ])("maps a kill for %s without a result to %s", (killReason, code) => {
    expect(classifyError({}, exit({ code: null, killReason })).code).toBe(code);
  });

  it("recognises the real unknown-flag error as an incompatible CLI", () => {
    const error = classifyError({}, exit({ code: 1, stderrTail: fixture("bad-flag.stderr.txt") }));
    expect(error.code).toBe("cli_incompatible");
    expect(error.message).not.toContain("definitely-not-a-flag");
  });

  it("recognises a not-logged-in message on stderr", () => {
    const error = classifyError(
      {},
      exit({ code: 1, stderrTail: "Not logged in · Please run /login" }),
    );
    expect(error.code).toBe("cli_not_authenticated");
  });

  it("maps any other failure without a result to cli_failed without leaking stderr", () => {
    const error = classifyError({}, exit({ code: 7, stderrTail: "C:\\Users\\me\\secret crash" }));
    expect(error.code).toBe("cli_failed");
    expect(error.message).not.toContain("secret");
  });

  it("treats a clean exit with no result as a protocol error", () => {
    expect(classifyError({}, exit({ code: 0 })).code).toBe("cli_protocol_error");
  });

  it("uses a retry's error category when the run ends without a result", () => {
    const error = classifyError({ errorCategory: "authentication_failed" }, exit({ code: 1 }));
    expect(error.code).toBe("cli_not_authenticated");
  });
});
