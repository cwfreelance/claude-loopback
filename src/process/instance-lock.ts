import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StartupError } from "../startup-error.ts";

const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 250;
// A squatted name is replaced by a fresh one; more than this means something is badly wrong.
const MAX_SALT_ROTATIONS = 3;
const CHALLENGE_BYTES = 32;
const CHALLENGE_TIMEOUT_MS = 2000;
const BUSY_ANSWER_ATTEMPTS = 2;

export interface InstanceLock {
  release(): Promise<void>;
}

const SALT = /^[0-9a-f]{64}$/;
const SALT_READ_RETRIES = 20;
const SALT_READ_RETRY_MS = 25;

const saltFile = (workRoot: string) => `${path.resolve(workRoot)}.lock-salt`;

/**
 * A random value kept beside the work root (`<workRoot>.lock-salt`, in the same per-user private
 * folder, and not inside it, so the work root holds only work dirs). Pipe names are
 * machine-wide, so a name derived from the path alone could be created first by another local
 * user to block startup. With the salt, only processes that can read that folder know the name,
 * and only they can answer the lock's challenge.
 */
async function readSalt(workRoot: string): Promise<string> {
  const file = saltFile(workRoot);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // A simultaneous starter may have created the file but not written it yet.
  for (let attempt = 1; ; attempt++) {
    const value = (await readFile(file, "utf8")).trim();
    if (SALT.test(value)) return value;
    if (attempt >= SALT_READ_RETRIES) {
      throw new StartupError(`The instance lock file ${file} is damaged; delete it and retry`);
    }
    await delay(SALT_READ_RETRY_MS);
  }
}

/**
 * Replaces a salt whose pipe name another program has taken, unless another starter already did:
 * the file is checked first and re-read after, so simultaneous starters end up on one salt.
 */
async function rotateSalt(workRoot: string, used: string): Promise<string> {
  const file = saltFile(workRoot);
  if ((await readFile(file, "utf8")).trim() === used) {
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, randomBytes(32).toString("hex"), { flag: "wx" });
    await rename(temp, file);
  }
  return readSalt(workRoot);
}

/** One pipe name per work root and salt; Windows paths are case-insensitive, so the key is too. */
function pipeName(workRoot: string, salt: string): string {
  const key = `${path.resolve(workRoot).toLowerCase()}|${salt}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\loopback-${hash}`;
}

const answer = (salt: string, nonce: Buffer) => createHmac("sha256", salt).update(nonce).digest();

/** The lock's pipe server: answers each connection's nonce with HMAC(salt, nonce), then hangs up. */
function lockServer(salt: string): Server {
  return createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.setTimeout(CHALLENGE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= CHALLENGE_BYTES) {
        socket.end(answer(salt, received.subarray(0, CHALLENGE_BYTES)));
      }
    });
  });
}

type Holder = "genuine" | "impostor" | "busy" | "gone";

/**
 * Who holds the pipe: "genuine" (another claude-loopback with the same salt), "impostor" (a
 * program that answers wrongly or hangs up without answering), "busy" (no answer in time: maybe
 * a stalled instance, so never treated as an impostor) or "gone" (the pipe vanished, e.g. its
 * owner just exited).
 */
function challenge(name: string, salt: string): Promise<Holder> {
  return new Promise((resolve) => {
    const nonce = randomBytes(CHALLENGE_BYTES);
    const expected = answer(salt, nonce);
    let received = Buffer.alloc(0);
    let connected = false;
    const socket = connect(name);
    const finish = (verdict: Holder) => {
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(CHALLENGE_TIMEOUT_MS, () => finish("busy"));
    socket.on("connect", () => {
      connected = true;
      socket.write(nonce);
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= expected.length) {
        const reply = received.subarray(0, expected.length);
        finish(timingSafeEqual(reply, expected) ? "genuine" : "impostor");
      }
    });
    socket.on("end", () => finish("impostor"));
    socket.on("error", () => finish(connected ? "impostor" : "gone"));
  });
}

/**
 * One server per work root: a second instance's startup sweep would delete the first one's
 * active work dirs. The lock is a listening named pipe, so the kernel guarantees a single owner
 * (no check-then-create race) and frees it when the process dies, however it dies, so there are
 * no stale locks or PID-reuse problems. When the name is taken, a challenge tells another
 * claude-loopback (refuse to start) from a squatter (switch to a fresh name).
 * (Windows-only, like v1; POSIX would use a unix socket.)
 */
export async function acquireInstanceLock(workRoot: string): Promise<InstanceLock> {
  let salt = await readSalt(workRoot);
  let rotations = 0;
  for (let attempt = 1; ; attempt++) {
    const name = pipeName(workRoot, salt);
    const server = lockServer(salt);
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
      const holder = await challenge(name, salt);
      if (holder === "genuine") {
        throw new StartupError(
          `Another claude-loopback instance is already running for ${path.resolve(workRoot)}`,
        );
      }
      if (holder === "impostor" && rotations < MAX_SALT_ROTATIONS) {
        rotations++;
        salt = await rotateSalt(workRoot, salt);
        continue;
      }
      // No answer twice in a row: maybe a stalled instance. Starting anyway could delete its
      // work dirs, so refuse.
      if (holder === "busy" && attempt >= BUSY_ANSWER_ATTEMPTS) {
        throw new StartupError(
          `Another claude-loopback instance seems to be running for ${path.resolve(workRoot)} ` +
            "but is not responding; stop it (or the program holding its lock) and retry",
        );
      }
      // A pipe outlives its dead owner for a moment while Windows closes the handles.
      if (attempt >= BUSY_RETRIES) {
        throw new StartupError(
          `Could not take the instance lock for ${path.resolve(workRoot)}; another program may be holding it`,
        );
      }
      await delay(BUSY_RETRY_MS);
    }
  }
}
