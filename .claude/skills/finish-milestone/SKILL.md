---
name: finish-milestone
description: Close out a completed Phase-4 milestone of loopback — verify, record decisions, security review when needed, make exactly one commit, and summarize. Use when a milestone's feature is complete, never for partial work.
---

# Finish a milestone

Only run this when the milestone's feature is fully implemented. If it turned out to need a
design change, stop and ask the user instead.

1. **Verify.** Run `pnpm run check`. If anything fails, fix it and rerun. Do not continue until
   it passes.
2. **Record decisions.** For every decision made while implementing (library, default value,
   edge-case behavior, deviation from the plan), update the matching item in `docs/DECISIONS.md`:
   tick the box and add the choice plus a one-line reason. Add new items if needed.
3. **Security review.** If the change touches spawning, env handling, auth, host/CORS checks,
   server binding, error responses or logging, run the `security-reviewer` subagent on the diff.
   Fix every confirmed finding, then go back to step 1.
4. **Commit once.** Stage the milestone's files and make exactly one commit:
   - one line, imperative mood, lowercase start, max 60 characters, no trailing period
   - no body, no trailers, no Co-Authored-By
   - e.g. `add sse streaming endpoint`

   If the commit hook rejects the message, fix the message. Never bypass the hook.
5. **Summarize.** Tell the user in 2–3 lines what was built, how it was verified, and anything
   they should know. Then stop and wait for approval before starting the next milestone.
