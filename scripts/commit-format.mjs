// @ts-check
// Commit message rules, shared by the git commit-msg hook and the Claude Code PreToolUse hook.
// Usage as a git hook: node scripts/commit-format.mjs <path-to-commit-msg-file>
import { readFileSync } from "node:fs";

export const MAX_SUBJECT_LENGTH = 60;

const SCISSORS = "# ------------------------ >8 ------------------------";

// Imperative verbs that happen to end in -ed / -ing.
const IMPERATIVE_EXCEPTIONS = new Set([
  "bring",
  "embed",
  "exceed",
  "feed",
  "need",
  "ping",
  "proceed",
  "seed",
  "shed",
  "speed",
  "string",
]);

// Common third-person forms ("adds") that should be imperative ("add").
const THIRD_PERSON = new Set([
  "adds",
  "allows",
  "bumps",
  "changes",
  "cleans",
  "creates",
  "deletes",
  "disables",
  "drops",
  "enables",
  "ensures",
  "fixes",
  "handles",
  "implements",
  "improves",
  "makes",
  "moves",
  "prevents",
  "refactors",
  "removes",
  "renames",
  "replaces",
  "sets",
  "supports",
  "updates",
  "uses",
  "writes",
]);

/**
 * Validates a commit message against the project format.
 * @param {string} raw Full message as git or the user wrote it.
 * @returns {string[]} Human-readable violations; empty when the message is valid.
 */
export function validateCommitMessage(raw) {
  const all = raw.replace(/\r/g, "").split("\n");
  const scissorsAt = all.indexOf(SCISSORS);
  const lines = (scissorsAt === -1 ? all : all.slice(0, scissorsAt)).filter(
    (line) => !line.startsWith("#"),
  );
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();

  const subject = lines[0];
  if (subject === undefined) return ["message is empty"];
  if (subject.startsWith("Merge ")) return [];

  const errors = [];
  if (lines.length > 1) {
    errors.push("must be a single line (no body, no trailers such as Co-Authored-By)");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.push(`must be at most ${MAX_SUBJECT_LENGTH} characters (got ${subject.length})`);
  }
  if (subject !== subject.trim()) errors.push("must not have leading or trailing whitespace");
  if (!/^[a-z]/.test(subject)) errors.push("must start with a lowercase letter");
  if (subject.trimEnd().endsWith(".")) errors.push("must not end with a period");

  const firstWord = subject.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const pastOrProgressive = /(ed|ing)$/.test(firstWord) && !IMPERATIVE_EXCEPTIONS.has(firstWord);
  if (pastOrProgressive || THIRD_PERSON.has(firstWord)) {
    errors.push(`must use imperative mood (e.g. "add", not "${firstWord}")`);
  }
  return errors;
}

/**
 * @param {string[]} errors
 * @returns {string}
 */
export function describeErrors(errors) {
  return [
    "Commit message rejected:",
    ...errors.map((error) => `  - ${error}`),
    'Format: one line, imperative mood, lowercase start, max 60 chars, e.g. "add sse streaming endpoint".',
  ].join("\n");
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/commit-format.mjs <commit-msg-file>");
    process.exit(2);
  }
  const errors = validateCommitMessage(readFileSync(file, "utf8"));
  if (errors.length > 0) {
    console.error(describeErrors(errors));
    process.exit(1);
  }
}
