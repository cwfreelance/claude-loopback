import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { restrictToCurrentUser } from "./file-acl.ts";

const TOKEN_LINE = /^LOOPBACK_TOKEN=([^\r\n]*)$/m;

/** A new random token: 32 bytes, base64url (43 characters, 256 bits). */
export const newToken = (): string => randomBytes(32).toString("base64url");

export interface TokenFileResult {
  /** created: new file · filled: token was empty · replaced: token was too weak · kept */
  readonly outcome: "created" | "filled" | "replaced" | "kept";
  /** Whether the file is now limited to the current user (and SYSTEM). */
  readonly restricted: boolean;
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
 * through the folder's inherited permissions. If locking down fails, the file is still written.
 */
async function writePrivately(file: string, content: string): Promise<boolean> {
  // `<name>.<random>.local`: for .env that matches .gitignore's `.env.*.local`, so a copy left by
  // a crash between writing and renaming can't be committed by accident.
  const temp = `${file}.${randomBytes(4).toString("hex")}.local`;
  writeFileSync(temp, "", { flag: "wx" });
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
    rmSync(temp, { force: true });
  }
}

/**
 * Makes sure `file` (a settings file) exists with a usable LOOPBACK_TOKEN, creating it from
 * `template` if needed. A missing, empty or too-weak token is replaced with a new random one;
 * a usable one is kept. The token is never returned or printed, so it stays out of terminal
 * scrollback and logs. The file is always (re)written privately.
 */
export async function ensureTokenFile(file: string, template: string): Promise<TokenFileResult> {
  let outcome: TokenFileResult["outcome"];
  let content: string;
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
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
  return { outcome, restricted: await writePrivately(file, content) };
}
