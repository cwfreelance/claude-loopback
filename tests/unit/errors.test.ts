import { describe, expect, it } from "vitest";
import { AppError, type ErrorCode, errorStatus, toErrorResponse } from "../../src/errors.ts";

describe("errorStatus", () => {
  it.each<[ErrorCode, number]>([
    ["invalid_request", 400],
    ["tool_not_allowed", 400],
    ["model_not_allowed", 400],
    ["unauthorized", 401],
    ["forbidden_host", 403],
    ["forbidden_origin", 403],
    ["not_found", 404],
    ["method_not_allowed", 405],
    ["payload_too_large", 413],
    ["unsupported_media_type", 415],
    ["queue_full", 429],
    ["rate_limited", 429],
    ["usage_limit", 429],
    ["cancelled", 499],
    ["cli_failed", 502],
    ["cli_protocol_error", 502],
    ["output_too_large", 502],
    ["cli_incompatible", 502],
    ["cli_unavailable", 503],
    ["cli_not_authenticated", 503],
    ["queue_timeout", 503],
    ["shutting_down", 503],
    ["timeout", 504],
    ["internal", 500],
  ])("maps %s to %i", (code, status) => {
    expect(errorStatus(code)).toBe(status);
  });
});

describe("toErrorResponse", () => {
  it("renders an AppError as the standard error body", () => {
    const response = toErrorResponse(new AppError("unauthorized", "Missing bearer token"), "req-1");
    expect(response).toEqual({
      status: 401,
      headers: {},
      body: {
        error: { code: "unauthorized", message: "Missing bearer token", requestId: "req-1" },
      },
    });
  });

  it("adds Retry-After when the error carries one", () => {
    const error = new AppError("queue_full", "Queue is full", { retryAfterSeconds: 5 });
    expect(toErrorResponse(error, "req-2").headers).toEqual({ "Retry-After": "5" });
  });

  it("hides the details of unexpected errors", () => {
    const leaky = new Error("ENOENT: no such file C:\\Users\\me\\secret\\token.txt");
    const response = toErrorResponse(leaky, "req-3");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "internal", message: "Internal server error", requestId: "req-3" },
    });
    expect(JSON.stringify(response)).not.toMatch(/ENOENT|secret|C:\\\\/);
  });

  it("handles thrown non-Error values", () => {
    expect(toErrorResponse("boom", "req-4").body.error.code).toBe("internal");
    expect(toErrorResponse(undefined, "req-5").status).toBe(500);
  });

  it("keeps the cause off the response", () => {
    const error = new AppError("cli_failed", "Claude CLI failed", {
      cause: new Error("stderr: C:\\Users\\me\\.claude\\creds"),
    });
    expect(JSON.stringify(toErrorResponse(error, "req-6"))).not.toContain("creds");
  });
});
