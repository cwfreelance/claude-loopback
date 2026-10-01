import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StartupError } from "../startup-error.ts";

const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 250;

export interface InstanceLock {
  release(): Promise<void>;
}

/** One pipe name per work root; Windows paths are case-insensitive, so the key is too. */
function pipeName(workRoot: string): string {
  const key = path.resolve(workRoot).toLowerCase();
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\loopback-${hash}`;
}

/**
 * One server per work root: a second instance's startup sweep would delete the first one's
 * active work dirs. The lock is a listening named pipe, so the kernel guarantees a single owner
 * (no check-then-create race) and frees it when the process dies, however it dies, so there are
 * no stale locks or PID-reuse problems. Connections to the pipe are refused.
 * (Windows-only, like v1; POSIX would use a unix socket.)
 */
export async function acquireInstanceLock(workRoot: string): Promise<InstanceLock> {
  const name = pipeName(workRoot);
  for (let attempt = 1; ; attempt++) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });
      server.unref(); // the lock alone never keeps the process alive
      return {
        release: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // A pipe outlives its dead owner for a moment while Windows closes the handles.
      if (attempt >= BUSY_RETRIES) {
        throw new StartupError(
          `Another loopback instance is already running for ${path.resolve(workRoot)}`,
        );
      }
      await delay(BUSY_RETRY_MS);
    }
  }
}
