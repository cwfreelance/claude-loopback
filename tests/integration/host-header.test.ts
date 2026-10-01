import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, stopServers, TOKEN, waitForListening } from "../helpers/server.ts";

afterEach(stopServers);

interface RawOptions {
  port: number;
  path: string;
  host?: string;
}

interface RawResponse {
  status: number;
  requestId: string | undefined;
}

/** Raw HTTP/1.1 request, so the target and Host header can be anything (or absent). */
function rawGet({ port, path, host }: RawOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        setHost: false,
        headers: host === undefined ? {} : { host },
      },
      (res) => {
        res.resume();
        const requestId = res.headers["x-request-id"];
        resolve({
          status: res.statusCode ?? 0,
          requestId: Array.isArray(requestId) ? requestId[0] : requestId,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Host header on the real server", () => {
  // Node's HTTP parser answers 400 to an HTTP/1.1 request without Host before the app runs;
  // the app's own 403 for this case is covered in tests/unit/http-guards.test.ts.
  it("rejects a request without a Host header before it reaches the app", async () => {
    const { port } = await waitForListening(
      startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_PORT: "0" }),
    );
    const response = await rawGet({ port, path: "/health" });
    expect(response.status).toBe(400);
    expect(response.requestId).toBeUndefined();
  }, 20_000);

  it("rejects a forged Host even with an absolute-form loopback target", async () => {
    const { port } = await waitForListening(
      startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_PORT: "0" }),
    );
    const response = await rawGet({
      port,
      path: `http://127.0.0.1:${port}/health`,
      host: "evil.example",
    });
    expect(response.status).toBe(403);
  }, 20_000);

  it("accepts a normal loopback Host", async () => {
    const { port } = await waitForListening(
      startServer({ LOOPBACK_TOKEN: TOKEN, LOOPBACK_PORT: "0" }),
    );
    const response = await rawGet({ port, path: "/health", host: `127.0.0.1:${port}` });
    expect(response.status).toBe(200);
    expect(response.requestId).toBeDefined();
  }, 20_000);
});
