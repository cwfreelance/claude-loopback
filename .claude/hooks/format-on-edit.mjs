// @ts-check
// PostToolUse hook (Edit | Write): formats and lint-fixes the edited file with Biome. Problems
// Biome cannot fix are reported back to Claude via exit code 2.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { text } from "node:stream/consumers";

const input = JSON.parse(await text(process.stdin));
const filePath = input?.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const relative = typeof filePath === "string" ? path.relative(projectDir, filePath) : "";
if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) process.exit(0);

const biome = path.join(projectDir, "node_modules", "@biomejs", "biome", "bin", "biome");
const result = spawnSync(
  process.execPath,
  [
    biome,
    "check",
    "--write",
    "--colors=off",
    "--no-errors-on-unmatched",
    "--files-ignore-unknown=true",
    relative,
  ],
  { cwd: projectDir, encoding: "utf8" },
);

if (result.error) {
  console.error(`format-on-edit: could not run Biome (${result.error.message}); run pnpm install`);
  process.exit(2);
}
if (result.status !== 0) {
  console.error(
    `Biome found problems it could not fix in ${relative}:\n${result.stdout}${result.stderr}`,
  );
  process.exit(2);
}
