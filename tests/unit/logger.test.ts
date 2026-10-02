import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { createLogger } from "../../src/logger.ts";

function capture() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { destination, output: () => chunks.join("") };
}

const sensitive = {
  headers: { authorization: "Bearer s3cret-token" },
  token: "s3cret-token",
  prompt: "my private prompt",
  systemPrompt: "my private system prompt",
  attachments: [{ name: "notes.txt", content: "private notes" }],
  output: "private model output",
  requestId: "req-1",
};

describe("createLogger", () => {
  it("writes JSON lines with the message and fields", () => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: false, destination }).info({ requestId: "r1" }, "hi");
    const line = JSON.parse(output().trim());
    expect(line).toMatchObject({ msg: "hi", requestId: "r1", level: 30 });
  });

  it("redacts credentials and prompt contents by default", () => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: false, destination }).info(sensitive, "request");
    const text = output();
    expect(text).toContain("req-1");
    expect(text).not.toContain("s3cret-token");
    expect(text).not.toContain("private");
  });

  it("redacts nested copies one level down", () => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: false, destination }).info({ req: sensitive }, "x");
    expect(output()).not.toMatch(/s3cret-token|private/);
  });

  it("logs prompt contents only when explicitly enabled, never credentials", () => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: true, destination }).info(sensitive, "debug");
    const text = output();
    expect(text).toContain("my private prompt");
    expect(text).not.toContain("s3cret-token");
  });

  it("redacts copies two levels down", () => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: false, destination }).info(
      { deps: { config: sensitive }, req: { body: { prompt: "private body prompt" } } },
      "x",
    );
    expect(output()).not.toMatch(/s3cret-token|private/);
  });

  it.each([
    ["capitalized Authorization header", { headers: { Authorization: "Bearer s3cret-token" } }],
    ["raw header pairs", { rawHeaders: ["Authorization", "Bearer s3cret-token"] }],
    ["env token", { env: { LOOPBACK_TOKEN: "s3cret-token" } }],
    ["API key", { env: { ANTHROPIC_API_KEY: "s3cret-token" } }],
    ["x-api-key header", { headers: { "x-api-key": "s3cret-token" } }],
    ["apiKey field", { backend: { apiKey: "s3cret-token" } }],
    ["cookie header", { headers: { cookie: "session=s3cret-token" } }],
  ])("redacts credentials in %s", (_name, fields) => {
    const { destination, output } = capture();
    createLogger({ level: "info", logPrompts: true, destination }).info(fields, "x");
    expect(output()).not.toContain("s3cret-token");
  });

  it.each(["text", "result", "structuredOutput", "delta", "line", "body", "stderr", "stderrTail"])(
    "treats %s as content and redacts it by default",
    (key) => {
      const { destination, output } = capture();
      createLogger({ level: "info", logPrompts: false, destination }).info(
        { [key]: "private content", run: { [key]: "private nested" } },
        "x",
      );
      expect(output()).not.toContain("private");
    },
  );

  it("logs AppErrors with their client-safe message but without the cause chain", () => {
    const { destination, output } = capture();
    const cause = new Error("stderr: C:\\Users\\me\\private-path");
    const error = new AppError("cli_failed", "Claude CLI failed", { cause });
    createLogger({ level: "info", logPrompts: false, destination }).error(
      { err: error },
      "run failed",
    );
    const line = JSON.parse(output().trim());
    expect(line.err).toMatchObject({
      type: "AppError",
      message: "Claude CLI failed",
      code: "cli_failed",
    });
    expect(output()).not.toContain("private-path");
  });

  it("hides the message of unexpected errors, which may quote request content", () => {
    const { destination, output } = capture();
    const error = new SyntaxError('Unexpected token, "my private prompt" is not valid JSON');
    createLogger({ level: "info", logPrompts: false, destination }).error({ err: error }, "x");
    expect(JSON.parse(output().trim()).err).toMatchObject({ type: "SyntaxError" });
    expect(output()).not.toContain("private");
  });

  it("includes unexpected error messages when prompt logging is enabled", () => {
    const { destination, output } = capture();
    const error = new SyntaxError('"my private prompt" is not valid JSON');
    createLogger({ level: "info", logPrompts: true, destination }).error({ err: error }, "x");
    expect(output()).toContain("my private prompt");
  });

  describe("pretty format", () => {
    const pretty = (logPrompts = false) => {
      const { destination, output } = capture();
      const logger = createLogger({
        level: "info",
        logPrompts,
        destination,
        format: "pretty",
        colorize: false,
      });
      return { logger, output };
    };

    it("writes one readable line per entry, not JSON", () => {
      const { logger, output } = pretty();
      logger.info(
        {
          requestId: "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
          method: "POST",
          path: "/v1/prompt",
          status: 200,
          durationMs: 1240,
        },
        "request",
      );
      const text = output();
      expect(text).toMatch(
        /^\d\d:\d\d:\d\d INFO: POST \/v1\/prompt {2}200 {2}1\.24s {2}#3f2a9c1e\n$/,
      );
      expect(() => JSON.parse(text)).toThrow();
    });

    it("still redacts credentials and prompt contents", () => {
      const { logger, output } = pretty();
      logger.info(sensitive, "request");
      logger.info({ req: sensitive }, "x");
      const text = output();
      expect(text).toContain("INFO: request");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("s3cret-token");
      expect(text).not.toContain("private");
    });

    it("shows prompt contents only with prompt logging on, and never credentials", () => {
      const { logger, output } = pretty(true);
      logger.info(
        { prompt: "visible prompt", headers: { authorization: "Bearer s3cret-token" } },
        "x",
      );
      expect(output()).toContain("INFO: x");
      expect(output()).toContain("visible prompt");
      expect(output()).not.toContain("s3cret-token");
    });

    it("writes no color codes when colors are off", () => {
      const { logger, output } = pretty();
      logger.warn({ status: 500 }, "something");
      expect(output()).toContain("WARN: something");
      expect(output()).not.toContain("\u001b[");
    });

    it("colors the output when asked to", () => {
      const { destination, output } = capture();
      createLogger({
        level: "info",
        logPrompts: false,
        destination,
        format: "pretty",
        colorize: true,
      }).info({ requestId: "r", method: "GET", path: "/", status: 500, durationMs: 1 }, "request");
      expect(output()).toContain("\u001b[");
    });

    it("hides the message of unexpected errors, as JSON mode does", () => {
      const { logger, output } = pretty();
      logger.error({ err: new SyntaxError('"my private prompt" is not valid JSON') }, "x");
      expect(output()).toContain("ERROR: x  err=SyntaxError");
      expect(output()).not.toContain("private");
    });
  });

  it("writes nothing when silent", () => {
    const { destination, output } = capture();
    createLogger({ level: "silent", logPrompts: false, destination }).error("nope");
    expect(output()).toBe("");
  });
});
