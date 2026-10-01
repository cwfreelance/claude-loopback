# CLI stream fixtures

Real `claude -p --output-format stream-json --verbose --include-partial-messages` output
(Claude Code 2.1.287, --model haiku, loopback's isolation flags), captured on 2026-10-01
and redacted: paths, session/request/message/tool-use ids (values and keys), uuids, thinking
signatures, non-builtin plugins and account usage figures/settings are replaced with fixed values.

| Fixture | Exit code | Scenario |
|---|---|---|
| success.ndjson | 0 | "Reply with exactly the word: pong" |
| schema.ndjson | 0 | --json-schema with an `answer` string field |
| logged-out.ndjson | 1 | empty CLAUDE_CONFIG_DIR (not logged in) |
| bad-flag.stderr.txt | 1 | an unknown flag; stdout is empty |
