import { describe, expect, it } from "vitest";
import { AppError, type ErrorCode } from "../../src/errors.ts";
import { createQueue } from "../../src/service/queue.ts";
import { FakeClock } from "../helpers/app.ts";
import { flush } from "../helpers/backend.ts";

function setup(maxConcurrency = 2, queueSize = 2, maxWaitMs = 60_000) {
  const clock = new FakeClock();
  return { clock, queue: createQueue({ maxConcurrency, queueSize, maxWaitMs, clock }) };
}

async function code(promise: Promise<unknown>): Promise<ErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe("queue", () => {
  it("grants slots immediately up to the concurrency limit", async () => {
    const { queue } = setup(2);
    await queue.acquire();
    await queue.acquire();
    expect(queue.stats()).toEqual({ active: 2, waiting: 0 });
  });

  it("hands freed slots to waiters in arrival order", async () => {
    const { queue } = setup(1);
    const first = await queue.acquire();
    const order: string[] = [];
    const a = queue.acquire().then((slot) => {
      order.push("a");
      return slot;
    });
    const b = queue.acquire().then((slot) => {
      order.push("b");
      return slot;
    });
    await flush();
    expect(queue.stats()).toEqual({ active: 1, waiting: 2 });
    first.release();
    (await a).release();
    await b;
    expect(order).toEqual(["a", "b"]);
    expect(queue.stats()).toEqual({ active: 1, waiting: 0 });
  });

  it("rejects with queue_full and Retry-After when the queue is full", async () => {
    const { queue } = setup(1, 1);
    await queue.acquire();
    void queue.acquire();
    const error = await queue.acquire().catch((e) => e);
    expect((error as AppError).code).toBe("queue_full");
    expect((error as AppError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows no waiting at all with a queue size of 0", async () => {
    const { queue } = setup(1, 0);
    await queue.acquire();
    expect(await code(queue.acquire())).toBe("queue_full");
  });

  it("gives up with queue_timeout after the maximum wait, and frees the place", async () => {
    const { queue, clock } = setup(1, 1, 5000);
    await queue.acquire();
    const waiting = code(queue.acquire());
    await flush();
    clock.advance(5000);
    expect(await waiting).toBe("queue_timeout");
    expect(queue.stats()).toEqual({ active: 1, waiting: 0 });
  });

  it("removes a waiter whose signal aborts, and the next waiter gets the slot", async () => {
    const { queue } = setup(1, 2);
    const holder = await queue.acquire();
    const controller = new AbortController();
    const cancelled = code(queue.acquire(controller.signal));
    const next = queue.acquire();
    await flush();
    controller.abort();
    expect(await cancelled).toBe("cancelled");
    expect(queue.stats()).toEqual({ active: 1, waiting: 1 });
    holder.release();
    await next;
    expect(queue.stats()).toEqual({ active: 1, waiting: 0 });
  });

  it("rejects an already-aborted signal without using a slot", async () => {
    const { queue } = setup(1);
    expect(await code(queue.acquire(AbortSignal.abort()))).toBe("cancelled");
    expect(queue.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("ignores a second release of the same slot", async () => {
    const { queue } = setup(2);
    const slot = await queue.acquire();
    await queue.acquire();
    slot.release();
    slot.release();
    expect(queue.stats()).toEqual({ active: 1, waiting: 0 });
  });

  it("does not time out a waiter that already got its slot", async () => {
    const { queue, clock } = setup(1, 1, 5000);
    const holder = await queue.acquire();
    const waiter = queue.acquire();
    await flush();
    holder.release();
    const slot = await waiter;
    clock.advance(10_000);
    expect(queue.stats()).toEqual({ active: 1, waiting: 0 });
    slot.release();
    expect(queue.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("on close, fails every waiter and every later request with shutting_down", async () => {
    const { queue } = setup(1, 2);
    await queue.acquire();
    const waiting = code(queue.acquire());
    await flush();
    queue.close();
    expect(await waiting).toBe("shutting_down");
    expect(await code(queue.acquire())).toBe("shutting_down");
  });
});
