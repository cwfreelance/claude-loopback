import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.ts";
import { readJsonBody } from "../../src/http/json.ts";
import { buildApp, errorBody, FakeClock, send, TOKEN } from "../helpers/app.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request id", () => {
  it("gives every response, including errors, its own X-Request-Id", async () => {
    const { app } = buildApp();
    const ok = await send(app, "/health");
    const missing = await send(app, "/v1/nope");
    const a = ok.headers.get("x-request-id");
    const b = missing.headers.get("x-request-id");
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it("puts the same id in the error body", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope");
    expect((await errorBody(response)).requestId).toBe(response.headers.get("x-request-id"));
  });

  it("ignores a client-supplied request id", async () => {
    const { app } = buildApp();
    const response = await send(app, "/health", { headers: { "x-request-id": "attacker-chosen" } });
    expect(response.headers.get("x-request-id")).toMatch(UUID);
  });
});

describe("Host check", () => {
  it.each(["127.0.0.1:7337", "127.0.0.1", "localhost:7337", "localhost", "LOCALHOST:7337"])(
    "accepts Host %s",
    async (host) => {
      const { app } = buildApp();
      expect((await send(app, "/health", { host })).status).toBe(200);
    },
  );

  it.each([
    "evil.example",
    "evil.example:7337",
    "127.0.0.1.evil.example",
    "localhost.evil.example:7337",
    "[::1]:7337",
    "0.0.0.0:7337",
    "127.0.0.1:7337@evil.example",
    "127.0.0.1:notaport",
  ])("rejects Host %s", async (host) => {
    const { app } = buildApp();
    const response = await send(app, "/health", { host });
    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("forbidden_host");
  });

  it("rejects a request with no Host header", async () => {
    const { app } = buildApp();
    const response = await send(app, "/health", { host: null });
    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("forbidden_host");
  });

  it("runs before auth", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope", { host: "evil.example", token: null });
    expect(response.status).toBe(403);
  });
});

describe("Origin check", () => {
  it("rejects every Origin when none are configured, without CORS headers", async () => {
    const { app } = buildApp();
    const response = await send(app, "/health", { origin: "http://127.0.0.1:3000" });
    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("forbidden_origin");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects the opaque null origin", async () => {
    const { app } = buildApp({ LOOPBACK_CORS_ORIGINS: "http://127.0.0.1:3000" });
    expect((await send(app, "/health", { origin: "null" })).status).toBe(403);
  });

  it("runs before auth", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope", { origin: "https://evil.example", token: null });
    expect(response.status).toBe(403);
  });

  describe("with an allowed origin", () => {
    const allowed = "http://127.0.0.1:3000";

    it("adds CORS headers for that origin", async () => {
      const { app } = buildApp({ LOOPBACK_CORS_ORIGINS: allowed });
      const response = await send(app, "/health", { origin: allowed });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(allowed);
    });

    it("answers the preflight without requiring a token", async () => {
      const { app } = buildApp({ LOOPBACK_CORS_ORIGINS: allowed });
      const response = await send(app, "/v1/prompt", {
        method: "OPTIONS",
        token: null,
        origin: allowed,
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "authorization",
      );
    });

    it("still rejects other origins", async () => {
      const { app } = buildApp({ LOOPBACK_CORS_ORIGINS: allowed });
      expect((await send(app, "/health", { origin: "http://127.0.0.1:4000" })).status).toBe(403);
    });
  });
});

describe("bearer auth", () => {
  it("leaves /health public", async () => {
    const { app } = buildApp();
    expect((await send(app, "/health", { token: null })).status).toBe(200);
  });

  it("lets a valid token through to routing", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope");
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("accepts the scheme case-insensitively", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope", {
      token: null,
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong token of the same length", `Bearer ${"x".repeat(TOKEN.length)}`],
    ["a wrong token of another length", "Bearer short"],
    ["a token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the token plus extra", `Bearer ${TOKEN}x`],
    ["another scheme", `Basic ${TOKEN}`],
    ["no scheme", TOKEN],
    ["two spaces", `Bearer  ${TOKEN}`],
    ["trailing junk", `Bearer ${TOKEN} extra`],
  ])("rejects %s", async (_name, authorization) => {
    const { app } = buildApp();
    const response = await send(app, "/v1/nope", {
      token: null,
      headers: authorization === undefined ? {} : { authorization },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const body = await errorBody(response);
    expect(body.code).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(TOKEN.slice(0, 10));
  });

  it("protects every non-health path", async () => {
    const { app } = buildApp();
    for (const path of ["/", "/ready", "/v1/prompt", "/health/../v1/prompt", "/HEALTH"]) {
      expect((await send(app, path, { token: null })).status, path).toBe(401);
    }
  });
});

describe("rate limit", () => {
  it("allows the configured number per minute, then 429 with Retry-After", async () => {
    const clock = new FakeClock();
    const { app } = buildApp({ LOOPBACK_RATE_LIMIT_PER_MIN: "2" }, clock);
    expect((await send(app, "/v1/nope")).status).toBe(404);
    expect((await send(app, "/v1/nope")).status).toBe(404);
    const limited = await send(app, "/v1/nope");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect((await errorBody(limited)).code).toBe("rate_limited");
  });

  it("refills over time", async () => {
    const clock = new FakeClock();
    const { app } = buildApp({ LOOPBACK_RATE_LIMIT_PER_MIN: "2" }, clock);
    await send(app, "/v1/nope");
    await send(app, "/v1/nope");
    clock.advance(29_000);
    expect((await send(app, "/v1/nope")).status).toBe(429);
    clock.advance(1_000);
    expect((await send(app, "/v1/nope")).status).toBe(404);
  });

  it("does not let unauthenticated requests use up the budget", async () => {
    const { app } = buildApp({ LOOPBACK_RATE_LIMIT_PER_MIN: "1" });
    for (let i = 0; i < 5; i++) await send(app, "/v1/nope", { token: null });
    const response = await send(app, "/v1/nope");
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("survives the system clock stepping backwards", async () => {
    const clock = new FakeClock();
    const { app } = buildApp({ LOOPBACK_RATE_LIMIT_PER_MIN: "2" }, clock);
    await send(app, "/v1/nope");
    clock.advance(-600_000);
    const response = await send(app, "/v1/nope");
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });

  it("does not limit /health", async () => {
    const { app } = buildApp({ LOOPBACK_RATE_LIMIT_PER_MIN: "1" });
    for (let i = 0; i < 5; i++) expect((await send(app, "/health")).status).toBe(200);
  });
});

describe("request body guards", () => {
  function withProbe(env: Record<string, string> = {}) {
    const built = buildApp(env);
    built.app.post("/v1/probe", async (c) => c.json({ received: await c.req.json() }));
    return built;
  }

  const json = (body: unknown, contentType = "application/json") => ({
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });

  it("passes a small JSON body through", async () => {
    const { app } = withProbe();
    const response = await send(app, "/v1/probe", json({ prompt: "hi" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: { prompt: "hi" } });
  });

  it("accepts a charset parameter", async () => {
    const { app } = withProbe();
    const response = await send(
      app,
      "/v1/probe",
      json({ a: 1 }, "application/json; charset=utf-8"),
    );
    expect(response.status).toBe(200);
  });

  it.each([["text/plain"], ["application/x-www-form-urlencoded"], ["multipart/form-data"]])(
    "rejects POST with %s",
    async (contentType) => {
      const { app } = withProbe();
      const response = await send(app, "/v1/probe", json({ a: 1 }, contentType));
      expect(response.status).toBe(415);
      expect((await errorBody(response)).code).toBe("unsupported_media_type");
    },
  );

  it("rejects POST without a content type", async () => {
    const { app } = withProbe();
    const response = await send(app, "/v1/probe", { method: "POST", body: "{}" });
    expect(response.status).toBe(415);
  });

  it("rejects a declared oversized body with 413", async () => {
    const { app } = withProbe({ LOOPBACK_MAX_BODY_BYTES: "1024" });
    const response = await send(app, "/v1/probe", json({ prompt: "x".repeat(2000) }));
    expect(response.status).toBe(413);
    expect((await errorBody(response)).code).toBe("payload_too_large");
  });

  it("rejects an oversized streamed body with 413", async () => {
    const { app } = withProbe({ LOOPBACK_MAX_BODY_BYTES: "1024" });
    const bytes = new TextEncoder().encode(JSON.stringify({ prompt: "x".repeat(4000) }));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 500) controller.enqueue(bytes.slice(i, i + 500));
        controller.close();
      },
    });
    const response = await send(app, "/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
  });

  it("applies the same checks to bodies on other methods", async () => {
    const { app } = withProbe({ LOOPBACK_MAX_BODY_BYTES: "1024" });
    app.delete("/v1/probe", async (c) => c.json({ length: (await c.req.text()).length }));
    const textBody = await send(app, "/v1/probe", {
      method: "DELETE",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(textBody.status).toBe(415);
    const bigBody = await send(app, "/v1/probe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(2000) }),
    });
    expect(bigBody.status).toBe(413);
  });

  it("turns malformed JSON into 400 invalid_request via readJsonBody", async () => {
    const { app, logs } = buildApp();
    app.post("/v1/parse", async (c) => c.json({ received: await readJsonBody(c) }));
    const response = await send(app, "/v1/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "my bank PIN is 4321",
    });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("invalid_request");
    expect(logs()).not.toContain("4321");
  });

  it("parses valid JSON via readJsonBody", async () => {
    const { app } = buildApp();
    app.post("/v1/parse", async (c) => c.json({ received: await readJsonBody(c) }));
    const response = await send(app, "/v1/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(await response.json()).toEqual({ received: { prompt: "hi" } });
  });

  it("checks auth before the body", async () => {
    const { app } = withProbe({ LOOPBACK_MAX_BODY_BYTES: "1024" });
    const response = await send(app, "/v1/probe", {
      ...json({ prompt: "x".repeat(2000) }, "text/plain"),
      token: null,
    });
    expect(response.status).toBe(401);
  });
});

describe("error handling", () => {
  it("renders unknown routes as JSON 404", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/does-not-exist");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("hides unexpected errors from clients and logs them instead of console.error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, logEntries } = buildApp();
    app.get("/v1/boom", () => {
      throw new Error("ENOENT C:\\Users\\me\\secret");
    });
    const response = await send(app, "/v1/boom");
    expect(response.status).toBe(500);
    const body = await errorBody(response);
    expect(body).toMatchObject({ code: "internal", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(consoleError).not.toHaveBeenCalled();
    const logged = logEntries().find((entry) => entry.level === 50);
    expect(logged).toMatchObject({ requestId: body.requestId });
  });

  it("never logs request content carried in an unexpected error's message", async () => {
    const { app, logs, logEntries } = buildApp();
    app.post("/v1/raw", async (c) => c.json(await c.req.json()));
    const response = await send(app, "/v1/raw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "my bank PIN is 4321",
    });
    expect(response.status).toBe(500);
    expect(logEntries().some((entry) => entry.level === 50)).toBe(true);
    expect(logs()).not.toContain("4321");
  });

  it("renders thrown non-Error values as the standard 500", async () => {
    const { app, logEntries } = buildApp();
    app.get("/v1/odd", () => {
      throw "a plain string";
    });
    const response = await send(app, "/v1/odd");
    expect(response.status).toBe(500);
    const body = await errorBody(response);
    expect(body.code).toBe("internal");
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(logEntries().find((entry) => entry.level === 50)).toMatchObject({
      requestId: body.requestId,
    });
  });

  it("renders AppErrors with their status and Retry-After", async () => {
    const { app } = buildApp();
    app.get("/v1/busy", () => {
      throw new AppError("queue_full", "Queue is full", { retryAfterSeconds: 3 });
    });
    const response = await send(app, "/v1/busy");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await errorBody(response)).toMatchObject({
      code: "queue_full",
      message: "Queue is full",
    });
  });
});

describe("access log", () => {
  it("writes one line per request with id, method, path, status and duration", async () => {
    const { app, logEntries } = buildApp();
    const response = await send(app, "/v1/nope");
    const entry = logEntries().find((line) => line.msg === "request");
    expect(entry).toMatchObject({
      requestId: response.headers.get("x-request-id"),
      method: "GET",
      path: "/v1/nope",
      status: 404,
    });
    expect(typeof entry?.durationMs).toBe("number");
  });

  it("keeps the request id and log line for responses with immutable headers", async () => {
    const { app, logEntries } = buildApp();
    app.get("/v1/away", () => Response.redirect("http://127.0.0.1:7337/health", 302));
    const response = await send(app, "/v1/away");
    expect(response.status).toBe(302);
    expect(response.headers.get("x-request-id")).toMatch(UUID);
    expect(logEntries().find((line) => line.msg === "request")).toMatchObject({ status: 302 });
  });

  it("never logs the token or the query string", async () => {
    const { app, logs, logEntries } = buildApp();
    await send(app, "/v1/nope?key=query-secret");
    await send(app, "/v1/nope", { token: "wrong-token-value" });
    expect(logEntries().filter((line) => line.msg === "request")).toHaveLength(2);
    expect(logs()).not.toContain(TOKEN);
    expect(logs()).not.toContain("query-secret");
    expect(logs()).not.toContain("wrong-token-value");
  });
});
