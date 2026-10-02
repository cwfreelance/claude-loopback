import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Captured at load. Helper processes get only this, never the server's environment, and run by
// absolute path so PATH is never searched.
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const TASKKILL = path.win32.join(SYSTEM_ROOT, "System32", "taskkill.exe");
const HELPER_TIMEOUT_MS = 10_000;
// taskkill's exit code when no process matches: it is already gone.
const NOT_FOUND = 128;

/**
 * Kills a process and all of its descendants. Windows has no process groups or SIGTERM for
 * console apps, so this is `taskkill /T /F`. A process that is already gone counts as killed;
 * any other failure rejects so the caller can fall back to its own process handle.
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    // v1 is Windows-only; POSIX process-group kill arrives with macOS/Linux support.
    process.kill(pid, "SIGKILL");
    return;
  }
  try {
    await execFileAsync(TASKKILL, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      env: { SystemRoot: SYSTEM_ROOT },
      timeout: HELPER_TIMEOUT_MS,
    });
  } catch (error) {
    if ((error as { code?: unknown }).code !== NOT_FOUND) throw error;
  }
}

/**
 * Synchronous tree kill for the moment just before a forced exit, when nothing async will run
 * again. Best effort: failures are ignored.
 */
export function killTreeSync(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(pid, "SIGKILL");
      return;
    }
    execFileSync(TASKKILL, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      env: { SystemRoot: SYSTEM_ROOT },
      timeout: HELPER_TIMEOUT_MS,
      stdio: "ignore",
    });
  } catch {}
}
