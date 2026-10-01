import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { type Config, ConfigError, loadConfig, scrubSecrets } from "./config.ts";
import { createLogger } from "./logger.ts";

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`loopback: ${error.message}`);
    process.exit(1);
  }
}

const config = readConfig();
scrubSecrets(process.env);
const logger = createLogger({ level: config.logLevel, logPrompts: config.logPrompts });
const app = createApp({ config, logger });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info({ host: config.host, port: (info as AddressInfo).port }, "listening");
});

// Full graceful shutdown (drain, kill children) arrives with the process runner.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  });
}
