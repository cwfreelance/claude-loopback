import { execFileSync } from "node:child_process";
import path from "node:path";

const SYSTEM32 = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

export const SID = {
  everyone: "S-1-1-0",
  authenticatedUsers: "S-1-5-11",
  users: "S-1-5-32-545",
  system: "S-1-5-18",
} as const;

export function currentUserSid(): string {
  const csv = execFileSync(
    path.win32.join(SYSTEM32, "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return /"(S-1-[\d-]+)"/.exec(csv)?.[1] ?? "";
}

function withoutModulePath(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
  );
}

/** The SIDs of every access rule on `file` (SIDs, so the check doesn't depend on the OS language). */
export function aclSids(file: string): string[] {
  const script =
    "(Get-Acl -LiteralPath $env:ACL_FILE).Access | ForEach-Object { " +
    "$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }";
  const output = execFileSync(
    path.win32.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    // PowerShell 7's PSModulePath (inherited from a pwsh terminal) breaks Windows PowerShell.
    { encoding: "utf8", windowsHide: true, env: { ...withoutModulePath(), ACL_FILE: file } },
  );
  return output.split(/\r?\n/).filter(Boolean);
}

/** Adds an explicit (not inherited) Modify entry for `sid` to `file`. */
export function grantExplicitly(file: string, sid: string): void {
  execFileSync(path.win32.join(SYSTEM32, "icacls.exe"), [file, "/grant", `*${sid}:M`], {
    windowsHide: true,
    stdio: "ignore",
  });
}

/** Gives Authenticated Users Modify on `dir` (inherited), like a folder made at the root of C:\. */
export function makeSharedDir(dir: string): void {
  execFileSync(
    path.win32.join(SYSTEM32, "icacls.exe"),
    [dir, "/grant", `*${SID.authenticatedUsers}:(OI)(CI)M`],
    { windowsHide: true, stdio: "ignore" },
  );
}
