// @ts-check
// Stop hook: before Claude finishes, run `pnpm check` (lint, typecheck, test) if the working tree
// has uncommitted non-Markdown changes. On failure, exit 2 keeps Claude working on the fix.
import { spawnSync } from "node:child_process";
import { text } from "node:stream/consumers";

const OUTPUT_TAIL_LINES = 60;

const input = JSON.parse(await text(process.stdin));
// Already blocked once this turn: let Claude stop rather than loop forever.
if (input?.stop_hook_active === true) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd,
  encoding: "utf8",
});
if (status.status === 0) {
  const changed = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line
        .slice(3)
        .replace(/^.* -> /, "")
        .replace(/^"|"$/g, ""),
    );
  if (!changed.some((file) => !file.endsWith(".md"))) process.exit(0);
}

// Fixed command string, no user input: shell is needed to resolve pnpm.cmd on Windows.
const check = spawnSync("pnpm run check", {
  cwd,
  encoding: "utf8",
  shell: true,
  env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
});
if (check.status !== 0) {
  const output = `${check.stdout ?? ""}${check.stderr ?? ""}`.trimEnd().split("\n");
  console.error(
    [
      "Quality gate failed: `pnpm check` must pass before you finish. Fix it, or tell the user",
      "why it cannot pass yet. Last lines of output:",
      ...output.slice(-OUTPUT_TAIL_LINES),
    ].join("\n"),
  );
  process.exit(2);
}
