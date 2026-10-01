import { AppError } from "../../errors.ts";
import type { RunRequest } from "../types.ts";

// Mandatory isolation: no tools unless allowlisted, nothing that would prompt, no session files,
// and none of the user's settings, plugins, hooks, MCP servers, skills or CLAUDE.md.
// (--safe-mode alone still loads user plugins; --setting-sources "" is what keeps them out.)
const TOOLS_VALUE_INDEX = 6;
const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--tools",
  "", // TOOLS_VALUE_INDEX
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
] as const;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALL_TOOLS_KEYWORD = "default";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// CreateProcess caps the whole command line at 32,767 chars, including the exe path and quoting.
const MAX_COMMAND_LINE = 30_000;

const invalid = (message: string) => new AppError("invalid_request", message);

/** Rough upper bound of an argument's length once Windows-quoted. */
const quotedLength = (arg: string) => arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3;

export interface ArgsPolicy {
  /** The server allowlist (LOOPBACK_ALLOWED_TOOLS); requests may only narrow it. */
  readonly allowedTools: readonly string[];
}

/**
 * The CLI's argv for one run. The tool allowlist is enforced here, where argv is built, and other
 * values are re-validated as defense in depth. Every optional value uses `--flag=value`, so no
 * value can ever be parsed as a flag. The prompt itself goes on stdin, never argv.
 */
export function buildArgs(request: RunRequest, policy: ArgsPolicy): string[] {
  for (const tool of request.tools) {
    // `--tools default` means "every built-in tool", so it is never a tool name.
    if (!TOOL.test(tool) || tool.toLowerCase() === ALL_TOOLS_KEYWORD) {
      throw invalid("tools must be plain tool names");
    }
    if (!policy.allowedTools.includes(tool)) {
      throw new AppError("tool_not_allowed", `Tool ${tool} is not enabled on this server`);
    }
  }
  const args: string[] = [...BASE_ARGS];
  args[TOOLS_VALUE_INDEX] = request.tools.join(",");

  if (request.model !== undefined) {
    if (!MODEL.test(request.model)) throw invalid("model is not a valid model name");
    args.push(`--model=${request.model}`);
  }
  if (request.effort !== undefined) {
    if (!EFFORTS.has(request.effort)) throw invalid("effort is not a valid level");
    args.push(`--effort=${request.effort}`);
  }
  if (request.systemPrompt !== undefined) {
    if (request.systemPrompt.includes("\u0000"))
      throw invalid("systemPrompt contains a NUL character");
    args.push(`--append-system-prompt=${request.systemPrompt}`);
  }
  if (request.jsonSchema !== undefined) {
    args.push(`--json-schema=${JSON.stringify(request.jsonSchema)}`);
  }

  if (args.reduce((total, arg) => total + quotedLength(arg), 0) > MAX_COMMAND_LINE) {
    throw invalid("systemPrompt and jsonSchema are too large together");
  }
  return args;
}
