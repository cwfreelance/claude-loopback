import type { Hono } from "hono";
import type { ClaudeBackend } from "../backends/types.ts";
import type { PromptService } from "../service/prompt-service.ts";
import { readJsonBody } from "./json.ts";
import type { AppEnv } from "./middleware.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { resultBody } from "./responses.ts";
import { parsePromptRequest } from "./schemas.ts";
import { DEFAULT_HEARTBEAT_MS, streamPrompt } from "./sse.ts";

export interface RouteDeps {
  readonly service: PromptService;
  readonly backend: ClaudeBackend;
  readonly heartbeatMs?: number;
  readonly streamStallMs: number;
}

export function registerRoutes(
  app: Hono<AppEnv>,
  { service, backend, heartbeatMs = DEFAULT_HEARTBEAT_MS, streamStallMs }: RouteDeps,
): void {
  app.get("/health", (c) => c.json({ status: "ok" }));

  const openApi = buildOpenApiDocument();
  app.get("/openapi.json", (c) => c.json(openApi));

  app.get("/ready", async (c) => {
    const status = await backend.probe();
    return c.json(
      {
        ready: status.ready,
        cli: {
          loggedIn: status.loggedIn,
          ...(status.version === undefined ? {} : { version: status.version }),
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        },
        queue: service.status(),
      },
      status.ready ? 200 : 503,
    );
  });

  app.post("/v1/prompt", async (c) => {
    const input = parsePromptRequest(await readJsonBody(c));
    const requestId = c.get("requestId");
    // The request signal aborts when the client disconnects, which kills the CLI run.
    const { result, queueMs } = await service.run(input, { signal: c.req.raw.signal, requestId });
    return c.json(resultBody(requestId, result, queueMs));
  });

  app.post("/v1/prompt/stream", async (c) => {
    const input = parsePromptRequest(await readJsonBody(c));
    return streamPrompt(c, service, input, { heartbeatMs, stallMs: streamStallMs });
  });
}
