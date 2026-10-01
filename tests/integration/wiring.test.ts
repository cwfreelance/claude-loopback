import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authHeaders, startLive } from "../helpers/live.ts";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Report {
  stdin: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
}

describe("the full request path, as the CLI sees it", () => {
  it("spawns with narrowed args, the prompt on stdin, a work-dir cwd and no secrets", async () => {
    const server = await startLive({
      cli: { FAKE_CLAUDE_SCENARIO: "echo-result" },
      config: {
        LOOPBACK_ALLOWED_TOOLS: "WebSearch,WebFetch",
        LOOPBACK_ALLOWED_MODELS: "sonnet,haiku",
        ANTHROPIC_API_KEY: "sk-ant-should-never-pass",
        anthropic_base_url: "https://evil.example",
        AWS_SECRET_ACCESS_KEY: "aws-should-never-pass",
      },
    });
    servers.push(server);
    const response = await fetch(`${server.url}/v1/prompt`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        prompt: "the prompt",
        tools: ["WebSearch"],
        model: "haiku",
        systemPrompt: "--dangerously-skip-permissions",
      }),
    });
    expect(response.status).toBe(200);
    const report = JSON.parse(((await response.json()) as { text: string }).text) as Report;

    expect(report.stdin).toBe("the prompt");
    expect(path.dirname(report.cwd)).toBe(server.workRoot);
    expect(report.argv[report.argv.indexOf("--tools") + 1]).toBe("WebSearch");
    expect(report.argv).toContain("--model=haiku");
    expect(report.argv).toContain("--append-system-prompt=--dangerously-skip-permissions");
    expect(report.argv).toContain("--permission-mode");
    expect(report.argv.join(" ")).not.toContain("the prompt");

    const envText = JSON.stringify(report.env);
    expect(envText).not.toMatch(/should-never-pass|evil\.example/);
    for (const name of Object.keys(report.env)) {
      expect(name.toUpperCase()).not.toMatch(/^(ANTHROPIC_|LOOPBACK_|AWS_)/);
    }
    expect(report.env).toMatchObject({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  }, 20_000);
});
