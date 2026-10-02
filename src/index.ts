import { readFileSync } from "node:fs";
import { styleText } from "node:util";
import { formatBanner } from "./banner.ts";
import { ConfigError, scrubSecrets } from "./config.ts";
import { AppError } from "./errors.ts";
import { type RunningServer, startServer } from "./server.ts";
import { StartupError } from "./startup-error.ts";

// Work from a snapshot, and drop secrets from the live environment before anything can spawn.
const env = { ...process.env };
scrubSecrets(process.env);

// styleText drops the styling when the stream isn't a color terminal (or NO_COLOR is set).
const err = (format: Parameters<typeof styleText>[0], text: string) =>
  console.error(styleText(format, `claude-loopback: ${text}`, { stream: process.stderr }));

// Installed before startup, so Ctrl+C or closing the console during startup also exits cleanly.
// The instance lock (named pipe) and direct children (job object) die with the process; deeper
// descendants are killed explicitly on a forced exit or crash.
let server: RunningServer | undefined;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (server === undefined) {
      err("dim", "stopped during startup");
      process.exit(1);
    }
    if (stopping) {
      err("yellow", "forced exit");
      server.forceKill(); // the job object alone doesn't reach grandchildren of non-Node processes
      process.exit(1);
    }
    stopping = true;
    err("dim", "shutting down (press Ctrl+C again to force)");
    void server.close().then(() => process.exit(0));
  });
}

// A crash must not strand claude.exe process trees either.
process.on("uncaughtException", (error) => {
  server?.forceKill();
  err("red", "crashed");
  console.error(error);
  process.exit(1);
});

try {
  server = await startServer({ env });
} catch (error) {
  if (error instanceof ConfigError || error instanceof AppError || error instanceof StartupError) {
    err("red", `✖ ${error.message}`);
    process.exit(1);
  }
  throw error;
}

if (server.pretty) {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(
    formatBanner(
      {
        version,
        url: `http://${server.host}:${server.port}`,
        cli: server.cli,
        models: server.config.allowedModels,
        defaultModel: server.config.defaultModel,
        maxConcurrency: server.config.maxConcurrency,
        queueSize: server.config.queueSize,
      },
      (format, text) => styleText(format as Parameters<typeof styleText>[0], text),
    ),
  );
}
