# loopback

A personal, localhost-only HTTP server that runs prompts through `claude -p` (Claude Code
headless mode) and returns JSON or streams SSE. Only for the owner's local scripts. Never
public, never multi-user, not a Messages API clone.

## Status & workflow
- Work proceeds in phases from `docs/loopback-claude-code-prompt.md`. Stop for approval at the
  end of every phase and every milestone.
- `docs/DECISIONS.md` is the decision log. Record each decision with a one-line reason.
- **Platform: Windows only in v1.** macOS/Linux come later, so keep OS-specific code behind a
  small seam.

## Stack
Node 24 · TypeScript (strict) · Hono + @hono/node-server · Zod · Vitest · Biome · pnpm

## Commands
- `pnpm run check`: lint + typecheck + test (the gate; must pass before any commit)
- `pnpm run lint` / `pnpm run format`: Biome check / Biome check --write
- `pnpm run typecheck`: `tsc --noEmit` (also type-checks the `.mjs` hook scripts)
- `pnpm run test`: Vitest, run once
- `dev` / `build` / `start` are added with the app (Phase 4)

## Architecture
Layers (finalized in Phase 3): routes → service (queue, limits) → `ClaudeBackend` interface →
process runner. `CliBackend` now, `ApiBackend` (BYOK) later; routes never know which one is
active. Inject the spawner and clock so every layer is testable alone.

Dev tooling: `.claude/hooks/` (format on edit, commit-message check, stop gate),
`scripts/commit-format.mjs` (commit rules, shared with `.githooks/commit-msg`).

## Security invariants (never break these)
- Bind to 127.0.0.1 only. A bearer token (`LOOPBACK_TOKEN`) is required, and the server refuses
  to start without one.
- Spawn `claude` with `shell: false` in a fresh temp dir per request, never the repo or the home dir.
- Child env comes from an allowlist and never contains `ANTHROPIC_API_KEY` or `LOOPBACK_TOKEN`.
- Tools are default-deny. Requests may only narrow the server allowlist.
- No stack traces, paths or raw stderr in responses. No prompt/output contents in logs.
- Tests never call the real `claude` CLI. Use a fake spawner or a fake binary.
- Check CLI flags against `claude --help` for the installed version, not memory.

## Commit policy (strict)
- One commit per completed feature or milestone, not per file or small edit.
- Commit only when `pnpm run check` passes. Never commit WIP or broken states.
- Fold formatting fixes, typo fixes and small follow-ups into the feature's commit.
- Don't commit unless a feature is complete or the user asks.
- Never bypass hooks (`--no-verify`, `-n`).

## Commit format (strict, enforced by hooks)
- Single line only, imperative mood, lowercase start, max 60 characters, no trailing period.
- No body, no description, no trailers, no Co-Authored-By lines.
- Examples: `add sse streaming endpoint`, `fix child kill on disconnect`
