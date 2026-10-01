import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "kV3x9-Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function startServer(env: Record<string, string>) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("LOOPBACK_")),
  );
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: ROOT,
    env: { ...inherited, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForListening(server: ReturnType<typeof startServer>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const line of server.stdout().split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { msg?: string; host?: string; port?: number };
      if (entry.msg === "listening") return entry;
    }
    if (server.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start:\n${server.stdout()}\n${server.stderr()}`);
}

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
