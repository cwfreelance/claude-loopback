import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/backends/cli/env.ts";

const win32 = process.platform === "win32";

const parent = {
  SystemRoot: "C:\\Windows",
  Path: "C:\\Windows\\System32;C:\\Users\\me\\.local\\bin",
  USERPROFILE: "C:\\Users\\me",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  HTTPS_PROXY: "http://proxy:8080",
  CLAUDE_CONFIG_DIR: "C:\\claude-config",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  ANTHROPIC_AUTH_TOKEN: "auth-secret",
  ANTHROPIC_BASE_URL: "https://evil.example",
  LOOPBACK_TOKEN: "loopback-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "gh-secret",
  NODE_OPTIONS: "--require evil.js",
  CLAUDE_CODE_USE_BEDROCK: "1",
};

describe("buildChildEnv", () => {
  const env = buildChildEnv(parent);

  it.runIf(win32)("copies allowlisted variables, matching names case-insensitively", () => {
    expect(env).toMatchObject({
      SystemRoot: "C:\\Windows",
      Path: parent.Path,
      USERPROFILE: parent.USERPROFILE,
      APPDATA: parent.APPDATA,
      LOCALAPPDATA: parent.LOCALAPPDATA,
      TEMP: parent.TEMP,
      HTTPS_PROXY: parent.HTTPS_PROXY,
      CLAUDE_CONFIG_DIR: parent.CLAUDE_CONFIG_DIR,
    });
  });

  it.runIf(!win32)("copies allowlisted variables, matching names exactly", () => {
    const posix = buildChildEnv({
      HOME: "/home/me",
      PATH: "/usr/local/bin:/home/me/.local/bin",
      Path: "/not/a/real/variable",
      TMPDIR: "/tmp/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTPS_PROXY: "http://proxy:8080",
      https_proxy: "http://proxy:8080",
      CLAUDE_CONFIG_DIR: "/home/me/claude-config",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      LOOPBACK_TOKEN: "loopback-secret",
    });
    expect(posix).toMatchObject({
      HOME: "/home/me",
      PATH: "/usr/local/bin:/home/me/.local/bin",
      TMPDIR: "/tmp/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTPS_PROXY: "http://proxy:8080",
      https_proxy: "http://proxy:8080",
      CLAUDE_CONFIG_DIR: "/home/me/claude-config",
    });
    expect(posix).not.toHaveProperty("Path");
    expect(JSON.stringify(posix)).not.toMatch(/secret/);
  });

  it("never passes Anthropic or loopback credentials, or anything not allowlisted", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "LOOPBACK_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "CLAUDE_CODE_USE_BEDROCK",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(env)).not.toMatch(/secret|evil/);
  });

  it("turns off auto-update and non-essential network traffic", () => {
    expect(env).toMatchObject({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it.runIf(win32)("skips variables that are unset", () => {
    expect(buildChildEnv({ SystemRoot: "C:\\Windows", TEMP: undefined })).not.toHaveProperty(
      "TEMP",
    );
  });

  it.runIf(!win32)("skips variables that are unset", () => {
    expect(buildChildEnv({ HOME: "/home/me", TMPDIR: undefined })).not.toHaveProperty("TMPDIR");
  });
});
