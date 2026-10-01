import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
}

export function createApp(_deps: AppDeps): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}
