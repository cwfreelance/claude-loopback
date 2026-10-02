import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { buildChildEnv } from "./backends/cli/env.ts";
import {
  isSupportedVersion,
  MIN_CLI_VERSION,
  parseVersion,
  resolveClaudePath,
} from "./backends/cli/probe.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { ensureTokenFile } from "./token-file.ts";

export interface SetupOptions {
  /** The settings file to create or fill. */
  readonly file: string;
  /** Its contents when it has to be created (the token line gets filled in). */
  readonly template: string;
  /** How messages name the file, e.g. ".env". */
  readonly label: string;
  /** The command that runs setup again, for "fix this, then run …". */
  readonly rerun: string;
  /** What to do once everything is fine. */
  readonly next: string;
  /** Skip the machine checks (they run claude.exe; tests never do). */
  readonly skipChecks?: boolean;
  /** Warn when the current folder (the project) is outside the user's profile folder. */
  readonly warnOutsideProfile?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly print?: (line: string) => void;
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Long, real, lower-cased form, so 8.3 short names (C:\Users\RUNNER~1) compare equal. */
function canonical(dir: string): string {
  try {
    return realpathSync.native(dir).toLowerCase();
  } catch {
    return path.resolve(dir).toLowerCase();
  }
}

/**
 * Where the installed command keeps its settings: %APPDATA%\claude-loopback\config.env, a
 * per-user folder, else %USERPROFILE%\.claude-loopback\config.env. Only drive-absolute paths
 * count: an empty or relative value would point into the current folder (some other project),
 * and a UNC path to a share others may control. Throws if neither is usable.
 */
export function defaultSettingsFile(env: Readonly<Record<string, string | undefined>>): string {
  const { APPDATA: appData, USERPROFILE: profile } = env;
  if (appData !== undefined && DRIVE_ABSOLUTE.test(appData)) {
    return path.join(appData, "claude-loopback", "config.env");
  }
  if (profile !== undefined && DRIVE_ABSOLUTE.test(profile)) {
    return path.join(profile, ".claude-loopback", "config.env");
  }
  throw new Error(
    "can't find your user folder: set APPDATA (or USERPROFILE) to an absolute path like C:\\Users\\you\\AppData\\Roaming",
  );
}

/**
 * Settings from `file`, overridden by real environment variables (as the server sees them).
 * Windows variable names are case-insensitive, so an override matches in any letter case and
 * LOOPBACK_* names come out upper-case, as config expects.
 */
export function readSettings(
  file: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const settings: Record<string, string | undefined> = { ...parseEnv(readFileSync(file, "utf8")) };
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(settings)) {
      if (existing.toUpperCase() === upper) delete settings[existing];
    }
    settings[upper.startsWith("LOOPBACK_") ? upper : key] = value;
  }
  return settings;
}

/**
 * First-time setup. 1. Makes sure the settings file exists with a usable random token, readable
 * only by the current user; the token is never printed, so it stays out of terminal scrollback
 * and logs. 2. Unless skipped, checks this machine: Node, claude.exe, its version, its login.
 * Prints one line per check and resolves with the number of problems found (0 = ready).
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const { label } = options;
  let problems = 0;
  const ok = (message: string) => print(`  ok    ${message}`);
  const warn = (message: string, fix: string) => print(`  WARN  ${message}\n        → ${fix}`);
  const fail = (message: string, fix: string) => {
    problems++;
    print(`  FIX   ${message}\n        → ${fix}`);
  };
  const finish = () => {
    print(
      problems === 0
        ? `\nReady. Next: ${options.next}`
        : `\n${problems} thing(s) to fix above, then run ${options.rerun} again.`,
    );
    return problems;
  };

  let result: Awaited<ReturnType<typeof ensureTokenFile>>;
  try {
    result = await ensureTokenFile(options.file, options.template);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    fail(`could not write ${label} (${code})`, `close any program that has ${label} open`);
    return finish();
  }
  ok(
    {
      created: `created ${label} with a new random token (not shown; it's in ${label})`,
      filled: `added a new random token to your existing ${label} (not shown)`,
      replaced: `replaced the token in ${label}, which was too weak, with a new random one (not shown)`,
      kept: `${label} already has a token; left it unchanged`,
    }[result.outcome],
  );
  if (result.restricted) ok(`${label} is readable only by your account`);
  else fail(`could not restrict who can read ${label}`, "keep it under your user folder");

  // In a shared folder (like one made at the root of C:\) other accounts may be able to change
  // the code itself, and so run their code as you. Only a warning: the folder may be private.
  const home = options.env.USERPROFILE;
  if (
    options.warnOutsideProfile &&
    home !== undefined &&
    !`${canonical(process.cwd())}${path.sep}`.startsWith(`${canonical(home)}${path.sep}`)
  ) {
    warn(
      "the project is outside your user folder, where other accounts may be able to change it",
      "move it under your user folder, e.g. C:\\Users\\you\\code",
    );
  }

  if (options.skipChecks) return finish();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 24) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old`, "install Node.js 24 or newer");

  // Validate exactly as the server will, so "Ready" means `start` accepts these settings and
  // LOOPBACK_CLAUDE_PATH is a checked absolute path before anything is run.
  let config: Config;
  try {
    config = loadConfig(readSettings(options.file, options.env));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    fail(`${label} has invalid settings: ${error.issues.join("; ")}`, `fix them in ${label}`);
    return finish();
  }
  let claude: string | undefined;
  try {
    claude = await resolveClaudePath(config.claudePath, options.env);
  } catch (error) {
    fail((error as Error).message, "install Claude Code: https://claude.com/claude-code");
  }
  if (claude === undefined) return finish();

  const run = (args: string[]) =>
    execFileSync(claude, args, {
      env: buildChildEnv(options.env),
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  let version: string | undefined;
  try {
    version = parseVersion(run(["--version"]));
  } catch {}
  if (version === undefined) {
    fail(
      `could not run ${claude}`,
      `reinstall Claude Code, or set LOOPBACK_CLAUDE_PATH in ${label}`,
    );
  } else if (!isSupportedVersion(version)) {
    fail(`Claude Code ${version} is older than ${MIN_CLI_VERSION}`, "run `claude update`");
  } else {
    ok(`Claude Code ${version} (${claude})`);
    let loggedIn = false;
    try {
      const status = JSON.parse(run(["auth", "status", "--json"])) as { loggedIn?: unknown };
      loggedIn = status.loggedIn === true;
    } catch {}
    if (loggedIn) ok("Claude Code is logged in");
    else fail("Claude Code is not logged in", "run `claude`, then type /login");
  }
  return finish();
}
