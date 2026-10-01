import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Clock, systemClock } from "./clock.ts";
import type { Config } from "./config.ts";
import { AppError, toErrorResponse } from "./errors.ts";
import {
  type AppEnv,
  bearerAuth,
  hostCheck,
  jsonBody,
  normalizeThrown,
  originCheck,
  rateLimit,
  requestContext,
} from "./http/middleware.ts";
import type { Logger } from "./logger.ts";

export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock?: Clock;
}

const PUBLIC_PATHS = new Set(["/health"]);

/**
 * Middleware order matters: request id → Host → Origin → CORS (preflights end here) → auth →
 * rate limit → JSON body guards → routes. Hosts and origins are rejected before auth, and failed
 * auth never spends rate-limit budget.
 */
export function createApp({ config, logger, clock = systemClock }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestContext(logger, clock));
  app.use(normalizeThrown);
  app.use(hostCheck);
  app.use(originCheck(config.corsOrigins));
  if (config.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: [...config.corsOrigins],
        allowMethods: ["GET", "POST"],
        allowHeaders: ["Authorization", "Content-Type"],
        exposeHeaders: ["X-Request-Id", "Retry-After"],
        maxAge: 600,
      }),
    );
  }
  const auth = bearerAuth(config.tokenDigest);
  const limit = rateLimit(config.rateLimitPerMin, clock);
  app.use(async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    await auth(c, async () => {
      await limit(c, next);
    });
  });
  app.use(jsonBody(config.maxBodyBytes));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.notFound(() => {
    throw new AppError("not_found", "No such route");
  });
  app.onError((error, c) => {
    const requestId = c.get("requestId");
    if (!(error instanceof AppError)) logger.error({ requestId, err: error }, "unhandled error");
    const { status, headers, body } = toErrorResponse(error, requestId);
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    // 499 (cancelled) isn't in Hono's status union, but any 200-599 status is a valid Response.
    return c.json(body, status as ContentfulStatusCode);
  });

  return app;
}
