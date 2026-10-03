import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Captured at load. Helper processes get only this, never the server's environment, and run by
// absolute path so PATH is never searched.
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const TASKKILL = path.win32.join(SYSTEM_ROOT, "System32", "taskkill.exe");
const HELPER_TIMEOUT_MS = 10_000;
// taskkill's exit code when no process matches: it is already gone.
const NOT_FOUND = 128;
// POSIX: how long the process group gets to exit after SIGTERM before SIGKILL.
const GRACE_MS = 2000;
const POLL_MS = 50;

/** Signals a whole process group. False when the group no longer exists; other failures throw. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Kills a process and all of its descendants. A process that is already gone counts as killed;
 * any other failure rejects so the caller can fall back to its own process handle.
 *
 * Windows has no process groups or SIGTERM for console apps, so this is `taskkill /T /F`.
 * Elsewhere `pid` must lead its own process group (the runner spawns it detached): the group gets
 * SIGTERM, then SIGKILL if it is still there after a grace period. A descendant that started its
 * own session (setsid) is outside the group and survives.
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    if (!signalGroup(pid, "SIGTERM")) return;
    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline) {
      await delay(POLL_MS);
      if (!signalGroup(pid, 0)) return;
    }
    signalGroup(pid, "SIGKILL");
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
 * again (so no grace period: the process group gets SIGKILL). Best effort: failures are ignored.
 */
export function killTreeSync(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGKILL");
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
