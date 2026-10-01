export type TimerHandle = ReturnType<typeof setTimeout>;

/** Time source, injected so tests can control timeouts without sleeping. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

// Monotonic: an NTP correction or manual clock change can't make time run backwards.
export const systemClock: Clock = {
  now: () => performance.timeOrigin + performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
