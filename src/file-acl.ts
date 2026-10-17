import { execFile } from "node:child_process";
import { chmod, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Like kill-tree: helpers run by absolute path, with only SystemRoot in their environment.
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const SYSTEM32 = path.win32.join(SYSTEM_ROOT, "System32");
const HELPER_OPTIONS = { windowsHide: true, env: { SystemRoot: SYSTEM_ROOT }, timeout: 10_000 };
const LOCAL_SYSTEM_SID = "S-1-5-18";
// macOS helpers: also by absolute path, with an empty environment.
const MAC_HELPER_OPTIONS = { env: {}, timeout: 10_000, encoding: "utf8" } as const;
/** An access control entry as `ls -len` prints it: ` 0: <principal uuid> inherited allow read`. */
const ALLOW_ENTRY = /^ *\d+: .* allow /;

async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(
    path.win32.join(SYSTEM32, "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { ...HELPER_OPTIONS, encoding: "utf8" },
  );
  const sid = /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
  if (sid === undefined) throw new Error("could not determine the current user's SID");
  return sid;
}

/**
 * Limits `file` to the current user. Rejects if the file doesn't exist.
 *
 * Windows: the current user and SYSTEM; removes inherited entries, so a file created in a
 * folder every account can write (e.g. one made at the root of C:\) doesn't share its secrets.
 * By SID, so it works in any OS language. Rejects if icacls fails. (A file created by an
 * elevated administrator also keeps an explicit Administrators entry; administrators can take
 * ownership of any file anyway.)
 *
 * Elsewhere: mode 0600 (read and write for the owner only), whatever the umask. macOS: also drops
 * the file's access control entries, which chmod leaves in place and which take precedence over
 * the mode, so a file that inherited entries from its folder doesn't stay readable through them.
 */
export async function restrictToCurrentUser(file: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
    await dropAclEntries(file);
    return;
  }
  const sid = await currentUserSid();
  await execFileAsync(
    path.win32.join(SYSTEM32, "icacls.exe"),
    [path.resolve(file), "/inheritance:r", "/grant:r", `*${sid}:F`, `*${LOCAL_SYSTEM_SID}:F`],
    HELPER_OPTIONS,
  );
}

/**
 * macOS: removes every access control entry of `target`. Rejects if that fails, unless the volume
 * has no ACL support (FAT, some network shares): it refuses the removal as unsupported, and can't
 * hold an entry either. Elsewhere: nothing to do.
 */
export async function dropAclEntries(target: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("/bin/chmod", ["-N", target], MAC_HELPER_OPTIONS);
  } catch (error) {
    // Only chmod's errno tells a volume without ACL support from any other refusal: ls lists no
    // entry in both cases (see aclGrantsAccess). Last line only, so a path can't spoof it.
    const { stderr } = error as { stderr: string };
    if (!/: Operation not supported\n?$/.test(stderr) || (await aclGrantsAccess(target))) {
      throw error;
    }
  }
}

/**
 * Whether an access control entry grants someone access to `target` whatever its mode, or `ls`
 * fails. macOS only, false elsewhere: Linux folds the ACL mask into the group bits, so a mode
 * check covers it there. Principals are listed as UUIDs (`-n`), so no directory lookup can stall,
 * and by the real path: `ls -L` prints a symlink target's mode but the link's own list. `ls`
 * prints no entry when it failed to read the list, just as for an empty one; for a path the
 * caller owns, a volume without ACL support is the only such case, and it enforces none.
 */
export async function aclGrantsAccess(target: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const args = ["-lden", await realpath(target)];
    const { stdout } = await execFileAsync("/bin/ls", args, MAC_HELPER_OPTIONS);
    return stdout.split("\n").some((line) => ALLOW_ENTRY.test(line));
  } catch {
    return true;
  }
}
