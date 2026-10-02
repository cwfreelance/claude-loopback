import { describe, expect, it } from "vitest";
import { type BannerInfo, formatBanner } from "../../src/banner.ts";

const info: BannerInfo = {
  version: "0.1.0",
  url: "http://127.0.0.1:7337",
  cli: { ready: true, loggedIn: true, version: "2.1.287" },
  models: ["sonnet", "opus", "haiku", "fable"],
  defaultModel: "sonnet",
  maxConcurrency: 2,
  queueSize: 10,
};

const plain = (_format: string | string[], text: string) => text;
const tagged = (format: string | string[], text: string) =>
  `<${[format].flat().join("+")}>${text}</>`;

describe("formatBanner", () => {
  it("shows the version, API and docs URLs, Claude Code status and limits", () => {
    const text = formatBanner(info, plain);
    expect(text).toContain("claude-loopback 0.1.0");
    expect(text).toMatch(/API\s+http:\/\/127\.0\.0\.1:7337\n/);
    expect(text).toMatch(/Docs\s+http:\/\/127\.0\.0\.1:7337\/openapi\.json\n/);
    expect(text).toMatch(/Claude\s+2\.1\.287 · logged in\n/);
    expect(text).toMatch(/Models\s+sonnet \(default\), opus, haiku, fable\n/);
    expect(text).toMatch(/Limits\s+2 at a time, 10 queued\n/);
    expect(text).toContain("Press Ctrl+C to stop");
  });

  it("marks the default model wherever it is in the list", () => {
    expect(formatBanner({ ...info, defaultModel: "opus" }, plain)).toContain(
      "sonnet, opus (default), haiku, fable",
    );
  });

  it("warns, in yellow, with the fix when Claude Code isn't ready", () => {
    const notReady = {
      ...info,
      cli: {
        ready: false,
        loggedIn: false,
        version: "2.1.287",
        reason: "Claude CLI is not logged in",
      },
    };
    expect(formatBanner(notReady, plain)).toMatch(
      /Claude\s+2\.1\.287 · Claude CLI is not logged in \(run `claude`, then \/login\)\n/,
    );
    expect(formatBanner(notReady, tagged)).toContain("<yellow>");
  });

  it("shows the logged-in state in green", () => {
    expect(formatBanner(info, tagged)).toContain("<green>logged in</>");
  });

  it("includes the config file when given", () => {
    const text = formatBanner(
      { ...info, configFile: "C:\\Users\\me\\AppData\\Roaming\\claude-loopback\\config.env" },
      plain,
    );
    expect(text).toMatch(
      /Config\s+C:\\Users\\me\\AppData\\Roaming\\claude-loopback\\config\.env\n/,
    );
    expect(formatBanner(info, plain)).not.toContain("Config");
  });

  it("styles nothing itself, so with styling off there are no escape codes", () => {
    expect(formatBanner(info, plain)).not.toContain("\u001b[");
  });
});
