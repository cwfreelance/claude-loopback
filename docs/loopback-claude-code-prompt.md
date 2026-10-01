# Project: loopback — local HTTP bridge for Claude Code headless mode

You are planning a new project from an empty repo. DO NOT write application code yet.
Work in phases and stop for my approval at the end of each phase.

## What the app is
`loopback` is a personal, localhost-only HTTP server that accepts prompt requests and runs
them through `claude -p` (headless mode), returning the result as JSON or streaming via SSE.
It is for my own local scripts only — never exposed publicly or shared with others.

Stack: Hono on Node (@hono/node-server), TypeScript (strict), Zod for validation,
Vitest for tests. Propose a package manager and justify it briefly.

Core requirements:
- Bind to 127.0.0.1 only; bearer-token auth via env var (LOOPBACK_TOKEN)
- POST /v1/prompt → JSON response; POST /v1/prompt/stream → SSE
  (use claude's --output-format json / stream-json and parse it)
- Spawn claude in an isolated temp working directory, never the repo or home dir
- Lock down tools by default (--disallowedTools / --allowedTools); allowlist is configurable
- Strip ANTHROPIC_API_KEY from the child process env so it never silently bills an API key
- Per-request timeout, kill the child on client disconnect, global concurrency limit with a queue
- Backend abstraction: `ClaudeBackend` interface with a `CliBackend` now,
  designed so an `ApiBackend` (user's own API key, BYOK) can be added later without changing routes
- Structured error responses; no stack traces leaked
- README: what it is, why localhost-only, threat model, personal-use note re: Anthropic's terms
- Tests must NEVER call the real claude CLI — mock the spawn layer or use a fake binary

Verify all claude CLI flags against `claude --help` for the installed version instead of
relying on memory.

## Phase 1 — Plan the agentic dev setup (plan only, then stop)
Before any app work, design the Claude Code setup for this repo so you perform well here.
Check your current Claude Code docs for exact file locations, settings keys and hook
event names rather than relying on memory. Keep everything minimal: every file must
justify its existence. Propose:

1. CLAUDE.md — concise: project purpose, stack, commands (dev/test/lint/typecheck),
   architecture map, security invariants (localhost-only, no real CLI in tests,
   sandboxed cwd, stripped API key), the commit format and the commit policy below.
2. Rules — path-scoped rules only if they add value beyond CLAUDE.md
   (e.g. rules for src/backends/, rules for tests/).
3. .claude/settings.json — permissions (allow common safe commands, deny destructive ones
   and reading .env files), and disable co-author attribution in commits/PRs.
4. Hooks — e.g. format + lint after file edits, typecheck/test gate before finishing,
   block `git commit` commands whose message violates the commit format.
5. Skills — only if useful (e.g. a commit skill, an "add backend" skill). Justify each.
6. Subagents — only if justified (e.g. a security reviewer for spawn/auth/env handling,
   a test writer). Say explicitly if you think none are needed.
7. CI — one minimal GitHub Actions workflow: install, lint, typecheck, test on push and PR.
   Nothing else. It must pass without claude installed or authenticated.
8. Git — a commit-msg hook (via a lightweight tool or plain script, propose which)
   that enforces the commit format locally.

Output: a file tree of the setup plus 1–2 lines per file on its purpose. Then STOP.

## Phase 2 — Implement the dev setup (after my approval)
Create the approved files. Verify hooks and the commit-msg check actually fire.
Make a single commit for the whole setup. Then STOP.

## Phase 3 — Plan the app (plan only, then stop)
If `docs/DECISIONS.md` exists, use it as a checklist: for each item, state the decision
you recommend and why, and flag the ones that need my input.
Propose: folder structure, module boundaries, request/response schemas,
the spawn/stream/timeout/cancel design, config/env vars, error model,
test strategy, and an ordered list of small implementation milestones where each
milestone is one coherent feature. Flag any risks or open questions.
Then STOP and wait for approval before building.

## Phase 4 — Implement milestone by milestone (after my approval)
Implement one milestone at a time. After each milestone: lint, typecheck and tests must
pass, then make exactly one commit for it and give me a 2–3 line summary. Record any
decision made during implementation in `docs/DECISIONS.md`. Stop and ask if a milestone
turns out to need a design change.

## Commit policy (strict)
- One commit per completed feature or milestone — not per file, not per small edit
- Commit only when lint, typecheck and tests pass; never commit WIP or broken states
- Fold formatting fixes, typo fixes and small follow-ups into the feature's commit
  instead of separate commits
- Do not commit unless a feature is complete or I ask you to

## Commit format (strict)
- Single line only, imperative mood, max 60 characters
- No body, no description, no trailers, no Co-Authored-By lines
- Examples: `add sse streaming endpoint`, `fix child kill on disconnect`
