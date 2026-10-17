import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { aclGrantsAccess, dropAclEntries, restrictToCurrentUser } from "./file-acl.ts";

const TOKEN_LINE = /^LOOPBACK_TOKEN=([^\r\n]*)$/m;

/** A new random token: 32 bytes, base64url (43 characters, 256 bits). */
export const newToken = (): string => randomBytes(32).toString("base64url");

export interface TokenFileResult {
  /** created: new file · filled: token was empty · replaced: token was too weak · kept */
  readonly outcome: "created" | "filled" | "replaced" | "kept";
  /**
   * Whether the file is now limited to the current user (and SYSTEM). On macOS and Linux this
   * also requires the folder holding it to be enterable by the current user alone.
   */
  readonly restricted: boolean;
}

/**
 * Whether only the current user can enter the folder holding `file`: owned by them, with no
 * permission bits for the group or others and (macOS) no access control entry letting anyone in.
 * Windows: always true (the file's own access rules cut inherited access off).
 */
async function privateDir(file: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  const dir = path.dirname(file);
  const stat = statSync(dir);
  return (
    stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && !(await aclGrantsAccess(dir))
  );
}

function withToken(text: string): string {
  const line = `LOOPBACK_TOKEN=${newToken()}`;
  if (TOKEN_LINE.test(text)) return text.replace(TOKEN_LINE, () => line);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

function isUsable(token: string): boolean {
  try {
    loadConfig({ LOOPBACK_TOKEN: token });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `content` to `file` so that only the current user can ever read it: an empty file is
 * created and locked down first, then filled, then renamed over `file`. That also drops any
 * access other accounts had to the old file, and the secret is never readable, even briefly,
 * through the folder's inherited permissions. If locking down fails, the file is still written,
 * except (macOS) when the folder's entries can't be dropped from the scratch folder: nothing is
 * written then, since the file would carry them from the start.
 */
async function writePrivately(file: string, content: string): Promise<boolean> {
  // `<name>.<random>.local`: for .env that matches .gitignore's `.env.*.local`, so a copy left by
  // a crash between writing and renaming can't be committed by accident.
  const scratch = `${file}.${randomBytes(4).toString("hex")}.local`;
  // macOS: the entries a folder hands down apply from the moment a file exists in it, so the file
  // is made inside a scratch folder stripped of them first. Search is checked on every lookup, so
  // a descriptor another account got on that folder before the strip is no use afterwards.
  const staged = process.platform === "darwin";
  const temp = staged ? path.join(scratch, path.basename(file)) : scratch;
  if (staged) {
    mkdirSync(scratch, { mode: 0o700 });
    try {
      await dropAclEntries(scratch);
    } catch (error) {
      // A file made in a folder that kept its entries would carry them, so none is made.
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  // Mode 0600 from the start, so nothing can open it in the moment before it is locked down.
  writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
  try {
    let restricted = true;
    try {
      await restrictToCurrentUser(temp);
    } catch {
      restricted = false;
    }
    writeFileSync(temp, content);
    renameSync(temp, file);
    return restricted;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Makes sure `file` (a settings file) exists with a usable LOOPBACK_TOKEN, creating it from
 * `template` if needed. A missing, empty or too-weak token is replaced with a new random one;
 * a usable one is kept. The token is never returned or printed, so it stays out of terminal
 * scrollback and logs. The file is always (re)written privately, and a folder created for it
 * is private too (mode 0700; Windows ignores the mode).
 */
export async function ensureTokenFile(file: string, template: string): Promise<TokenFileResult> {
  let outcome: TokenFileResult["outcome"];
  let content: string;
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    outcome = "created";
    content = withToken(template);
  } else {
    const current = readFileSync(file, "utf8");
    // Node's env-file parser strips matching quotes, so the server sees the token without them.
    const token = (TOKEN_LINE.exec(current)?.[1]?.trim() ?? "").replace(/^(["'])(.*)\1$/, "$2");
    if (token === "") outcome = "filled";
    else outcome = isUsable(token) ? "kept" : "replaced";
    content = outcome === "kept" ? current : withToken(current);
  }
  const restricted = (await writePrivately(file, content)) && (await privateDir(file));
  return { outcome, restricted };
}
