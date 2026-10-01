import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, stopServers, TOKEN, waitForListening } from "../helpers/server.ts";

afterEach(stopServers);

describe("server entry point", () => {
  it("serves /health on 127.0.0.1", async () => {
    const server = startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_PORT: "0" });
    const listening = await waitForListening(server);
    expect(listening.host).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${listening.port}/health`);
    expect(await response.json()).toEqual({ status: "ok" });
  }, 20_000);

  it("refuses to start without a token and explains how to make one", async () => {
    const server = startServer({});
    const [code] = await once(server.child, "exit");
    expect(code).toBe(1);
    expect(server.stderr()).toContain("LOOPBACK_TOKEN");
    expect(server.stderr()).toContain("pnpm run token");
    expect(server.stdout()).not.toContain("listening");
  }, 20_000);

  it("refuses to bind a non-loopback host", async () => {
    const server = startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_HOST: "0.0.0.0" });
    const [code] = await once(server.child, "exit");
    expect(code).toBe(1);
    expect(server.stderr()).toContain("LOOPBACK_HOST");
  }, 20_000);
});
