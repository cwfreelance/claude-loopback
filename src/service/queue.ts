import type { Clock, TimerHandle } from "../clock.ts";
import { AppError } from "../errors.ts";

export interface Slot {
  /** Frees the slot (or hands it straight to the next waiter). Idempotent. */
  release(): void;
}

export interface QueueStats {
  readonly active: number;
  readonly waiting: number;
}

export interface Queue {
  acquire(signal?: AbortSignal): Promise<Slot>;
  stats(): QueueStats;
  /** Fails every waiter and every later acquire with shutting_down. Held slots stay valid. */
  close(): void;
}

export interface QueueOptions {
  readonly maxConcurrency: number;
  readonly queueSize: number;
  readonly maxWaitMs: number;
  readonly clock: Clock;
}

interface Waiter {
  resolve(slot: Slot): void;
  reject(error: AppError): void;
  timer?: TimerHandle;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const QUEUE_FULL_RETRY_AFTER_SECONDS = 5;

const cancelled = () => new AppError("cancelled", "Request was cancelled while queued");
const shuttingDown = () => new AppError("shutting_down", "Server is shutting down");

/** Concurrency limiter with a bounded FIFO wait queue, a maximum wait, and abortable waits. */
export function createQueue({ maxConcurrency, queueSize, maxWaitMs, clock }: QueueOptions): Queue {
  let active = 0;
  let closed = false;
  const waiting: Waiter[] = [];

  const detach = (waiter: Waiter) => {
    if (waiter.timer !== undefined) clock.clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  };
  const remove = (waiter: Waiter) => {
    const index = waiting.indexOf(waiter);
    if (index !== -1) waiting.splice(index, 1);
    detach(waiter);
  };

  function slot(): Slot {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) {
          // Hand the slot over directly: `active` stays the same.
          detach(next);
          next.resolve(slot());
        } else {
          active--;
        }
      },
    };
  }

  function acquire(signal?: AbortSignal): Promise<Slot> {
    if (closed) return Promise.reject(shuttingDown());
    if (signal?.aborted) return Promise.reject(cancelled());
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve(slot());
    }
    if (waiting.length >= queueSize) {
      return Promise.reject(
        new AppError("queue_full", "Too many requests are waiting", {
          retryAfterSeconds: QUEUE_FULL_RETRY_AFTER_SECONDS,
        }),
      );
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timer = clock.setTimeout(() => {
        remove(waiter);
        reject(new AppError("queue_timeout", "Timed out waiting for a free slot"));
      }, maxWaitMs);
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          remove(waiter);
          reject(cancelled());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiting.push(waiter);
    });
  }

  return {
    acquire,
    stats: () => ({ active, waiting: waiting.length }),
    close() {
      closed = true;
      for (const waiter of waiting.splice(0)) {
        detach(waiter);
        waiter.reject(shuttingDown());
      }
    },
  };
}
