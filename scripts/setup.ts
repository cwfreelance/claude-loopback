// First-time setup: `pnpm run setup`.
// 1. Creates .env (from .env.example) with a fresh random LOOPBACK_TOKEN. The token is never
//    printed, so it doesn't end up in terminal scrollback or logs. .env is written so that only
//    the current user can read it, since a folder at the root of C:\ lets every account read and
//    edit it. An existing usable token is kept; an empty or too-weak one is replaced.
// 2. Checks this machine: Node version, claude.exe, its version, and that it is logged in.
// `--skip-checks` does only step 1 (tests use it: they never run the real CLI).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "../src/backends/cli/env.ts";
import {
  isSupportedVersion,
  MIN_CLI_VERSION,
  parseVersion,
  resolveClaudePath,
} from "../src/backends/cli/probe.ts";
import { ensureTokenFile } from "../src/token-file.ts";

const ENV_FILE = ".env";
const EXAMPLE_FILE = ".env.example";

/** A LOOPBACK_* value from .env, which setup reads itself (pnpm doesn't load .env for it). */
function envSetting(name: string): string | undefined {
  const match = new RegExp(`^${name}=([^\\r\\n]*)$`, "m").exec(readFileSync(ENV_FILE, "utf8"));
  return match?.[1]?.trim() || undefined;
}

let problems = 0;
const ok = (message: string) => console.log(`  ok    ${message}`);
const warn = (message: string, fix: string) => console.log(`  WARN  ${message}\n        → ${fix}`);
const fail = (message: string, fix: string) => {
  problems++;
  console.log(`  FIX   ${message}\n        → ${fix}`);
};

const template = existsSync(EXAMPLE_FILE)
  ? readFileSync(EXAMPLE_FILE, "utf8")
  : "LOOPBACK_TOKEN=\n";
const { outcome, restricted } = await ensureTokenFile(ENV_FILE, template).catch(
  (error: NodeJS.ErrnoException) => {
    console.log(
      `  FIX   could not write .env (${error.code ?? "error"})\n        → close any program that has .env open, then run pnpm run setup again`,
    );
    process.exit(1);
  },
);
ok(
  {
    created: "created .env with a new random token (not shown; it's in .env)",
    filled: "added a new random token to your existing .env (not shown)",
    replaced: "replaced the token in .env, which was too weak, with a new random one (not shown)",
    kept: ".env already has a token; left it unchanged",
  }[outcome],
);
if (restricted) ok(".env is readable only by your account");
else fail("could not restrict who can read .env", "keep the project under your user folder");

// Other accounts may be able to change the code itself in a shared folder (like one made at the
// root of C:\), and so run their code as you. A warning, since the folder may still be private.
const home = process.env.USERPROFILE;
const here = path.resolve(process.cwd()).toLowerCase();
if (
  home !== undefined &&
  !(here + path.sep).startsWith(path.resolve(home).toLowerCase() + path.sep)
) {
  warn(
    "the project is outside your user folder, where other accounts may be able to change it",
    "move it under your user folder, e.g. C:\\Users\\you\\code",
  );
}

if (!process.argv.includes("--skip-checks")) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 24) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old`, "install Node.js 24 or newer");

  let claude: string | undefined;
  try {
    claude = await resolveClaudePath(envSetting("LOOPBACK_CLAUDE_PATH"), process.env);
  } catch (error) {
    fail((error as Error).message, "install Claude Code: https://claude.com/claude-code");
  }

  if (claude !== undefined) {
    const run = (args: string[]) =>
      execFileSync(claude as string, args, {
        env: buildChildEnv(process.env),
        cwd: os.tmpdir(),
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    const version = (() => {
      try {
        return parseVersion(run(["--version"]));
      } catch {
        return undefined;
      }
    })();
    if (version === undefined) {
      fail(`could not run ${claude}`, "reinstall Claude Code, or set LOOPBACK_CLAUDE_PATH in .env");
    } else if (!isSupportedVersion(version)) {
      fail(`Claude Code ${version} is older than ${MIN_CLI_VERSION}`, "run `claude update`");
    } else {
      ok(`Claude Code ${version} (${claude})`);
      let loggedIn = false;
      try {
        loggedIn =
          (JSON.parse(run(["auth", "status", "--json"])) as { loggedIn?: unknown }).loggedIn ===
          true;
      } catch {}
      if (loggedIn) ok("Claude Code is logged in");
      else fail("Claude Code is not logged in", "run `claude`, then type /login");
    }
  }
}

console.log(
  problems === 0
    ? "\nReady. Next: pnpm run build, then pnpm start"
    : `\n${problems} thing(s) to fix above, then run pnpm run setup again.`,
);
process.exit(problems === 0 ? 0 : 1);
