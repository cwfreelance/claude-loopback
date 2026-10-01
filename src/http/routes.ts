import type { Hono } from "hono";
import type { ClaudeBackend, RunResult } from "../backends/types.ts";
import type { PromptService } from "../service/prompt-service.ts";
import { readJsonBody } from "./json.ts";
import type { AppEnv } from "./middleware.ts";
import { parsePromptRequest } from "./schemas.ts";

export interface RouteDeps {
  readonly service: PromptService;
  readonly backend: ClaudeBackend;
}

/** The JSON response for a finished run (and the SSE `result` event). */
export function resultBody(id: string, result: RunResult, queueMs: number) {
  return {
    id,
    text: result.text,
    ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
    model: result.model,
    stopReason: result.stopReason,
    durationMs: result.durationMs,
    queueMs,
    usage: result.usage,
    costUsd: result.costUsd,
  };
}

export function registerRoutes(app: Hono<AppEnv>, { service, backend }: RouteDeps): void {
  app.get("/health", (c) => c.json({ status: "ok" }));

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
}
