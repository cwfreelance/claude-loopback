import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const win32 = process.platform === "win32";
const SYSTEM32 = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

export const SID = {
  everyone: "S-1-1-0",
  authenticatedUsers: "S-1-5-11",
  users: "S-1-5-32-545",
  system: "S-1-5-18",
  administrators: "S-1-5-32-544",
} as const;

/**
 * The access rules on a locked-down file. Windows: the current user, SYSTEM, and at most
 * Administrators (Windows adds an explicit entry for it on files created by an elevated
 * administrator, e.g. on CI runners; administrators can take ownership of any file anyway).
 * Never anyone else. Elsewhere: no permission bits for the group or for others, and on macOS no
 * access control entry that allows anything.
 */
export function onlyOwnerAccess(file: string): boolean {
  if (!win32) return (statSync(file).mode & 0o077) === 0 && !aclAllows(file);
  const allowed = new Set([currentUserSid(), SID.system, SID.administrators]);
  const sids = aclSids(file);
  return sids.includes(currentUserSid()) && sids.every((sid) => allowed.has(sid));
}

/** macOS: whether `file` has an access control entry that allows anything (chmod leaves them). */
function aclAllows(file: string): boolean {
  if (process.platform !== "darwin") return false;
  const listing = execFileSync("/bin/ls", ["-lden", realpathSync(file)], { encoding: "utf8" });
  return /^ *\d+: .* allow /m.test(listing);
}

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

/**
 * Gives other accounts access to `dir`, inherited by whatever is created in it. Windows:
 * Authenticated Users Modify, like a folder made at the root of C:\. macOS: everyone read and
 * write, like a shared folder.
 */
export function makeSharedDir(dir: string): void {
  if (process.platform === "darwin") {
    const entry = "group:everyone allow read,write,list,search,file_inherit,directory_inherit";
    execFileSync("/bin/chmod", ["+a", entry, dir]);
    return;
  }
  execFileSync(
    path.win32.join(SYSTEM32, "icacls.exe"),
    [dir, "/grant", `*${SID.authenticatedUsers}:(OI)(CI)M`],
    { windowsHide: true, stdio: "ignore" },
  );
}
