import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, scrubSecrets } from "../../src/config.ts";

const TOKEN = "kV3x9-Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN).digest();
const base = { LOOPBACK_TOKEN: TOKEN };

function configErrorOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw ConfigError");
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    expect(loadConfig(base)).toEqual({
      tokenDigest: TOKEN_DIGEST,
      host: "127.0.0.1",
      port: 7337,
      claudePath: undefined,
      maxConcurrency: 2,
      queueSize: 10,
      queueTimeoutMs: 60_000,
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      allowedTools: [],
      allowedModels: ["sonnet", "opus", "haiku", "fable"],
      defaultModel: "sonnet",
      maxBodyBytes: 4 * 1024 * 1024,
      rateLimitPerMin: 30,
      corsOrigins: [],
      logLevel: "info",
      logPrompts: false,
    });
  });

  it("parses numbers, lists, booleans and paths", () => {
    const config = loadConfig({
      ...base,
      LOOPBACK_PORT: "8080",
      LOOPBACK_MAX_CONCURRENCY: "3",
      LOOPBACK_QUEUE_SIZE: "0",
      LOOPBACK_DEFAULT_TIMEOUT_MS: "5000",
      LOOPBACK_MAX_TIMEOUT_MS: "9000",
      LOOPBACK_ALLOWED_TOOLS: " WebSearch , WebFetch ",
      LOOPBACK_ALLOWED_MODELS: "sonnet,claude-opus-5-5",
      LOOPBACK_CORS_ORIGINS: "http://127.0.0.1:3000",
      LOOPBACK_LOG_LEVEL: "debug",
      LOOPBACK_LOG_PROMPTS: "true",
      LOOPBACK_CLAUDE_PATH: "C:\\Tools\\Claude\\claude.exe",
    });
    expect(config).toMatchObject({
      port: 8080,
      maxConcurrency: 3,
      queueSize: 0,
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 9000,
      allowedTools: ["WebSearch", "WebFetch"],
      allowedModels: ["sonnet", "claude-opus-5-5"],
      defaultModel: "sonnet",
      corsOrigins: ["http://127.0.0.1:3000"],
      logLevel: "debug",
      logPrompts: true,
      claudePath: "C:\\Tools\\Claude\\claude.exe",
    });
  });

  it("keeps only a digest of the token, never the plaintext", () => {
    const config = loadConfig(base);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(Object.values(config)).not.toContain(TOKEN);
  });

  it.each([
    "C:\\Tools\\Claude\\claude.exe",
    "c:/tools/claude.exe",
    "C:\\Program Files\\Claude\\CLAUDE.EXE",
  ])("accepts claude path %s", (claudePath) => {
    expect(loadConfig({ ...base, LOOPBACK_CLAUDE_PATH: claudePath }).claudePath).toBe(claudePath);
  });

  it.each([
    ["drive-relative", "/claude.exe"],
    ["UNC share", "\\\\server\\share\\claude.exe"],
    ["UNC with slashes", "//server/share/claude.exe"],
    ["device path", "\\\\?\\C:\\tools\\claude.exe"],
    ["alternate data stream", "C:\\x\\a.txt:claude.exe"],
    ["other executable", "C:\\Tools\\other.exe"],
  ])("rejects %s claude path", (_name, claudePath) => {
    const error = configErrorOf({ ...base, LOOPBACK_CLAUDE_PATH: claudePath });
    expect(error.issues.some((issue) => issue.startsWith("LOOPBACK_CLAUDE_PATH:"))).toBe(true);
  });

  it("uses an explicit default model when it is allowlisted", () => {
    const config = loadConfig({
      ...base,
      LOOPBACK_ALLOWED_MODELS: "haiku,sonnet",
      LOOPBACK_DEFAULT_MODEL: "sonnet",
    });
    expect(config.defaultModel).toBe("sonnet");
  });

  it("defaults the model to the first allowlisted one", () => {
    expect(loadConfig({ ...base, LOOPBACK_ALLOWED_MODELS: "haiku,sonnet" }).defaultModel).toBe(
      "haiku",
    );
  });

  it("rejects a default model outside the allowlist", () => {
    const error = configErrorOf({
      ...base,
      LOOPBACK_ALLOWED_MODELS: "haiku",
      LOOPBACK_DEFAULT_MODEL: "opus",
    });
    expect(error.issues).toContainEqual(
      expect.stringMatching(/^LOOPBACK_DEFAULT_MODEL: .*LOOPBACK_ALLOWED_MODELS/),
    );
  });

  it("allows port 0 for an ephemeral port", () => {
    expect(loadConfig({ ...base, LOOPBACK_PORT: "0" }).port).toBe(0);
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ ...base, LOOPBACK_PORT: "", LOOPBACK_ALLOWED_MODELS: "" });
    expect(config.port).toBe(7337);
    expect(config.allowedModels).toEqual(["sonnet", "opus", "haiku", "fable"]);
  });

  it("ignores env vars outside the LOOPBACK_ prefix", () => {
    const config = loadConfig({ ...base, PATH: "C:\\Windows", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(JSON.stringify(config)).not.toContain("sk-ant-x");
  });

  it("returns a deeply frozen config", () => {
    const config = loadConfig(base);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedModels)).toBe(true);
    expect(Object.isFrozen(config.allowedTools)).toBe(true);
    expect(Object.isFrozen(config.corsOrigins)).toBe(true);
  });

  it.each([
    ["missing token", {}, "LOOPBACK_TOKEN"],
    ["short token", { LOOPBACK_TOKEN: "a".repeat(31) }, "LOOPBACK_TOKEN"],
    [
      "token with whitespace",
      { LOOPBACK_TOKEN: `${"a".repeat(20)} ${"b".repeat(20)}` },
      "LOOPBACK_TOKEN",
    ],
    [
      "non-ASCII token",
      { LOOPBACK_TOKEN: `${"kV3x9Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S"}é` },
      "LOOPBACK_TOKEN",
    ],
    [
      "token with quote",
      { LOOPBACK_TOKEN: `${"kV3x9Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S"}"` },
      "LOOPBACK_TOKEN",
    ],
    ["low-entropy token", { LOOPBACK_TOKEN: "ab".repeat(20) }, "LOOPBACK_TOKEN"],
    ["wildcard host", { ...base, LOOPBACK_HOST: "0.0.0.0" }, "LOOPBACK_HOST"],
    ["LAN host", { ...base, LOOPBACK_HOST: "192.168.1.5" }, "LOOPBACK_HOST"],
    ["port out of range", { ...base, LOOPBACK_PORT: "70000" }, "LOOPBACK_PORT"],
    ["non-numeric port", { ...base, LOOPBACK_PORT: "abc" }, "LOOPBACK_PORT"],
    ["fractional number", { ...base, LOOPBACK_MAX_CONCURRENCY: "1.5" }, "LOOPBACK_MAX_CONCURRENCY"],
    ["zero concurrency", { ...base, LOOPBACK_MAX_CONCURRENCY: "0" }, "LOOPBACK_MAX_CONCURRENCY"],
    [
      "default timeout above max",
      { ...base, LOOPBACK_DEFAULT_TIMEOUT_MS: "700000" },
      "LOOPBACK_DEFAULT_TIMEOUT_MS",
    ],
    ["tiny timeout", { ...base, LOOPBACK_DEFAULT_TIMEOUT_MS: "10" }, "LOOPBACK_DEFAULT_TIMEOUT_MS"],
    [
      "tool rule syntax",
      { ...base, LOOPBACK_ALLOWED_TOOLS: "Bash(rm *)" },
      "LOOPBACK_ALLOWED_TOOLS",
    ],
    [
      "the all-tools keyword",
      { ...base, LOOPBACK_ALLOWED_TOOLS: "WebSearch,Default" },
      "LOOPBACK_ALLOWED_TOOLS",
    ],
    [
      "model with spaces",
      { ...base, LOOPBACK_ALLOWED_MODELS: "son net" },
      "LOOPBACK_ALLOWED_MODELS",
    ],
    ["wildcard origin", { ...base, LOOPBACK_CORS_ORIGINS: "*" }, "LOOPBACK_CORS_ORIGINS"],
    [
      "origin with path",
      { ...base, LOOPBACK_CORS_ORIGINS: "http://example.com/app" },
      "LOOPBACK_CORS_ORIGINS",
    ],
    [
      "relative claude path",
      { ...base, LOOPBACK_CLAUDE_PATH: "claude.exe" },
      "LOOPBACK_CLAUDE_PATH",
    ],
    [
      "cmd shim claude path",
      { ...base, LOOPBACK_CLAUDE_PATH: "C:\\npm\\claude.cmd" },
      "LOOPBACK_CLAUDE_PATH",
    ],
    ["unknown log level", { ...base, LOOPBACK_LOG_LEVEL: "loud" }, "LOOPBACK_LOG_LEVEL"],
    ["non-boolean flag", { ...base, LOOPBACK_LOG_PROMPTS: "maybe" }, "LOOPBACK_LOG_PROMPTS"],
    [
      "body limit above stdin cap",
      { ...base, LOOPBACK_MAX_BODY_BYTES: String(16 * 1024 * 1024) },
      "LOOPBACK_MAX_BODY_BYTES",
    ],
    ["misspelled variable", { ...base, LOOPBACK_TOKNE: "x" }, "LOOPBACK_TOKNE"],
  ])("rejects %s", (_name, env, variable) => {
    const error = configErrorOf(env);
    expect(error.issues.some((issue) => issue.startsWith(`${variable}:`))).toBe(true);
    expect(error.message).toContain(variable);
  });

  it("reports every problem at once", () => {
    const error = configErrorOf({ LOOPBACK_HOST: "0.0.0.0", LOOPBACK_PORT: "abc" });
    expect(error.issues.map((issue) => issue.split(":")[0]).sort()).toEqual([
      "LOOPBACK_HOST",
      "LOOPBACK_PORT",
      "LOOPBACK_TOKEN",
    ]);
  });

  it("accepts generated base64url tokens", () => {
    expect(() =>
      loadConfig({ LOOPBACK_TOKEN: "Zm9vYmFyYmF6cXV4LV9hYmNkZWZnaGlqa2xtbm9wcXJz" }),
    ).not.toThrow();
  });

  it("never echoes the token value in errors", () => {
    const shortSecret = "hunter2-short";
    expect(configErrorOf({ LOOPBACK_TOKEN: shortSecret }).message).not.toContain(shortSecret);
    expect(configErrorOf({ ...base, LOOPBACK_PORT: "x" }).message).not.toContain(TOKEN);
  });
});

describe("scrubSecrets", () => {
  it("removes the loopback token and Anthropic credentials from the environment", () => {
    const env: Record<string, string | undefined> = {
      LOOPBACK_TOKEN: TOKEN,
      LOOPBACK_PORT: "7337",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "y",
      PATH: "C:\\Windows",
    };
    scrubSecrets(env);
    expect(env).toEqual({ LOOPBACK_PORT: "7337", PATH: "C:\\Windows" });
  });

  it("matches names case-insensitively, as Windows does", () => {
    const env: Record<string, string | undefined> = {
      loopback_token: TOKEN,
      anthropic_api_key: "sk-ant-x",
      Anthropic_Base_Url: "https://evil.example",
      Path: "C:\\Windows",
    };
    scrubSecrets(env);
    expect(env).toEqual({ Path: "C:\\Windows" });
  });
});
