# loopback — Design Decisions & Edge Cases

A checklist of decisions and edge cases. Each item records the choice and the reason
(**→**). Items decided during implementation are added at the bottom with their milestone.

---

## 1. Scope & non-goals

- [x] **Who is it for?** Single user, single machine.
  **→** Not multi-user, not public, not a hosted service. This keeps the security model simple
  (one token, loopback only). The README lists these as non-goals.
- [x] **Is it a Messages API clone?** No.
  **→** It exposes Claude Code's headless agent (with tools off by default), not raw model access.
  Expecting API parity would mislead.
- [x] **Supported OS.** Windows only in v1.
  **→** It's the owner's machine. Windows has no POSIX process groups, so tree kill uses
  `taskkill /T /F` behind a `killTree` seam that macOS/Linux can implement later.
- [x] **Supported claude CLI versions.** Refuse below 2.1.259; log the version at startup.
  **→** 2.1.259 introduced `--permission-prompts`, which we depend on. Newer versions are allowed
  because the stream parser ignores unknown events.

## 2. API design

- [x] **Schema style.** Own minimal schema.
  **→** Smallest surface. An OpenAI-style adapter can be added later as a thin route over the
  same service.
- [x] **Versioning.** `/v1` prefix from day one.
  **→** Free now, painful later.
- [x] **Endpoints.** `POST /v1/prompt`, `POST /v1/prompt/stream`, `GET /health`, `GET /ready`.
  **→** A separate stream route instead of a `stream: true` flag, so each route has one response
  type, which keeps the types and tests simpler.
- [x] **Request fields.** `prompt`, `attachments`, `model`, `systemPrompt`, `effort`,
  `jsonSchema`, `tools`, `timeoutMs`.
  **→** These cover basic scripted LLM work. `attachments` are text files inlined into the stdin
  prompt, so context works with no tools. Every field is validated and capped.
- [x] **Per-request overrides vs. server config.** Requests can only narrow.
  **→** `tools` must be a subset of `LOOPBACK_ALLOWED_TOOLS`, `model` must be in
  `LOOPBACK_ALLOWED_MODELS`, and `timeoutMs` must be ≤ `LOOPBACK_MAX_TIMEOUT_MS`.
- [x] **Sessions / multi-turn.** Stateless only in v1 (`--no-session-persistence`).
  **→** No session state to store, expire or clean up. Resume support can come later.
- [x] **Response shape.** `{ id, text, structuredOutput?, model, stopReason, durationMs, queueMs,
  usage, costUsd }`.
  **→** Mirrors what the CLI's `result` line reports. `costUsd` is the CLI's estimate.
- [x] **Request size limits.** Body ≤ 4 MiB by default (capped at 8 MiB) → 413. Prompt
  ≤ 200k chars, attachments ≤ 20 files and ≤ 2 MB.
  **→** Rejects early. The CLI caps piped stdin at 10 MB.

## 3. Process management

- [x] **Spawn method.** `child_process.spawn`, `shell: false`, argv array, no execa.
  **→** No extra dependency, and full control over stdio and kill behavior.
- [x] **How the prompt is passed.** stdin.
  **→** argv is length-limited (32K on Windows) and visible in process listings.
- [x] **Working directory.** Fresh `%TEMP%\loopback\req-<id>` per request. Removed after exit
  with retries. Stale dirs are swept at boot.
  **→** No state leaks between requests. Windows holds handles briefly after a kill, so the
  removal retries.
- [x] **Environment.** Allowlist (Windows system and profile vars, proxy, `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_GIT_BASH_PATH`) plus `DISABLE_AUTOUPDATER=1`.
  **→** A denylist misses new secrets. `ANTHROPIC_*` and `LOOPBACK_*` are never copied, and
  tests assert it.
- [x] **Timeouts.** 120 s default, 600 s max, and clients may lower it.
  **→** Long enough for heavy prompts, bounded against hangs.
- [x] **Kill strategy.** `taskkill /PID <pid> /T /F` straight away.
  **→** Windows console processes have no SIGTERM; `child.kill()` is a hard terminate that
  misses grandchildren. `/T` takes the whole tree.
- [x] **Client disconnect.** The abort signal kills the child immediately.
  **→** Don't spend usage on answers nobody receives.
- [x] **Output buffering.** stdout lines ≤ 1 MB each and ≤ 20 MB total; stderr kept as a 64 KB
  ring buffer, used only for classification and logs.
  **→** Bounded memory per request.
- [x] **Exit handling.** A `result` line wins. Otherwise the exit code and stderr patterns map to
  `cli_incompatible` / `cli_not_authenticated` / `cli_failed`.
  **→** Clients get actionable codes, never raw stderr.
- [x] **Startup checks.** CLI missing or too old → refuse to start. Not logged in → start, but
  `/ready` returns 503 (re-probed, cached 30 s).
  **→** Logging in shouldn't require a server restart.
- [x] **Orphan cleanup.** PID registry on disk. At boot, leftover PIDs are killed only if
  `tasklist` still reports `claude.exe`.
  **→** No job objects without a native module, and the image-name check guards against reused
  PIDs.

## 4. Streaming

- [x] **Line parsing.** `StringDecoder` + buffered partial lines.
  **→** Chunks split lines and multibyte characters anywhere.
- [x] **Malformed lines.** Log and skip the first; fail with `cli_protocol_error` on the second.
  **→** Tolerates a one-off glitch without hiding a broken protocol.
- [x] **Event mapping.** Own SSE events: `start`, `delta`, `retry`, `result`, `error`.
  **→** Decouples clients from CLI changes. Unknown CLI events are ignored.
- [x] **Errors after headers are sent.** An `error` SSE event, then the stream closes.
  **→** The HTTP status can't change mid-stream.
- [x] **Heartbeats.** `: ping` comment every 15 s.
  **→** Keeps proxies and clients from timing out during long runs.
- [x] **Backpressure.** Pull-based: the parser reads `child.stdout` only as fast as the SSE
  client consumes.
  **→** The pipe pushes back on the child. No unbounded buffering, and the timeout still applies.
- [x] **Final event.** Always exactly one `result` or `error`.
  **→** Clients can tell a clean finish from a dropped connection.

## 5. Concurrency & limits

- [x] **Max concurrent processes.** 2.
  **→** Each process is heavy, and they all share one subscription.
- [x] **Queue.** FIFO of 10, max wait 60 s. Full → 429 `queue_full` with `Retry-After`; waited too
  long → 503 `queue_timeout`. Disconnected waiters are dropped.
  **→** Absorbs bursts from scripts without unbounded waiting.
- [x] **Subscription usage limits.** An error `result` or a final `rate_limit` retry maps to 429
  `usage_limit`, with `Retry-After` when a reset time can be parsed.
  **→** Scripts can back off instead of seeing a generic 500.
- [x] **Graceful shutdown.** SIGINT/SIGBREAK/SIGTERM: stop accepting, fail queued requests with
  503, give in-flight requests 10 s, then tree-kill and clean up.
  **→** Ctrl+C never leaves orphans or temp dirs behind.

## 6. Security

- [x] **Bind address.** 127.0.0.1 only, with no override flag.
  **→** Personal-only tool. Any other `LOOPBACK_HOST` fails config validation. Clients should
  use `127.0.0.1`, not `localhost`, because Windows may resolve that to `::1`.
- [x] **Auth token.** Required, ≥ 32 chars, no whitespace. Not auto-generated: the startup error
  points to `pnpm run token`. Compared with `timingSafeEqual` over SHA-256 digests.
  **→** An explicit secret is better than one silently written somewhere. Hashing equalizes the
  lengths for the constant-time compare.
- [x] **DNS rebinding.** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, otherwise 403.
  **→** Blocks rebinding attacks from websites in the browser.
- [x] **CORS.** Off. Any `Origin` not in `LOOPBACK_CORS_ORIGINS` gets 403, and no CORS headers
  are sent.
  **→** Browsers can't call it unless explicitly allowed.
- [x] **Tool policy.** Default `--tools ""` (no tools at all). `LOOPBACK_ALLOWED_TOOLS` may
  enable plain tool names; requests can only narrow.
  **→** With no tools, prompt injection has nothing to drive.
- [x] **Permission mode.** `--permission-mode dontAsk` + `--permission-prompts none`.
  **→** Explicit. Anything that would prompt is denied instead of hanging.
- [x] **Isolation from user config.** `--safe-mode --strict-mcp-config --disable-slash-commands`.
  **→** Without them, `-p` loads the user's own hooks, plugins, MCP servers and CLAUDE.md.
  `--bare` would also do this, but it only authenticates with an API key.
- [x] **Prompt injection.** Documented in the threat model. Tool restrictions carry the weight.
  **→** Attachments are data inlined into the prompt and can't widen permissions.
- [x] **Logging privacy.** No prompt/output contents by default (`LOOPBACK_LOG_PROMPTS` for local
  debugging). Credentials always redacted.
  **→** Logs are safe to share when debugging.
- [x] **Rate limiting.** Global token bucket, 30/min, 429 `rate_limited`.
  **→** Cheap insurance against a runaway script draining usage.
- [x] **Container mode.** Skipped in v1.
  **→** Windows-only. No tools + safe mode + temp cwd + env allowlist is the isolation.

## 7. Configuration

- [x] **Source.** Env vars only, validated with Zod. `.env` is loaded by
  `node --env-file-if-exists`.
  **→** No config-file format to maintain. Unknown `LOOPBACK_*` names are rejected, so typos fail.
- [x] **Fail fast.** Invalid config lists every problem and exits 1. Values (the token above all)
  are never echoed.
  **→** No silent defaults for security settings.
- [x] **Documented defaults.** `.env.example` lists every variable, its default and its purpose.

## 8. Error model

- [x] **Shape.** `{ error: { code, message, requestId } }` for every error.
- [x] **Status mapping.** 400 `invalid_request`/`tool_not_allowed`/`model_not_allowed` · 401
  `unauthorized` · 403 `forbidden_host`/`forbidden_origin` · 404/405 · 413
  `payload_too_large` · 415 `unsupported_media_type` · 429
  `queue_full`/`rate_limited`/`usage_limit` · 502
  `cli_failed`/`cli_protocol_error`/`output_too_large`/`cli_incompatible` · 503
  `cli_unavailable`/`cli_not_authenticated`/`queue_timeout`/`shutting_down` · 504 `timeout` · 500
  `internal`.
  **→** One table in `src/errors.ts`, tested exhaustively.
- [x] **CLI error classification.** Result subtype, `api_retry` error category, exit code and
  stderr patterns, with real CLI output captured as fixtures (M4).
- [x] **No leakage.** Only `AppError` messages reach clients. Anything else becomes a generic
  `internal`, and causes are never serialized.

## 9. Observability

- [x] **Structured logging.** pino JSON lines with a request ID on every line.
- [x] **What to log.** Request ID, durations, queue wait, exit code, kill reason, CLI version.
  Never prompt contents.
- [x] **Health vs. readiness.** `/health` = process alive (no auth). `/ready` = CLI found,
  logged in, version OK, queue counters (auth required).
- [x] **Metrics.** Skipped in v1.
  **→** `/ready` exposes active/waiting counts, which is enough for one user.

## 10. Architecture

- [x] **Layers.** routes → service (queue, limits) → `ClaudeBackend` → process runner.
- [x] **Backend interface.** `ClaudeBackend` with `probe()`, `stream()`, `run()`. `CliBackend`
  now, `ApiBackend` (BYOK) later; routes never know which one is active.
- [x] **Dependency injection.** Config, logger, clock, backend and spawner are passed in.
  **→** Every layer is testable alone with fakes.
- [ ] **Compatibility adapters.** Later: an OpenAI-style route as a thin adapter.

## 11. Testing

- [x] **Method: test-first.** Tests are written from the spec before the code, seen failing for the
  right reason, then made green. Assertions are never weakened to pass.
  **→** Tests prove behavior instead of describing whatever the code happens to do.
- [x] **Fake spawner.** Unit tests use injected fakes with scripted chunks, errors and exit codes.
- [x] **Fake claude binary.** `tests/fixtures/fake-claude.mjs`, run via `process.execPath`.
  **→** A `claude` shim on PATH would be a `.cmd` on Windows, which needs a shell.
- [x] **Stream parser tests.** Identical results for every byte split point, including multibyte
  UTF-8.
- [x] **Lifecycle tests.** Timeout and disconnect kill the whole tree (grandchildren checked with
  `tasklist`), and temp dirs are removed.
- [x] **Concurrency tests.** Queue order, full → 429, wait timeout, shutdown drain (fake clock).
- [x] **Security tests.** Missing/wrong token, bad Host/Origin, oversized body, unknown fields,
  attempts to widen tools/models/timeout.
- [x] **Manual e2e script.** `pnpm run e2e` against the real CLI. Never in CI.
- [x] **Coverage.** 85% lines / 80% branches, enforced in CI with `@vitest/coverage-v8`.

## 12. Tooling & DX

- [x] **Node version.** 24, pinned via `.nvmrc` and `engines`.
- [x] **Lint/format.** Biome.
  **→** One tool, fast enough to run on every edit from a hook.
- [x] **Dev/build.** Dev runs `src/index.ts` directly (Node 24 strips TS types natively). Build
  is `tsc -p tsconfig.build.json` with `rewriteRelativeImportExtensions` into `dist/`.
  **→** No tsx/tsup dependency. Both verified in M1.
- [x] **Scripts.** `dev build start token lint format typecheck test check` (+ `e2e` in M10).

## 13. Docs & portfolio polish

- [ ] **README.** What/why, quick start, curl + TS client examples, config table, Mermaid
  lifecycle, limitations, personal-use note on Anthropic's terms (M10).
- [ ] **Threat model.** `docs/threat-model.md` (M10).
- [ ] **Architecture diagram.** Mermaid request lifecycle in the README (M10).
- [x] **Decision records.** This file, updated each milestone.
- [ ] **Known limitations.** Startup latency per request, shared subscription limits, not a
  Messages API (M10).
- [ ] **Benchmarks (optional).** After v1.
- [ ] **Demo (optional).** After v1.
- [x] **License.** MIT (file added in M10).

---

## Decided during implementation

- **M1: Zod 4, pino 10, Hono 4 + @hono/node-server 2.** Current majors at the time of writing.
- **M1: `LOOPBACK_PORT=0` is allowed.** Picks an ephemeral port, which integration tests need.
- **M1: empty env values count as unset.** `.env` files often contain `KEY=` lines.
- **M1 (security review): config keeps only `tokenDigest` (SHA-256), never the plaintext token.**
  Config is passed to every layer; it can't leak a secret it doesn't hold.
- **M1 (security review): token must use the RFC 6750 token68 charset and have ≥ 8 distinct
  characters.** ASCII-only means header bytes and `.env` text always agree; this rejects
  `aaaa…`-style tokens.
- **M1 (security review): `LOOPBACK_TOKEN` and `ANTHROPIC_*` are deleted from `process.env`
  after boot.** Defense in depth on top of the child-env allowlist.
- **M1 (security review): `LOOPBACK_CLAUDE_PATH` must be a drive-letter absolute path whose
  basename is `claude.exe`.** Rejects UNC, `\\?\`, drive-relative, alternate-data-stream and other
  executables. When unset, M5 resolves `claude.exe` from PATH once at boot, so the runner never
  spawns a bare name (Windows would search the temp cwd first).
- **M1 (security review): logger redacts credentials and content keys up to three levels deep;
  `err` is serialized as `{type, message, code}` only.** The cause chain may wrap CLI stderr or
  paths. Log calls should still pass flat, purpose-built objects.
- **M2: middleware order is request id → Host → Origin → CORS → auth → rate limit → JSON body
  guards → routes.** Hostile Hosts/Origins are rejected before auth, CORS preflights never need
  the token, and failed auth never spends rate-limit budget.
- **M2: accepted Hosts are `127.0.0.1` and `localhost` (any port, case-insensitive).** `[::1]`
  isn't accepted because we don't bind IPv6. Node itself answers 400 to HTTP/1.1 requests with no
  Host before the app runs; the app's own check still returns 403 if one gets through.
- **M2: request ids are always server-generated UUIDs.** Client-sent `X-Request-Id` is ignored,
  so nobody can inject text into logs.
- **M2: the access log records path, method, status and duration, never the query string.**
- **M2: bearer scheme is case-insensitive; the token must match the token68 charset exactly**
  (single space, no extra text).
- **M2: `/health` is the only public path, and it is exempt from the rate limit.**
- **M2: CORS headers only exist when `LOOPBACK_CORS_ORIGINS` is set** (via `hono/cors`, exposing
  `X-Request-Id` and `Retry-After`).
- **M2: no 405 responses.** Hono's router isn't method-aware for misses, so a wrong method gets
  404 `not_found`. `method_not_allowed` stays in the error table for later.
- **M2 (security review): unexpected (non-`AppError`) errors are logged with type and code only;
  their message appears only when `LOOPBACK_LOG_PROMPTS` is on.** Messages like `JSON.parse`'s
  quote the request body. Routes parse bodies with `readJsonBody`, which turns malformed JSON into
  400 `invalid_request` and drops the parser message.
- **M2 (security review): the clock is monotonic (`performance.timeOrigin + performance.now()`),
  and rate-limit refill clamps negative elapsed time.** A wall-clock step backwards would
  otherwise drain the bucket and lock the owner out.
- **M2 (security review): body guards apply to any request that has a body, whatever the
  method.**
- **M2 (security review): `X-Request-Id` and the access log survive responses with immutable
  headers (copied into a fresh Response). Non-`Error` throws are wrapped so they still get the
  JSON envelope.** Hono only sends `Error` instances to `onError`.
- **M2 (from M1 review): the Host check validates the raw `Host` header and rejects
  requests that have none.** @hono/node-server builds `c.req.url` from absolute-form targets or
  falls back to the bind hostname, so `c.req.url` can't be trusted for this check. M2 also
  replaces Hono's default `onError`/`notFound`, which write to `console.error` (bypassing
  redaction) and return non-JSON 404s.
