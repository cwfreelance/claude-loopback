import { describe, expect, it } from "vitest";
import { validateCommitMessage } from "../../scripts/commit-format.mjs";

describe("validateCommitMessage", () => {
  it.each([
    "add sse streaming endpoint",
    "fix child kill on disconnect",
    "embed version in health response",
    "add sse streaming endpoint\n",
    "add sse streaming endpoint\r\n\r\n# Please enter the commit message\n# Lines starting with '#'",
    "add x\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x",
    "Merge branch 'feature' into main",
    "a".repeat(60),
  ])("accepts %j", (message) => {
    expect(validateCommitMessage(message)).toEqual([]);
  });

  it.each([
    ["", "message is empty"],
    ["# only a comment\n", "message is empty"],
    ["add x\n\nmore detail", "single line"],
    ["add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "single line"],
    ["a".repeat(61), "at most 60"],
    ["Add sse streaming endpoint", "lowercase"],
    ["add sse streaming endpoint.", "period"],
    [" add x", "whitespace"],
    ["added sse streaming endpoint", "imperative"],
    ["adding sse streaming endpoint", "imperative"],
    ["fixes child kill on disconnect", "imperative"],
  ])("rejects %j", (message, expected) => {
    const errors = validateCommitMessage(message);
    expect(errors.join("\n")).toContain(expected);
  });
});
