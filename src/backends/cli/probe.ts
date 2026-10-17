import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
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

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const WIN32 = process.platform === "win32";
const SHIMS = ["claude.cmd", "claude.bat", "claude.ps1"];
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Finds the claude executable once, at boot, so the runner never spawns a bare name (Windows
 * would search the child's temp cwd first). Only absolute PATH entries count. Windows: claude.exe,
 * and .cmd/.bat shims are refused because they need a shell. Elsewhere: an executable file named
 * claude (a wrapper script runs without a shell, so none is refused), with symlinks resolved so
 * the file checked here is the one every spawn runs.
 */
export async function resolveClaudePath(
  configured: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (configured !== undefined) {
    if (await isFile(configured)) return WIN32 ? configured : realpath(configured);
    throw new AppError("cli_unavailable", "LOOPBACK_CLAUDE_PATH does not point to a file");
  }
  if (!WIN32) {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      const file = path.join(dir, "claude");
      if (await isExecutable(file)) return realpath(file);
    }
    throw new AppError(
      "cli_unavailable",
      "claude was not found on PATH; install Claude Code or set LOOPBACK_CLAUDE_PATH",
    );
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
