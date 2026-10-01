import { ConfigError, scrubSecrets } from "./config.ts";
import { AppError } from "./errors.ts";
import { type RunningServer, startServer } from "./server.ts";
import { StartupError } from "./startup-error.ts";

// Work from a snapshot, and drop secrets from the live environment before anything can spawn.
const env = { ...process.env };
scrubSecrets(process.env);

// Installed before startup, so Ctrl+C or closing the console during startup also exits cleanly.
// Children and the instance lock die with the process (job object, named pipe).
let server: RunningServer | undefined;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (server === undefined) {
      console.error("loopback: stopped during startup");
      process.exit(1);
    }
    if (stopping) {
      console.error("loopback: forced exit");
      process.exit(1);
    }
    stopping = true;
    console.error("loopback: shutting down (press Ctrl+C again to force)");
    void server.close().then(() => process.exit(0));
  });
}

try {
  server = await startServer({ env });
} catch (error) {
  if (error instanceof ConfigError || error instanceof AppError || error instanceof StartupError) {
    console.error(`loopback: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
