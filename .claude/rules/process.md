---
paths:
  - "src/backends/**"
  - "src/process/**"
---

# Spawning the claude CLI (Windows-only in v1)

- `spawn` with `shell: false` and an argument array. Never build a command string.
- Resolve `claude` to a real `.exe`. Never spawn `.cmd`/`.bat` shims: Node refuses them without a
  shell (EINVAL), and adding a shell reintroduces injection risk.
- Pass the prompt on stdin, not argv (argv has a length cap and is visible in process listings).
- Child env is an **allowlist** built from scratch, never `{ ...process.env }`. It must never
  contain `ANTHROPIC_API_KEY` or `LOOPBACK_TOKEN`.
- `cwd` is a fresh temp dir per request (`fs.mkdtemp` under `os.tmpdir()`), removed afterwards,
  with removal errors logged and not thrown. Never the repo or the home dir.
- Kill the whole tree with `taskkill /PID <pid> /T /F` (no POSIX process groups on Windows;
  `child.kill()` alone leaves grandchildren running). Kill on timeout, client disconnect and
  shutdown.
- Set `windowsHide: true` so no console windows flash.
- Cap buffered stdout/stderr. Never forward raw stderr or file paths to clients.
- Verify every CLI flag against `claude --help` for the installed version, not memory.
