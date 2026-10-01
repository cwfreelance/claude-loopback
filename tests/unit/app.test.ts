import { describe, expect, it } from "vitest";
import { buildApp, send } from "../helpers/app.ts";

describe("GET /health", () => {
  it("reports the process is alive", async () => {
    const response = await send(buildApp().app, "/health", { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
