import path from "node:path";
import { Writable } from "node:stream";
import type { ProcessRunner } from "../../src/process/runner.ts";
import { startServer } from "../../src/server.ts";
import { TOKEN } from "./app.ts";
import { FAKE_CLAUDE, scratchRoot } from "./process.ts";

export interface LiveOptions {
  /** Environment for the fake CLI (FAKE_CLAUDE_SCENARIO etc.). */
  readonly cli?: Record<string, string>;
  /** Extra LOOPBACK_* settings. */
  readonly config?: Record<string, string>;
}

/**
 * The real server (startServer: app, service, CLI backend, runner) on 127.0.0.1 with an ephemeral
 * port, running the fake CLI instead of claude.exe. Records the PID of every spawned process.
 */
export async function startLive({ cli = {}, config = {} }: LiveOptions = {}) {
  const lines: string[] = [];
  const pids: number[] = [];
  const server = await startServer({
    env: { LOOPBACK_TOKEN: TOKEN, LOOPBACK_PORT: "0", ...config },
    claude: { command: process.execPath, prefixArgs: [FAKE_CLAUDE], env: cli },
    workRoot: path.join(scratchRoot(), "work"),
    logDestination: new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    }),
    wrapRunner: (runner): ProcessRunner => ({
      async start(spec) {
        const run = await runner.start(spec);
        pids.push(run.pid);
        return run;
      },
    }),
  });
  return {
    ...server,
    url: `http://127.0.0.1:${server.port}`,
    pids,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export const authHeaders = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};
