// Entry point for running from a clone: `pnpm start` / `pnpm dev`, with settings from .env
// (loaded by node --env-file). The npm package's command is src/cli.ts.
import { scrubSecrets } from "./config.ts";
import { runServer } from "./run.ts";

// Work from a snapshot, and drop secrets from the live environment before anything can spawn.
const env = { ...process.env };
scrubSecrets(process.env);
await runServer(env);
