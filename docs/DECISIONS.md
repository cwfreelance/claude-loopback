# loopback — Design Decisions & Edge Cases

A checklist of decisions to make and edge cases to handle. Each item has a short note on
the options and a suggested default. Record the final choice and the reason next to each
item; a repo that shows *why* things were decided reads far better than one that only
shows *what* was built.

---

## 1. Scope & non-goals

- [ ] **Who is it for?** Single user, single machine. State this in the README as a non-goal list: not multi-user, not public, not a hosted service.
- [ ] **Is it a Messages API clone?** Suggested: no. It exposes Claude Code's agent behavior, not raw model access. Say so explicitly so nobody expects parity.
- [ ] **Supported OS.** macOS + Linux first. Windows needs different process-kill logic (no POSIX process groups), so either support it deliberately or mark it unsupported.
- [ ] **Supported claude CLI versions.** Headless flags and output formats change. Decide whether to check the CLI version at startup and warn or refuse on unknown versions.

## 2. API design

- [ ] **Schema style.** Own minimal schema (suggested for v1) vs. OpenAI-compatible vs. Anthropic-Messages-shaped. A compatibility layer can come later as a separate adapter.
- [ ] **Versioning.** Prefix routes with `/v1` from day one.
- [ ] **Endpoints.** `POST /v1/prompt`, `POST /v1/prompt/stream`, `GET /health`, `GET /ready`. Decide whether streaming is a separate route or a `stream: true` flag.
- [ ] **Request fields.** Which CLI options to expose: model, max turns, appended system prompt, allowed tools, timeout. Every exposed field widens the attack surface; expose only what you use.
- [ ] **Per-request overrides vs. server config.** Can a request loosen tool restrictions, or only tighten them? Suggested: requests can only narrow what server config allows.
- [ ] **Sessions / multi-turn.** Stateless only (suggested for v1) vs. session IDs mapped to CLI resume. If supported: where session state lives, how long it is kept, how it is cleaned up.
- [ ] **Response shape.** Result text, stop reason, duration, usage/cost fields if the CLI reports them, request ID.
- [ ] **Request size limits.** Max body size and max prompt length; reject early with 413.

## 3. Process management (the core of the project)

- [ ] **Spawn method.** `child_process.spawn` vs. a wrapper like execa. Either way: `shell: false` and an argument array, never string interpolation into a shell.
- [ ] **How the prompt is passed.** stdin (suggested) vs. argv. argv has OS length limits and is visible to other users via `ps`.
- [ ] **Working directory.** Fresh temp dir per request vs. one shared sandbox dir. Decide cleanup timing and what happens if cleanup fails.
- [ ] **Environment.** Allowlist env vars passed to the child (suggested) rather than denylisting. Always exclude `ANTHROPIC_API_KEY` and your own `LOOPBACK_TOKEN`.
- [ ] **Timeouts.** Default and max timeout; whether clients can set their own within that max.
- [ ] **Kill strategy.** SIGTERM, grace period, then SIGKILL. Kill the whole process group (spawn detached, kill `-pid`) so grandchildren started by tools do not survive.
- [ ] **Client disconnect.** Detect aborted requests and kill the child immediately; don't burn usage on answers nobody receives.
- [ ] **Output buffering.** Cap stdout/stderr size for non-streaming requests to avoid memory blowups.
- [ ] **Exit handling.** Map exit codes and stderr to error types; handle the case where the process exits before writing any output.
- [ ] **Startup checks.** CLI not found on PATH, CLI not logged in, wrong version. Fail fast with a clear message at boot, and report it on `/ready`.
- [ ] **Orphan cleanup.** What happens to running children if the server crashes? Consider tracking PIDs and cleaning up on next start.

## 4. Streaming

- [ ] **Line parsing.** stream-json is newline-delimited; chunks can split a line anywhere. Buffer partial lines and only parse complete ones.
- [ ] **Malformed lines.** Skip and log, or fail the stream? Suggested: log and emit an error event if it happens more than once.
- [ ] **Event mapping.** Pass CLI events through raw, or map them to your own SSE event names (`delta`, `tool`, `result`, `error`)? Your own schema decouples clients from CLI changes.
- [ ] **Errors after headers are sent.** You can't change the HTTP status mid-stream, so define an `error` SSE event and always end the stream cleanly.
- [ ] **Heartbeats.** Send periodic SSE comments so proxies and clients don't time out during long tool runs.
- [ ] **Backpressure.** Slow clients: buffer, drop, or pause reading from the child?
- [ ] **Final event.** Always emit a terminal event (result or error) so clients know the stream finished intentionally.

## 5. Concurrency & limits

- [ ] **Max concurrent processes.** Suggested small default (2–3); each process is heavy and shares one subscription.
- [ ] **Queue.** Queue size, max wait time, and what happens when full: 429 or 503 with `Retry-After`.
- [ ] **Subscription usage limits.** Detect the CLI's usage-limit error and map it to 429 with a clear message instead of a generic 500.
- [ ] **Graceful shutdown.** On SIGINT/SIGTERM: stop accepting requests, let in-flight ones finish up to a deadline, then kill the rest and clean up temp dirs.

## 6. Security

- [ ] **Bind address.** 127.0.0.1 only; decide whether to also bind `::1`. Refuse to start on `0.0.0.0` unless an explicit, scary-named flag is set.
- [ ] **Auth token.** Require it; refuse to start without one. Generate one on first run? Compare with a constant-time check.
- [ ] **DNS rebinding.** Validate the `Host` header against `localhost`/`127.0.0.1`. Websites in your browser can otherwise reach localhost servers.
- [ ] **CORS.** Off by default. Browsers should not be able to call it unless you opt in to specific origins.
- [ ] **Tool policy.** Default-deny tools. Decide the safe allowlist (read-only tools?) and whether Bash is ever allowed.
- [ ] **Permission mode.** Choose the CLI permission mode explicitly rather than relying on defaults.
- [ ] **Prompt injection.** Anything the model reads (files, web content) can steer it. Document this in the threat model and let the tool restrictions carry the weight.
- [ ] **Logging privacy.** Don't log prompts or outputs by default; redact tokens everywhere.
- [ ] **Rate limiting.** Even single-user, a runaway script can drain your usage. Per-token request limits are cheap insurance.
- [ ] **Container mode (optional).** A Dockerfile that runs claude in a container gives much stronger isolation than a temp dir.

## 7. Configuration

- [ ] **Source.** Env vars only vs. env + config file. Suggested: env vars, validated with Zod at startup.
- [ ] **Fail fast.** Invalid config stops the server with a readable error, never silent defaults for security settings.
- [ ] **Documented defaults.** `.env.example` with every variable, its default, and what it controls.

## 8. Error model

- [ ] **Shape.** One consistent JSON error: `{ error: { code, message, requestId } }`.
- [ ] **Status mapping.** Write the table down: 400 validation, 401 auth, 403 host check, 413 too large, 429 queue full or usage limit, 503 CLI unavailable, 504 timeout, 500 unknown.
- [ ] **CLI error classification.** Parse known CLI failures (not logged in, usage limit, invalid flag) into specific codes.
- [ ] **No leakage.** Never return stack traces, file paths, or raw stderr to the client.

## 9. Observability

- [ ] **Structured logging.** e.g. pino with JSON output; request ID on every line.
- [ ] **What to log.** Request ID, duration, queue wait, exit code, kill reason. Not prompt contents.
- [ ] **Health vs. readiness.** `/health` = process alive; `/ready` = CLI found, authenticated, queue not saturated.
- [ ] **Metrics (optional).** Active processes, queue depth, request durations, error counts.

## 10. Architecture

- [ ] **Layers.** routes → service (queue, limits) → backend interface → process runner. Each layer testable alone.
- [ ] **Backend interface.** `ClaudeBackend` with `run()` and `stream()`; `CliBackend` now, `ApiBackend` (BYOK) later. Routes should not know which one is active.
- [ ] **Dependency injection.** Pass the spawner and clock in, so tests can fake them.
- [ ] **Compatibility adapters (later).** An OpenAI-style route as a thin adapter over the same service.

## 11. Testing

- [ ] **Fake spawner.** Unit tests with a fake child process that emits scripted chunks, errors, and exit codes.
- [ ] **Fake claude binary.** Integration tests with a small script named `claude` on PATH that mimics stream-json output, delays, and failures.
- [ ] **Stream parser tests.** Feed the same output split at every possible byte boundary; results must be identical.
- [ ] **Lifecycle tests.** Timeout kills the process, disconnect kills the process, grandchildren die too, temp dirs are removed.
- [ ] **Concurrency tests.** Queue ordering, queue full → 429, graceful shutdown drains correctly.
- [ ] **Security tests.** Missing/wrong token, bad Host header, oversized body, request trying to loosen tool policy.
- [ ] **Manual e2e script.** Runs against the real CLI locally; excluded from CI.
- [ ] **Coverage.** Pick a threshold and enforce it in CI.

## 12. Tooling & DX

- [ ] **Node version.** Pin via `.nvmrc` and `engines`.
- [ ] **Lint/format.** ESLint + Prettier vs. Biome (one tool, faster).
- [ ] **Dev/build.** tsx for dev, tsc or tsup for build.
- [ ] **Scripts.** `dev`, `build`, `start`, `test`, `lint`, `typecheck` with consistent names used by CI and CLAUDE.md.

## 13. Docs & portfolio polish

- [ ] **README.** What it is, why localhost-only, quick start, curl + TypeScript client examples, config table, limitations, personal-use note regarding Anthropic's terms.
- [ ] **Threat model.** Short doc: assets, attackers (other local users, malicious websites, injected prompts), mitigations, residual risks.
- [ ] **Architecture diagram.** A Mermaid diagram of the request lifecycle in the README.
- [ ] **Decision records.** Keep this file updated, or split key choices into `docs/adr/` entries.
- [ ] **Known limitations.** Latency overhead per request, shared subscription limits, not a Messages API.
- [ ] **Benchmarks (optional).** Measure spawn overhead and time-to-first-token; a small table makes a strong impression.
- [ ] **Demo.** A short GIF or asciinema recording of a streamed request.
- [ ] **License.** Choose one explicitly.
