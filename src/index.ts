import { ConfigError, scrubSecrets } from "./config.ts";
import { AppError } from "./errors.ts";
import { startServer } from "./server.ts";

// Work from a snapshot, and drop secrets from the live environment before anything can spawn.
const env = { ...process.env };
scrubSecrets(process.env);

try {
  const server = await startServer({ env });
  // Full graceful shutdown (drain, kill children) arrives with milestone 9.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
} catch (error) {
  if (error instanceof ConfigError || error instanceof AppError) {
    console.error(`loopback: ${error.message}`);
    process.exit(1);
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE" || code === "EACCES") {
    const { address, port } = error as { address?: string; port?: number };
    console.error(`loopback: cannot listen on ${address}:${port} (port in use or reserved)`);
    process.exit(1);
  }
  throw error;
}
