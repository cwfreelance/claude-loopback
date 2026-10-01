import { describe, expect, it } from "vitest";
import { checkCommand, splitCommands } from "../../.claude/hooks/check-commit.mjs";

describe("splitCommands", () => {
  it("splits on operators and keeps quoted text intact", () => {
    expect(splitCommands(`git add . && git commit -m "add x; y" | cat`)).toEqual([
      ["git", "add", "."],
      ["git", "commit", "-m", "add x; y"],
      ["cat"],
    ]);
  });

  it("extracts a bash heredoc message", () => {
    const command = `git commit -m "$(cat <<'EOF'\nadd x\nEOF\n)"`;
    expect(splitCommands(command)).toEqual([["git", "commit", "-m", "add x"]]);
  });

  it("extracts a PowerShell here-string message", () => {
    const command = "git commit -m @'\r\nadd x\r\n'@";
    expect(splitCommands(command)).toEqual([["git", "commit", "-m", "add x"]]);
  });

  it("gives up on command substitution it cannot evaluate", () => {
    expect(splitCommands('git commit -m "$(./make-message)"')).toBeNull();
  });
});

describe("checkCommand", () => {
  it.each([
    'git commit -m "add sse streaming endpoint"',
    "git commit -am 'fix child kill on disconnect'",
    `cd repo && git -C . commit -m "add x"`,
    "git commit --message=add-x",
    "git commit -F msg.txt",
    "git commit --amend --no-edit",
    "git status",
    "pnpm test",
    'git commit -m "$(./make-message)"',
  ])("allows %j", (command) => {
    expect(checkCommand(command)).toEqual([]);
  });

  it.each([
    ['git commit -m "Added stuff."', "lowercase"],
    ['git commit -m "add x" -m "body"', "single line"],
    [`git commit -m "$(cat <<'EOF'\nadd x\n\nCo-Authored-By: Claude\nEOF\n)"`, "single line"],
    ['git commit --no-verify -m "add x"', "--no-verify"],
    ['git commit -nm "add x"', "--no-verify"],
    ['git commit -s -m "add x"', "trailers"],
    ['git commit --trailer "Co-Authored-By: x" -m "add x"', "trailers"],
    ['FOO=1 git commit -m "updated readme"', "imperative"],
  ])("denies %j", (command, expected) => {
    expect(checkCommand(command).join("\n")).toContain(expected);
  });
});
