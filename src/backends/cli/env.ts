// What claude.exe needs on Windows: system paths, the user profile (where its login lives),
// temp dirs, proxies, and its own config/Git Bash locations. Nothing else is inherited.
const ALLOWLIST = [
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
const ALLOWED = new Set(ALLOWLIST.map((name) => name.toUpperCase()));
// Belt and braces: these never pass, even if someone adds them to the allowlist.
const NEVER = /^(ANTHROPIC_|LOOPBACK_)/i;
const FORCED = {
  DISABLE_AUTOUPDATER: "1",
  // Turns off telemetry, error reporting and update checks.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/**
 * The complete environment for claude.exe, built from an allowlist. Windows variable names are
 * case-insensitive, so matching is too, and the parent's casing is kept.
 */
export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || !ALLOWED.has(name.toUpperCase())) continue;
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
