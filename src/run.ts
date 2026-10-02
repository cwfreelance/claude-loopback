import { styleText } from "node:util";
import { formatBanner } from "./banner.ts";
import { ConfigError } from "./config.ts";
import { AppError } from "./errors.ts";
import { type RunningServer, startServer } from "./server.ts";
import { StartupError } from "./startup-error.ts";
import { packageVersion } from "./version.ts";

type Format = Parameters<typeof styleText>[0];

// styleText drops the styling when the stream isn't a color terminal (or NO_COLOR is set).
const say = (format: Format, text: string) =>
  console.error(styleText(format, `claude-loopback: ${text}`, { stream: process.stderr }));

export interface RunOptions {
  /** The settings file in use, shown in the startup banner. */
  readonly configFile?: string;
}

/**
 * Runs the server as this process's main job until it is stopped: signal and crash handling,
 * startup errors as one readable line (exit code 1), and the startup banner in pretty mode.
 * `env` is the settings snapshot; the caller has already scrubbed secrets from process.env.
 */
export async function runServer(
  env: Record<string, string | undefined>,
  options: RunOptions = {},
): Promise<void> {
  // Installed before startup, so Ctrl+C or closing the console during startup also exits
  // cleanly. The instance lock (named pipe) and direct children (job object) die with the
  // process; deeper descendants are killed explicitly on a forced exit or crash.
  let server: RunningServer | undefined;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (server === undefined) {
        say("dim", "stopped during startup");
        process.exit(1);
      }
      if (stopping) {
        say("yellow", "forced exit");
        server.forceKill(); // the job object alone doesn't reach grandchildren of non-Node processes
        process.exit(1);
      }
      stopping = true;
      say("dim", "shutting down (press Ctrl+C again to force)");
      void server.close().then(() => process.exit(0));
    });
  }

  // A crash must not strand claude.exe process trees either.
  process.on("uncaughtException", (error) => {
    server?.forceKill();
    say("red", "crashed");
    console.error(error);
    process.exit(1);
  });

  try {
    server = await startServer({ env });
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof AppError ||
      error instanceof StartupError
    ) {
      say("red", `✖ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  if (server.pretty) {
    console.log(
      formatBanner(
        {
          version: packageVersion(),
          url: `http://${server.host}:${server.port}`,
          cli: server.cli,
          models: server.config.allowedModels,
          defaultModel: server.config.defaultModel,
          maxConcurrency: server.config.maxConcurrency,
          queueSize: server.config.queueSize,
          ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
        },
        (format, text) => styleText(format as Format, text),
      ),
    );
  }
}
