#!/usr/bin/env node
// The `claude-loopback` command installed by npm. Settings live in a per-user file
// (%APPDATA%\claude-loopback\config.env), never in the current folder, so running it inside
// some other project can't pick up that project's .env.
import { existsSync, readFileSync } from "node:fs";
import { styleText } from "node:util";
import { scrubSecrets } from "./config.ts";
import { runServer } from "./run.ts";
import { defaultSettingsFile, readSettings, runSetup } from "./setup.ts";
import { ensureTokenFile } from "./token-file.ts";
import { packageVersion } from "./version.ts";

const MIN_NODE_MAJOR = 24;

const file = (() => {
  try {
    return defaultSettingsFile(process.env);
  } catch (error) {
    return fail((error as Error).message);
  }
})();
const exampleFile = new URL("../.env.example", import.meta.url);

const usage = `Usage: claude-loopback [command]

Commands:
  start    Start the server (the default). Creates your settings on first run.
  setup    Create your settings if needed and check this machine (Node, Claude Code, login)
  token    Print your token, e.g. $env:LOOPBACK_TOKEN = (claude-loopback token)
  config   Print where your settings file is (edit it to change settings)

Options:
  -v, --version   Print the version
  -h, --help      Print this help

Settings: ${file}`;

function fail(message: string): never {
  console.error(styleText("red", `claude-loopback: ${message}`, { stream: process.stderr }));
  process.exit(1);
}

const template = () =>
  existsSync(exampleFile) ? readFileSync(exampleFile, "utf8") : "LOOPBACK_TOKEN=\n";

/**
 * Creates the settings file with a new token if needed, and says so through `notice` (stderr
 * for `token`, whose stdout must be the token alone).
 */
async function ensureSettings(notice: (line: string) => void): Promise<void> {
  const result = await ensureTokenFile(file, template()).catch((error: NodeJS.ErrnoException) =>
    fail(`could not write ${file} (${error.code ?? "error"})`),
  );
  if (result.outcome === "created") {
    notice(`Created your settings with a new random token: ${file}`);
  } else if (result.outcome !== "kept") {
    notice(`Put a new random token in ${file}`);
  }
  if (!result.restricted) {
    console.error(`claude-loopback: warning: could not limit who can read ${file}`);
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  fail(`needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node})`);
}

const [command = "start", ...extra] = process.argv.slice(2);
if (extra.length > 0) fail(`unexpected argument "${extra[0]}"\n\n${usage}`);

switch (command) {
  case "start": {
    await ensureSettings(console.log);
    // Real environment variables override the file. Secrets leave process.env before anything
    // can spawn; the server works from this snapshot.
    const env = readSettings(file, process.env);
    scrubSecrets(process.env);
    await runServer(env, { configFile: file });
    break;
  }
  case "setup": {
    const problems = await runSetup({
      file,
      template: template(),
      label: file,
      rerun: "claude-loopback setup",
      next: "claude-loopback",
      env: process.env,
    });
    process.exit(problems === 0 ? 0 : 1);
    break;
  }
  case "token": {
    await ensureSettings(console.error);
    console.log(readSettings(file, process.env).LOOPBACK_TOKEN ?? "");
    break;
  }
  case "config":
    console.log(file);
    break;
  case "-v":
  case "--version":
    console.log(packageVersion());
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(usage);
    break;
  default:
    fail(`unknown command "${command}"\n\n${usage}`);
}
