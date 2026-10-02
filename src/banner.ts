import type { BackendStatus } from "./backends/types.ts";

/** What the startup banner shows. */
export interface BannerInfo {
  readonly version: string;
  readonly url: string;
  readonly cli: BackendStatus;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly maxConcurrency: number;
  readonly queueSize: number;
  /** The settings file in use, if any. */
  readonly configFile?: string;
}

/** node:util styleText's shape; it drops the styling when the stream can't show colors. */
export type Style = (format: string | string[], text: string) => string;

/** The startup banner shown above pretty logs: where the API is and what it will run. */
export function formatBanner(info: BannerInfo, style: Style): string {
  const row = (label: string, value: string) =>
    `  ${style("green", "➜")} ${style("bold", label.padEnd(7))} ${value}`;

  const { cli } = info;
  const version = cli.version === undefined ? "" : `${cli.version} · `;
  const status = cli.ready
    ? style("green", "logged in")
    : style(
        "yellow",
        `${cli.reason ?? "not ready"}${cli.loggedIn ? "" : " (run `claude`, then /login)"}`,
      );
  const models = info.models
    .map((model) => (model === info.defaultModel ? `${model} ${style("dim", "(default)")}` : model))
    .join(", ");

  return [
    "",
    `  ${style(["bold", "cyan"], "claude-loopback")} ${style("dim", info.version)}`,
    "",
    row("API", style("cyan", info.url)),
    row("Docs", style("cyan", `${info.url}/openapi.json`)),
    row("Claude", `${version}${status}`),
    row("Models", models),
    row("Limits", `${info.maxConcurrency} at a time, ${info.queueSize} queued`),
    ...(info.configFile === undefined ? [] : [row("Config", info.configFile)]),
    "",
    `  ${style("dim", "Press Ctrl+C to stop")}`,
    "",
  ].join("\n");
}
