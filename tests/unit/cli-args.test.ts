import { describe, expect, it } from "vitest";
import { buildArgs } from "../../src/backends/cli/args.ts";
import type { RunRequest } from "../../src/backends/types.ts";
import { AppError } from "../../src/errors.ts";

const BASE = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--tools",
  "",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  "--safe-mode",
  "--restricted",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
];

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  prompt: "SECRET PROMPT TEXT",
  tools: [],
  timeoutMs: 60_000,
  ...overrides,
});

const ALLOWED = { allowedTools: ["WebSearch", "WebFetch"] };

function invalid(overrides: Partial<RunRequest>, policy = ALLOWED): AppError {
  try {
    buildArgs(request(overrides), policy);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected buildArgs to throw");
}

describe("buildArgs", () => {
  it("emits exactly the locked-down base flags for a minimal request", () => {
    expect(buildArgs(request(), ALLOWED)).toEqual(BASE);
  });

  it("never puts the prompt in argv", () => {
    expect(buildArgs(request(), ALLOWED).join(" ")).not.toContain("SECRET PROMPT TEXT");
  });

  it("lists allowed tools in the --tools value", () => {
    const args = buildArgs(request({ tools: ["WebSearch", "WebFetch"] }), ALLOWED);
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
  });

  it("passes optional values in --flag=value form so none can be read as a flag", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    const args = buildArgs(
      request({
        model: "sonnet",
        effort: "low",
        systemPrompt: "--dangerously-skip-permissions",
        jsonSchema: schema,
      }),
      ALLOWED,
    );
    expect(args.slice(BASE.length)).toEqual([
      "--model=sonnet",
      "--effort=low",
      "--append-system-prompt=--dangerously-skip-permissions",
      `--json-schema=${JSON.stringify(schema)}`,
    ]);
  });

  it("keeps quotes, backslashes, newlines and unicode in the system prompt intact", () => {
    const systemPrompt = 'Say "hi" \\ then\nnew line — ✓ 日本';
    expect(buildArgs(request({ systemPrompt }), ALLOWED)).toContain(
      `--append-system-prompt=${systemPrompt}`,
    );
  });

  it.each<[string, Partial<RunRequest>]>([
    ["a model that looks like a flag", { model: "-p" }],
    ["a model with spaces", { model: "son net" }],
    ["a tool rule instead of a tool name", { tools: ["Bash(rm *)"] }],
    ["a tool list injection", { tools: ["Read,Bash"] }],
    ["an unknown effort", { effort: "ultra" as RunRequest["effort"] }],
    ["a NUL character in the system prompt", { systemPrompt: "a\u0000b" }],
  ])("rejects %s", (_name, overrides) => {
    expect(invalid(overrides).code).toBe("invalid_request");
  });

  it("refuses tools outside the server allowlist", () => {
    expect(invalid({ tools: ["Bash"] }).code).toBe("tool_not_allowed");
    expect(invalid({ tools: ["WebSearch"] }, { allowedTools: [] }).code).toBe("tool_not_allowed");
  });

  it.each(["default", "Default", "DEFAULT"])(
    "rejects %s, which would enable every tool, even if allowlisted",
    (tool) => {
      expect(invalid({ tools: [tool] }, { allowedTools: [tool] }).code).toBe("invalid_request");
    },
  );

  it("rejects values that would overflow the Windows command line", () => {
    const error = invalid({
      systemPrompt: "x".repeat(20_000),
      jsonSchema: { d: "y".repeat(20_000) },
    });
    expect(error.code).toBe("invalid_request");
  });
});
