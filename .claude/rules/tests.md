---
paths:
  - "tests/**"
  - "**/*.test.ts"
---

# Tests

- Never run the real `claude` CLI, in any test, ever. CI has no claude installed or logged in.
- Unit tests: inject a fake spawner that emits scripted stdout chunks, stderr, exit codes and
  errors.
- Integration tests: run a fake claude written in Node via `process.execPath` + script path.
  Don't put a `claude` shim on PATH (on Windows that means a `.cmd`, which needs a shell).
- No network beyond the server under test on 127.0.0.1 with an ephemeral port (`port: 0`).
- No wall-clock sleeps for timing: inject the clock or use `vi.useFakeTimers()`.
- Stream parser tests split the same output at every byte boundary and expect identical results.
- Lifecycle tests assert that children (and grandchildren) are killed and temp dirs are removed.
