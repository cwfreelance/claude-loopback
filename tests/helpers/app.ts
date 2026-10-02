import { Writable } from "node:stream";
import { createApp } from "../../src/app.ts";
import type { Clock, TimerHandle } from "../../src/clock.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { createPromptService } from "../../src/service/prompt-service.ts";
import { createQueue } from "../../src/service/queue.ts";
import { FakeBackend } from "./backend.ts";

export const TOKEN = "5k-Hc8IFDobteldaxMxJ67CukzmSV6uYjPY7MU8Z3UE";

interface FakeTimer {
  at: number;
  callback: () => void;
}

/** Manual clock: time moves only through advance(), which fires due timers in order. */
export class FakeClock implements Clock {
  #now: number;
  #timers = new Map<number, FakeTimer>();
  #nextId = 1;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, callback });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].callback();
    }
    this.#now = target;
  }
}

/** The real app with a captured logger and a fake clock. */
export function buildApp(
  env: Record<string, string> = {},
  clock = new FakeClock(),
  options: { heartbeatMs?: number } = {},
) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const config = loadConfig({ LOOPBACK_TOKEN: TOKEN, ...env });
  const logger = createLogger({ level: "info", logPrompts: false, destination });
  const backend = new FakeBackend();
  const queue = createQueue({
    maxConcurrency: config.maxConcurrency,
    queueSize: config.queueSize,
    maxWaitMs: config.queueTimeoutMs,
    clock,
  });
  const service = createPromptService({ backend, queue, config, clock, logger });
  const app = createApp({ config, logger, clock, service, backend, ...options });
  return {
    app,
    clock,
    backend,
    service,
    logs: () => lines.join(""),
    logEntries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export interface SendOptions {
  method?: string;
  /** Host header; null sends none. Default 127.0.0.1:7337. */
  host?: string | null;
  /** Bearer token; null sends no Authorization header. Default: the valid token. */
  token?: string | null;
  origin?: string;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
}

type App = ReturnType<typeof buildApp>["app"];

export function send(app: App, path: string, options: SendOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.host !== null) headers.set("host", options.host ?? "127.0.0.1:7337");
  if (options.token !== null) headers.set("authorization", `Bearer ${options.token ?? TOKEN}`);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const init: RequestInit & { duplex?: "half" } = {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? null,
  };
  if (options.body instanceof ReadableStream) init.duplex = "half";
  return app.request(`http://127.0.0.1:7337${path}`, init);
}

export async function errorBody(response: Response) {
  return (
    (await response.json()) as { error: { code: string; message: string; requestId: string } }
  ).error;
}
