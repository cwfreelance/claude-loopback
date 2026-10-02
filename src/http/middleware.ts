import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Clock } from "../clock.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";

export interface AppEnv {
  Variables: { requestId: string };
}

type Middleware = MiddlewareHandler<AppEnv>;

/**
 * Assigns a server-generated request id (client-supplied ids are ignored), echoes it in
 * X-Request-Id, and writes one access-log line per request. Logs the path only, never the query.
 */
export function requestContext(logger: Logger, clock: Clock): Middleware {
  return async (c, next) => {
    const requestId = randomUUID();
    const started = clock.now();
    c.set("requestId", requestId);
    await next();
    try {
      c.res.headers.set("X-Request-Id", requestId);
    } catch {
      // Some responses (Response.redirect, fetch results) have immutable headers.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("X-Request-Id", requestId);
    }
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.max(0, clock.now() - started),
      },
      "request",
    );
  };
}

/**
 * Hono only routes Error instances to onError; anything else thrown would escape as a bare 500
 * with no envelope, request id or log. Register right after requestContext.
 */
export const normalizeThrown: Middleware = async (_c, next) => {
  try {
    await next();
  } catch (error) {
    throw error instanceof Error ? error : new Error("Non-Error value thrown", { cause: error });
  }
};

// Raw Host header only: @hono/node-server derives c.req.url from absolute-form targets or the
// bind address, so the URL can't be trusted for this. Blocks DNS-rebinding attacks.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

export const hostCheck: Middleware = async (c, next) => {
  const host = c.req.header("host");
  if (host === undefined || !LOOPBACK_HOST.test(host)) {
    throw new AppError("forbidden_host", "Host header must be 127.0.0.1 or localhost");
  }
  await next();
};

/** Browsers always send Origin on cross-origin requests; only configured origins get through. */
export function originCheck(allowed: readonly string[]): Middleware {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowed.includes(origin)) {
      throw new AppError("forbidden_origin", "Origin is not allowed");
    }
    await next();
  };
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

/**
 * Constant-time bearer check: compares SHA-256 digests, so lengths never leak. Wrong tokens are
 * not rate-limited: tokens are at least 256 bits, so guessing is hopeless, and a lockout would
 * let any local process lock the owner out.
 */
export function bearerAuth(tokenDigest: Buffer): Middleware {
  return async (c, next) => {
    const match = BEARER.exec(c.req.header("authorization") ?? "");
    const candidate = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    if (!match || !timingSafeEqual(candidate, tokenDigest)) {
      c.header("WWW-Authenticate", "Bearer");
      throw new AppError("unauthorized", "Missing or invalid bearer token");
    }
    await next();
  };
}

const MS_PER_MINUTE = 60_000;

/**
 * Global token bucket holding `perMinute` requests. Amounts are kept in "request-milliseconds"
 * so refill math stays in integers.
 */
export function rateLimit(perMinute: number, clock: Clock): Middleware {
  const capacity = perMinute * MS_PER_MINUTE;
  let available = capacity;
  let last = clock.now();
  return async (_c, next) => {
    const now = clock.now();
    // Clamp: a clock stepping backwards must never drain the bucket and lock the owner out.
    available = Math.min(capacity, available + Math.max(0, now - last) * perMinute);
    last = now;
    if (available < MS_PER_MINUTE) {
      const waitMs = (MS_PER_MINUTE - available) / perMinute;
      throw new AppError("rate_limited", "Too many requests", { retryAfterSeconds: waitMs / 1000 });
    }
    available -= MS_PER_MINUTE;
    await next();
  };
}

/** Any request body, whatever the method, must be JSON and at most `maxBytes`. */
export function jsonBody(maxBytes: number): Middleware {
  const limit = bodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw new AppError("payload_too_large", `Request body exceeds ${maxBytes} bytes`);
    },
  });
  return async (c, next) => {
    if (c.req.raw.body === null) return next();
    const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new AppError("unsupported_media_type", "Content-Type must be application/json");
    }
    return limit(c, next);
  };
}
