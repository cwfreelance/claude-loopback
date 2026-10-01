import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";

const config = loadConfig({ LOOPBACK_TOKEN: "kV3x9-Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S" });
const logger = createLogger({ level: "silent", logPrompts: false });

describe("GET /health", () => {
  it("reports the process is alive", async () => {
    const response = await createApp({ config, logger }).request("http://127.0.0.1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
