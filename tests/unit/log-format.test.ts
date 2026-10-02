import { describe, expect, it } from "vitest";
import { formatLine, type Palette } from "../../src/log-format.ts";

const plain: Palette = {
  bold: (text) => text,
  dim: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  red: (text) => text,
  cyan: (text) => text,
};

/** Wraps each color in tags, so tests can see what got which color. */
const tagged: Palette = {
  bold: (text) => `<bold>${text}</bold>`,
  dim: (text) => `<dim>${text}</dim>`,
  green: (text) => `<green>${text}</green>`,
  yellow: (text) => `<yellow>${text}</yellow>`,
  red: (text) => `<red>${text}</red>`,
  cyan: (text) => `<cyan>${text}</cyan>`,
};

const ID = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

describe("formatLine", () => {
  it("shows a request as method, path, status, duration and a short request id", () => {
    const line = formatLine(
      {
        msg: "request",
        requestId: ID,
        method: "POST",
        path: "/v1/prompt",
        status: 200,
        durationMs: 1240,
      },
      plain,
    );
    expect(line).toBe("POST /v1/prompt  200  1.24s  #3f2a9c1e");
  });

  it("shows durations under a second in milliseconds", () => {
    const line = formatLine(
      { msg: "request", requestId: ID, method: "GET", path: "/health", status: 200, durationMs: 3 },
      plain,
    );
    expect(line).toContain("  3ms  ");
  });

  it.each([
    [200, "green"],
    [204, "green"],
    [401, "yellow"],
    [429, "yellow"],
    [499, "yellow"],
    [500, "red"],
    [504, "red"],
  ])("colors status %i %s", (status, color) => {
    const line = formatLine(
      { msg: "request", requestId: ID, method: "GET", path: "/ready", status, durationMs: 1 },
      tagged,
    );
    expect(line).toContain(`<${color}>${status}</${color}>`);
  });

  it("dims the request id", () => {
    const line = formatLine(
      { msg: "request", requestId: ID, method: "GET", path: "/", status: 200, durationMs: 1 },
      tagged,
    );
    expect(line).toContain("<dim>#3f2a9c1e</dim>");
  });

  it("summarizes a finished prompt: model, tokens, cost, time and queue wait", () => {
    const line = formatLine(
      {
        msg: "prompt finished",
        requestId: ID,
        queueMs: 0,
        model: "sonnet",
        durationMs: 2310,
        inputTokens: 120,
        outputTokens: 45,
        costUsd: 0.0031,
      },
      plain,
    );
    expect(line).toBe(
      "prompt finished  sonnet  in 120 · out 45 tok  $0.0031  2.31s  queued 0ms  #3f2a9c1e",
    );
  });

  it("shows a failed prompt's error code in red", () => {
    const line = formatLine(
      { msg: "prompt failed", requestId: ID, queueMs: 12, code: "timeout" },
      tagged,
    );
    expect(line).toContain("<red>timeout</red>");
    expect(line).toContain("queued 12ms");
    expect(
      formatLine({ msg: "prompt failed", requestId: ID, queueMs: 12, code: "timeout" }, plain),
    ).toBe("prompt failed  timeout  queued 12ms  #3f2a9c1e");
  });

  it("shows other messages with their fields as dim key=value pairs", () => {
    expect(formatLine({ msg: "listening", host: "127.0.0.1", port: 7337 }, plain)).toBe(
      "listening  host=127.0.0.1 port=7337",
    );
    expect(formatLine({ msg: "listening", port: 7337 }, tagged)).toBe(
      "listening  <dim>port=7337</dim>",
    );
  });

  it("quotes strings with spaces and shows serialized errors compactly", () => {
    const line = formatLine(
      {
        msg: "claude --version failed",
        reason: "not logged in",
        err: { type: "Error", code: "ENOENT" },
      },
      plain,
    );
    expect(line).toBe('claude --version failed  reason="not logged in" err=Error(ENOENT)');
  });

  it("includes an error message only when the serializer kept one", () => {
    const line = formatLine(
      { msg: "unhandled error", err: { type: "AppError", code: "internal", message: "boom" } },
      plain,
    );
    expect(line).toBe('unhandled error  err=AppError(internal): "boom"');
  });

  it("never shows the level, time or other pino bookkeeping fields", () => {
    const line = formatLine(
      { msg: "stopped", level: 30, time: 1_700_000_000_000, pid: 4, hostname: "pc" },
      plain,
    );
    expect(line).toBe("stopped");
  });

  it("neutralizes terminal control characters in logged values", () => {
    const esc = "\u001b[2J\u001b]0;pwned\u0007";
    const request = formatLine(
      {
        msg: "request",
        requestId: ID,
        method: "GET",
        path: `/x${esc}`,
        status: 404,
        durationMs: 1,
      },
      plain,
    );
    const other = formatLine({ msg: `m${esc}`, model: `s${esc}`, err: { type: `E${esc}` } }, plain);
    for (const line of [request, other]) {
      const control = [...line].filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      });
      expect(control).toEqual([]);
      expect(line).toContain("\\u001b");
    }
  });

  it("falls back gracefully for a request line with missing fields", () => {
    expect(formatLine({ msg: "request" }, plain)).toBe("request");
  });
});
