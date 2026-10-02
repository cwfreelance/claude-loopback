// The `prepare` step: points git at .githooks (the commit-message check) for contributors.
// Acts only when this package is the root of its own git checkout. Skipped otherwise: a GitHub
// "Download ZIP", no git installed, or the package extracted or vendored inside someone else's
// repo, whose own hooks must never be switched off. A different hooks path is left alone too.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

// realpath: compares long names, never 8.3 short names or symlinked paths.
const canonical = (/** @type {string} */ dir) =>
  realpathSync.native(path.resolve(dir)).toLowerCase();
const packageRoot = path.resolve(import.meta.dirname, "..");
const git = (/** @type {string[]} */ ...args) =>
  spawnSync("git", args, { cwd: packageRoot, encoding: "utf8", windowsHide: true });

const skip = (/** @type {string} */ why) => {
  console.log(`${why}: skipping commit hooks`);
  process.exit(0);
};

const top = git("rev-parse", "--show-toplevel");
if (top.status !== 0) skip("Not a git checkout");
// Windows paths are case-insensitive; git prints forward slashes.
if (canonical(top.stdout.trim()) !== canonical(packageRoot)) {
  skip("Inside another project's git repo");
}
const current = git("config", "--local", "core.hooksPath").stdout.trim();
if (current !== "" && current !== ".githooks") skip(`core.hooksPath is already ${current}`);

const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: packageRoot,
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
