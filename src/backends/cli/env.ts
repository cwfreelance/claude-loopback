// What claude.exe needs on Windows: system paths, the user profile (where its login lives),
// temp dirs, proxies, and its own config/Git Bash locations. Nothing else is inherited.
const WINDOWS_ALLOWLIST = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];
// What claude needs on macOS and Linux: the home dir (where its login lives), PATH, the temp
// dir, locale and terminal settings, XDG_* dirs, proxies (both spellings) and its own config dir.
const POSIX_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "TZ",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
const POSIX_PREFIXES = /^(XDG_|LC_)/;
const WIN32 = process.platform === "win32";
const ALLOWED = new Set(
  WIN32 ? WINDOWS_ALLOWLIST.map((name) => name.toUpperCase()) : POSIX_ALLOWLIST,
);
const allowed = (name: string) =>
  WIN32 ? ALLOWED.has(name.toUpperCase()) : ALLOWED.has(name) || POSIX_PREFIXES.test(name);
// Belt and braces: these never pass, even if someone adds them to the allowlist.
const NEVER = /^(ANTHROPIC_|LOOPBACK_)/i;
const FORCED = {
  DISABLE_AUTOUPDATER: "1",
  // Turns off telemetry, error reporting and update checks.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/**
 * The complete environment for the claude CLI, built from an allowlist. Windows variable names
 * are case-insensitive, so matching is too, and the parent's casing is kept. Elsewhere names
 * are case-sensitive and must match exactly.
 */
export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || !allowed(name)) continue;
    env[name] = value;
  }
  return enforceChildEnvPolicy(env);
}

/**
 * The rules every child env obeys, whatever built it: no ANTHROPIC_* or LOOPBACK_* variables, and
 * the forced safety settings win over any other value (in any casing).
 */
export function enforceChildEnvPolicy(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const forced = new Set(Object.keys(FORCED).map((name) => name.toUpperCase()));
  const kept = Object.entries(env).filter(
    ([name]) => !NEVER.test(name) && !forced.has(name.toUpperCase()),
  );
  return { ...Object.fromEntries(kept), ...FORCED };
}
