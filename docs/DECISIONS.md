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
- [x] **Orphan cleanup.** Rely on the Windows job object; no PID registry. Stale temp dirs are
  swept at boot.
  **→** libuv puts every non-detached child into a kill-on-close job object, so `claude.exe`
  dies with the server even on a hard crash (covered by a crash test). A boot-time reaper would
  mostly hit reused PIDs, possibly the owner's interactive Claude Code session (see M3 below).

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
- [x] **Isolation from user config.** `--safe-mode --restricted --setting-sources "" --strict-mcp-config
  --disable-slash-commands`.
  **→** Without them, `-p` loads the user's own hooks, plugins, MCP servers and CLAUDE.md.
  `--bare` would also do this, but it only authenticates with an API key. Verified on 2.1.287:
  `--safe-mode` alone still loaded a user plugin. `--setting-sources ""` (or `--restricted`)
  removes it, leaving only the CLI's built-in plugins (see M4).
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
  `queue_full`/`rate_limited`/`usage_limit` · 499 `cancelled` (client went away; logs only) · 502
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
- **M3: the runner exposes raw stdout bytes as an async iterable; line splitting belongs to the
  stream parser (M4).** The runner enforces the total stdout cap (20 MB) and keeps the last
  64 KB of stderr as bytes.
- **M3: stdout is read into the runner's own queue, and the pipe is paused at a 1 MB
  high-water mark.** Node discards a pipe's unread data when it closes, so relying on the
  stream's buffer silently lost output for late readers. Pausing keeps real backpressure.
- **M3: output is never cut off while a reader is active.** An unread or abandoned stdout is
  cut off after a 2 s grace period following exit, and the reader then gets an error, never a
  silent truncation. Timeout and abort stay armed until stdio closes, so a straggler holding the
  pipe can't hang a request forever.
- **M3: abandoning stdout (break/return/throw) kills the process tree.** A failed consumer
  doesn't hold a concurrency slot until the timeout.
- **M3: `exit` resolves only after cleanup** (stdio closed, temp dir removed). Callers can
  rely on "no leftovers" once it settles.
- **M3: `kill()` is idempotent, the first reason wins, and it never runs after the process has
  exited.** By then the PID may belong to someone else.
- **M3: `taskkill` runs by absolute `%SystemRoot%\System32` path with an env of only
  `SystemRoot` and a 10 s timeout.** Exit code 128 ("not found") counts as success. Any other
  failure falls back to `child.kill()` through the process handle, never a PID-based kill.
- **M3 (security review): no PID registry or boot-time reaper.** The job object already kills
  children when the server dies, so leftover PIDs would mostly be reused ones. A detached
  descendant that escapes the job is the residual risk; it's noted in the threat model.
- **M3: temp dirs are `req-*` under a work root, and only its direct `req-*` children can ever
  be deleted.** `fs.rm` doesn't follow junctions (verified).
- **M4: parser fixtures are real captures** (Claude Code 2.1.287, haiku), redacted, in
  `tests/fixtures/streams/`: success, `--json-schema`, logged out, and an unknown flag.
- **M4: final CLI flag set** = `-p --output-format stream-json --verbose
  --include-partial-messages --tools "" --permission-mode dontAsk --permission-prompts none
  --no-session-persistence --safe-mode --restricted --setting-sources "" --strict-mcp-config
  --disable-slash-commands`, plus validated `--model`, `--effort`, `--append-system-prompt` and
  `--json-schema`. A real run with exactly these flags authenticated and answered.
- **M4: one stream-json parser serves both endpoints.** Text comes only from top-level
  `text_delta` events (never `thinking_delta`, `signature_delta`, `input_json_delta` or subagent
  text). The final `result` line is validated with Zod.
- **M4: errors are classified from `is_error` plus the error category, never from `subtype`.**
  The real logged-out run reports `subtype: "success"` with `is_error: true`, and the category
  comes from the assistant line's `error` field (`authentication_failed`) or from `api_retry`.
  Auth categories → 503 `cli_not_authenticated`. `rate_limit`, or a `rate_limit_event` with
  status `rejected` → 429 `usage_limit`, with `Retry-After` from `resetsAt`. Everything else →
  502 `cli_failed`.
- **M4: a complete successful `result` beats a late kill reason.** Without a result, the kill
  reason decides (timeout → 504, output cap → 502, shutdown → 503). Then the stderr patterns
  decide (unknown option → `cli_incompatible`, "not logged in" → `cli_not_authenticated`).
- **M4: error messages are fixed strings.** CLI result text and stderr never reach clients;
  only error categories matching `^[a-z_]+$` are echoed.
- **M4 (security review): success requires every signal to agree:** `is_error: false`,
  `subtype: "success"`, `terminal_reason` absent or `"completed"`, and `stop_reason` not
  `"tool_deferred"`. `subtype` can't detect errors, but it can veto a success.
- **M4 (security review): exactly one `result` line per run.** A second one is a protocol error,
  and deltas after the result are dropped.
- **M4 (security review): error categories are sanitized in the parser** (`^[a-z_]{1,40}$`, else
  `"unknown"`). This covers both `retry` events and classification. A normal top-level assistant
  message clears an earlier retry category, so a recovered rate-limit retry can't turn a later,
  unrelated failure into `usage_limit`.
- **M4 (security review): `Retry-After` is finite and capped at 7 days.** A `resetsAt` above
  1e11 is read as milliseconds.
- **M4 (security review): `structured_output` deeper than 256 levels is a protocol error.**
  `JSON.stringify` throws past a few thousand levels, which would otherwise turn a success into a
  500 or break the SSE write.
- **M4 (security review): fixtures also scrub thinking signatures** (they base64-embed a stable
  account-level id) **and message/tool-use ids, including when they appear as object keys.**
- **M5 (from M4 review): the backend checks `exit.killReason` before reporting a parser
  `cli_protocol_error`.** A kill truncates the last line, which mustn't turn a timeout into a 502.
  A missing `structuredOutput` when a schema was requested is `cli_failed`.
- **M5: every optional CLI value uses `--flag=value`** (`--model=`, `--effort=`,
  `--append-system-prompt=`, `--json-schema=`). Free-text values such as a system prompt starting
  with `--` can then never be parsed as a flag. Verified on the real CLI with
  `--append-system-prompt=--dangerously-skip-permissions`: the permission mode stayed `dontAsk`.
  `--tools` keeps its separate (verified) empty-string form.
- **M5: `buildArgs` re-validates model, tools, effort and NUL bytes, and caps the whole command
  line at 30,000 chars** (Windows' limit is 32,767). This is defense in depth on top of request
  validation.
- **M5: the child env also forces `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`**, which turns off
  telemetry, error reporting and update checks. Matching is case-insensitive (`Path` vs `PATH`),
  and `ANTHROPIC_*`/`LOOPBACK_*` are blocked even if added to the allowlist.
- **M5: `claude.exe` is resolved once, from drive-absolute PATH entries only; `.cmd`/`.bat`/`.ps1`
  shims are refused** with a message pointing to `LOOPBACK_CLAUDE_PATH`.
- **M5: `probe()` runs `--version` and `auth status --json` (no usage spent), caches the result
  for 30 s, and reports a reason when not ready:** CLI can't run, unreadable version, too old, or
  not logged in.
- **M5: when a stream is abandoned or fails, the backend closes the parser chain, kills the run
  and waits for cleanup** before its generator finishes.
- **M5 (security review): the tool allowlist is enforced in `buildArgs`, where argv is built.**
  A tool outside `LOOPBACK_ALLOWED_TOOLS` → 400 `tool_not_allowed`. `default`, the CLI's
  all-tools keyword, is refused as a tool name in both config and requests, in any casing.
  Otherwise `tools: ["default"]` would have enabled every built-in tool.
- **M5 (security review): `stream()` only ever throws `AppError`.** Cancellation wins over
  parse errors (a cancelled run is reported as cancelled), and an already-aborted signal fails
  before anything is spawned.
- **M5 (security review): concurrent `probe()` calls share one in-flight probe.** Residual
  risk: the probe's `execFile` timeout kills only the direct process. `--version` and
  `auth status` don't spawn children, so this is accepted.
- **M4: structured output works with `--tools ""`.** The CLI uses an internal
  `StructuredOutput` tool, and the object arrives as `structured_output` on the result line.
- **M6: the queue hands a freed slot directly to the oldest waiter (FIFO).** Waiters are
  removed on timeout (503 `queue_timeout`) or client abort. A full queue → 429 `queue_full` with
  `Retry-After: 5`. `close()` fails waiters and later acquires with 503 `shutting_down`, while
  held slots stay valid so in-flight runs can drain.
- **M6: policy is checked in the service before queueing:** tools ⊆ allowlist (and again in
  `buildArgs`), model ∈ allowlist, `timeoutMs` ≤ max (default from config). An invalid request
  never takes a slot.
- **M6: attachments are inlined ahead of the prompt as `<attachments><file name="…">…</file>`
  blocks.** Names are validated upstream; contents are passed through untouched, as data. The
  inlined prompt must stay under 9 MB (the CLI caps stdin at 10 MB).
- **M6 (security review): the service owns the run loop: `run(input, ctx, { onQueued, onEvent })`
  instead of returning a generator.** A generator dropped without `return()` held its slot forever,
  so two disconnects could lock up the server. Now the slot is released in the service's own
  `finally`, whatever the route does. `onQueued` fires after validation and queueing succeed, so
  the SSE route can still answer 4xx/429 before sending headers.
- **M6 (security review): the service validates everything it relies on:**
  - `timeoutMs` must be an integer from 1000 to the max.
  - Attachment names must be 1-200 printable characters without `" < > &`.
  - Attachment tags carry a random per-request boundary (`<file-<hex> …>`), so file content
    can't close its block and pose as the prompt.
- **M6 (security review): `LOOPBACK_DEFAULT_MODEL` (default: the first allowlisted model) is
  sent when a request names no model.** Otherwise the CLI's own default (possibly outside the
  allowlist) would be used. The default allowlist is reordered to `sonnet,opus,haiku,fable`, so
  the out-of-the-box default is sonnet.
- **M6 (security review): a new `cancelled` code (499) for client cancellations**, in the queue
  and the backend, so logs can tell a disconnect from a CLI failure.
- **M6: one service log line per prompt that passes schema validation** ("prompt finished" /
  "prompt failed" with `code`), including policy and queue rejections. It records request id,
  queue time, model, duration, token counts and cost, never prompt, attachment or output text.
  Schema rejections (400 in the route) are covered by the per-request access log line.
- **M7: the request body is a strict Zod schema** (unknown fields → 400) with caps: prompt
  ≤ 200k chars, ≤ 20 attachments totalling ≤ 2 MB, systemPrompt and jsonSchema ≤ 16 KB each
  (they travel in argv), ≤ 32 tools. Validation errors name the field and the rule, never the
  value.
- **M7: boot wiring lives in `startServer(options)` (`src/server.ts`); `index.ts` is a thin
  shell.** It snapshots `process.env`, scrubs secrets from the live env before anything starts,
  and exits 1 with a readable message on `ConfigError` or a missing `claude.exe`. Tests run
  `startServer` in-process with the fake CLI, so CI never needs Claude installed.
- **M7: the work root defaults to `%LOCALAPPDATA%\loopback\work`** (from the M3 review). Unlike
  `%TEMP%`, it is never shared under a service account.
- **M7: client disconnect is wired through `c.req.raw.signal`.** @hono/node-server aborts it when
  the client goes away; an integration test proves the CLI child dies and the slot is freed.
- **M7 (security review): schema errors never echo client-supplied key names.** Zod's
  `unrecognized_keys` message quotes them (a single request produced a 3 MB message), so it
  becomes a fixed "unknown field".
- **M7 (security review): the work root falls back to the OS temp dir unless `LOCALAPPDATA` is a
  drive-absolute path.** An empty or relative value would have put work dirs inside the repo.
- **M7 (security review): `createCliBackend` enforces the child-env policy itself**
  (`enforceChildEnvPolicy`): no `ANTHROPIC_*`/`LOOPBACK_*`, and the forced safety settings win
  in any casing. It holds whatever env a caller or test seam passes.
- **M7 (security review): `scrubSecrets` matches names case-insensitively**, like Windows.
- **M7 (security review): a busy or reserved port exits 1 with `loopback: cannot listen on …`**
  instead of a stack trace.
- **M7: `/ready` returns 200/503 `{ ready, cli: { loggedIn, version?, reason? }, queue }`** and
  requires the token. `/health` stays public with no detail.
- **M8: SSE headers are sent only once the request holds a queue slot** (the service's
  `onQueued`). Validation, policy and queue errors (400/429/503 with `Retry-After`) stay plain
  JSON responses with a real status. Anything after that is an `error` event with the standard
  `{ code, message, requestId }` body, then the stream ends.
- **M8: SSE events are `start {model}`, `delta {text}`, `retry {attempt, maxRetries, delayMs,
  error}`, then exactly one `result` (same body as the JSON endpoint) or `error`.**
- **M8: backpressure is end to end.** Each event is awaited as it is written, so a slow client
  stalls the service loop, the parser, the runner's pull, and finally the CLI's stdout pipe.
- **M8: the heartbeat is a `: ping` comment every 15 s**, on real timers (it is an I/O
  keepalive, not logic). It is configurable via `createApp({ heartbeatMs })`, for tests only.
- **M8 (security review): each SSE write has a stall deadline (`LOOPBACK_STREAM_STALL_MS`,
  default 30 s).** A client that keeps the connection open but stops reading used to hold its
  queue slot and temp dir until it disconnected. It still lost its CLI at the timeout, but one
  stuck script blocked everyone. Now the stream and run are aborted (`cancelled`), the slot is
  freed and the runner cleans up. Heartbeats are skipped while one is still pending.
- **For M9 (security review): shutdown must abort open SSE streams / close all connections.**
  `server.close()` waits forever on a stalled client.
- **For M9: on shutdown, call `queue.close()` before aborting in-flight requests**, so queued
  clients get `shutting_down` rather than `cancelled`.
- **For M9 (security review): take a single-instance lock before sweeping, and put the work
  root under `%LOCALAPPDATA%\loopback\work` rather than `%TEMP%`.** A second instance's sweep
  would otherwise delete the first instance's active dirs, and `%TEMP%` may be shared under a
  service account.
- **M2 (from M1 review): the Host check validates the raw `Host` header and rejects
  requests that have none.** @hono/node-server builds `c.req.url` from absolute-form targets or
  falls back to the bind hostname, so `c.req.url` can't be trusted for this check. M2 also
  replaces Hono's default `onError`/`notFound`, which write to `console.error` (bypassing
  redaction) and return non-JSON 404s.
