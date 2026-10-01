import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const TOKEN = "kV3x9-Qe7Lp2Rw8Zt4Yb6Nc1Md5Hf0Ja2S";

const children: ChildProcess[] = [];

/** Kills every server started by startServer; call from afterEach. */
export function stopServers(): void {
  for (const child of children.splice(0)) child.kill();
}

export type ServerHandle = ReturnType<typeof startServer>;

/** Runs src/index.ts as a real process with only the given LOOPBACK_* variables. */
export function startServer(env: Record<string, string>) {
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

/** Resolves with the "listening" log entry once the server is up. */
export async function waitForListening(server: ServerHandle) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const line of server.stdout().split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { msg?: string; host?: string; port: number };
      if (entry.msg === "listening") return entry;
    }
    if (server.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start:\n${server.stdout()}\n${server.stderr()}`);
}
