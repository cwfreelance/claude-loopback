import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "../../src/errors.ts";
import { buildOpenApiDocument } from "../../src/http/openapi.ts";
import { promptRequest, promptResponse, readyResponse } from "../../src/http/schemas.ts";
import { buildApp, send } from "../helpers/app.ts";

type Json = Record<string, unknown>;
const doc = buildOpenApiDocument() as Json & {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
};

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with bearer auth", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components).toMatchObject({
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    });
  });

  it("documents every route with the right auth", () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      ["/health", "/openapi.json", "/ready", "/v1/prompt", "/v1/prompt/stream"].sort(),
    );
    expect(doc.paths["/health"]?.get?.security).toEqual([]);
    expect(doc.paths["/openapi.json"]?.get?.security).toEqual([]);
    expect(doc.paths["/ready"]?.get?.security).toBeUndefined(); // inherits the global bearer
    expect(doc.security).toEqual([{ bearer: [] }]);
  });

  it("derives the request schema from the same Zod schema the server validates with", () => {
    const request = doc.components.schemas.PromptRequest as Json & {
      properties: Json;
      required: string[];
    };
    expect(Object.keys(request.properties).sort()).toEqual(Object.keys(promptRequest.shape).sort());
    expect(request.required).toEqual(["prompt"]);
    expect(request.additionalProperties).toBe(false);
  });

  it("lists every error code the server can return", () => {
    const error = doc.components.schemas.Error as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };
    expect([...error.properties.error.properties.code.enum].sort()).toEqual(
      [...ERROR_CODES].sort(),
    );
  });

  it("matches the committed docs/openapi.json", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(doc);
  });
});

describe("GET /openapi.json", () => {
  it("serves the document without a token", async () => {
    const response = await send(buildApp().app, "/openapi.json", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(doc);
  });
});

describe("real responses match the documented schemas", () => {
  it("POST /v1/prompt", async () => {
    const { app } = buildApp();
    const response = await send(app, "/v1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p" }),
    });
    expect(promptResponse.safeParse(await response.json()).success).toBe(true);
  });

  it("GET /ready", async () => {
    const response = await send(buildApp().app, "/ready");
    expect(readyResponse.safeParse(await response.json()).success).toBe(true);
  });

  it("errors", async () => {
    const { app, backend } = buildApp();
    backend.script({ error: new AppError("usage_limit", "limit", { retryAfterSeconds: 1 }) });
    const response = await send(app, "/v1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p" }),
    });
    const body = (await response.json()) as { error: { code: string } };
    expect(ERROR_CODES).toContain(body.error.code);
  });
});
