import { rm as fsRm, mkdir, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.ts";

export interface TempDirs {
  /** Creates a fresh, empty `req-*` directory directly under the root. */
  create(): Promise<string>;
  /** Removes a directory created by create(). Never throws; failures are logged. */
  remove(dir: string): Promise<void>;
  /** Removes every leftover `req-*` directory; returns how many there were. */
  sweep(): Promise<number>;
}

export interface TempDirOptions {
  readonly root: string;
  readonly logger: Logger;
  readonly rm?: typeof fsRm;
}

const PREFIX = "req-";

export function createTempDirs({ root, logger, rm = fsRm }: TempDirOptions): TempDirs {
  const resolvedRoot = path.resolve(root);
  // Only direct req-* children of the root may ever be deleted.
  const isOwned = (dir: string) => {
    const resolved = path.resolve(dir);
    return path.dirname(resolved) === resolvedRoot && path.basename(resolved).startsWith(PREFIX);
  };

  async function remove(dir: string): Promise<void> {
    if (!isOwned(dir)) {
      logger.error({ dir }, "refusing to remove a directory outside the temp root");
      return;
    }
    try {
      // Windows can hold handles briefly after a process is killed, hence the retries.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      logger.warn(
        { dir, code: (error as NodeJS.ErrnoException).code },
        "could not remove temp dir",
      );
    }
  }

  return {
    async create() {
      await mkdir(resolvedRoot, { recursive: true });
      return mkdtemp(path.join(resolvedRoot, PREFIX));
    },
    remove,
    async sweep() {
      let entries: string[];
      try {
        entries = await readdir(resolvedRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      const leftovers = entries.filter((entry) => entry.startsWith(PREFIX));
      await Promise.all(leftovers.map((entry) => remove(path.join(resolvedRoot, entry))));
      return leftovers.length;
    },
  };
}
