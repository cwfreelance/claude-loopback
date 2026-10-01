import { stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../errors.ts";

/** Oldest CLI with every flag loopback passes (--permission-prompts arrived in 2.1.259). */
export const MIN_CLI_VERSION = "2.1.259";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/;

/** "2.1.287 (Claude Code)" → "2.1.287". */
export function parseVersion(output: string): string | undefined {
  const match = VERSION.exec(output.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

const parts = (version: string) => version.split(".").map(Number);

export function isSupportedVersion(version: string): boolean {
  const have = parts(version);
  const need = parts(MIN_CLI_VERSION);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const SHIMS = ["claude.cmd", "claude.bat", "claude.ps1"];
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Finds claude.exe once, at boot, so the runner never spawns a bare name (Windows would search
 * the child's temp cwd first). Only drive-absolute PATH entries count; .cmd/.bat shims are
 * refused because they need a shell.
 */
export async function resolveClaudePath(
  configured: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (configured !== undefined) {
    if (await isFile(configured)) return configured;
    throw new AppError("cli_unavailable", "LOOPBACK_CLAUDE_PATH does not point to a file");
  }
  const searchPath = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  let sawShim = false;
  for (const raw of searchPath.split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!DRIVE_ABSOLUTE.test(dir)) continue;
    const exe = path.join(dir, "claude.exe");
    if (await isFile(exe)) return exe;
    for (const shim of SHIMS) if (await isFile(path.join(dir, shim))) sawShim = true;
  }
  throw new AppError(
    "cli_unavailable",
    sawShim
      ? "Only a claude.cmd/.bat shim is on PATH; set LOOPBACK_CLAUDE_PATH to claude.exe"
      : "claude.exe was not found on PATH; install Claude Code or set LOOPBACK_CLAUDE_PATH",
  );
}
