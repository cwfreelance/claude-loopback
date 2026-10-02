import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Like kill-tree: helpers run by absolute path, with only SystemRoot in their environment.
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const SYSTEM32 = path.win32.join(SYSTEM_ROOT, "System32");
const HELPER_OPTIONS = { windowsHide: true, env: { SystemRoot: SYSTEM_ROOT }, timeout: 10_000 };
const LOCAL_SYSTEM_SID = "S-1-5-18";

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
 * Limits `file` to the current user and SYSTEM: removes inherited entries, so a file created in a
 * folder every account can write (e.g. one made at the root of C:\) doesn't share its secrets.
 * By SID, so it works in any OS language. Rejects if the file doesn't exist or icacls fails.
 */
export async function restrictToCurrentUser(file: string): Promise<void> {
  const sid = await currentUserSid();
  await execFileAsync(
    path.win32.join(SYSTEM32, "icacls.exe"),
    [path.resolve(file), "/inheritance:r", "/grant:r", `*${sid}:F`, `*${LOCAL_SYSTEM_SID}:F`],
    HELPER_OPTIONS,
  );
}
