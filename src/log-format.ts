// Human-readable log lines for the pretty format. Works on entries pino has already redacted and
// serialized, so it can only show what the JSON format would.

/** The colors used; colorette's are a superset, and no-ops when colors are off. */
export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

type Entry = Record<string, unknown>;

// pino bookkeeping; time and level are printed by pino-pretty itself.
const HIDDEN = new Set(["msg", "level", "time", "pid", "hostname"]);

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/**
 * Escapes control characters (ESC, BEL, C1, ...), so a logged value such as a request path can't
 * move the cursor, retitle or clear the terminal.
 */
function clean(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    })
    .join("");
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function shortId(entry: Entry, colors: Palette): string[] {
  const id = entry.requestId;
  return typeof id === "string" ? [colors.dim(`#${clean(id.slice(0, 8))}`)] : [];
}

function statusColor(status: number, colors: Palette): (text: string) => string {
  if (status < 400) return colors.green;
  return status < 500 ? colors.yellow : colors.red;
}

/** A serialized error (see the logger's serializer): `Type(code)` plus the message if kept. */
function errorText(value: Record<string, unknown>): string {
  const code = value.code === undefined ? "" : `(${String(value.code)})`;
  const message = typeof value.message === "string" ? `: ${quote(value.message)}` : "";
  return `${clean(`${String(value.type)}${code}`)}${message}`;
}

/** JSON-quoted; JSON.stringify escapes C0 controls, clean also covers DEL and C1. */
const quote = (text: string) => clean(JSON.stringify(text));

function valueText(key: string, value: unknown): string {
  if (typeof value === "string") return /^[^\s"=]+$/.test(value) ? clean(value) : quote(value);
  if (key === "err" && typeof value === "object" && value !== null && "type" in value) {
    return errorText(value as Record<string, unknown>);
  }
  if (typeof value === "object" && value !== null) return clean(JSON.stringify(value));
  return clean(String(value));
}

function generic(entry: Entry, colors: Palette): string {
  const pairs = Object.entries(entry)
    .filter(([key, value]) => !HIDDEN.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${valueText(key, value)}`);
  const message = clean(String(entry.msg ?? ""));
  return pairs.length === 0 ? message : `${message}  ${colors.dim(pairs.join(" "))}`;
}

function request(entry: Entry, colors: Palette): string | undefined {
  const { method, path, status, durationMs } = entry;
  if (typeof method !== "string" || typeof path !== "string") return undefined;
  if (!isNumber(status) || !isNumber(durationMs)) return undefined;
  return [
    `${colors.bold(clean(method))} ${clean(path)}`,
    statusColor(status, colors)(String(status)),
    duration(durationMs),
    ...shortId(entry, colors),
  ].join("  ");
}

function promptFinished(entry: Entry, colors: Palette): string | undefined {
  const { model, inputTokens, outputTokens, costUsd, durationMs, queueMs } = entry;
  if (typeof model !== "string" || !isNumber(inputTokens) || !isNumber(outputTokens)) {
    return undefined;
  }
  if (!isNumber(costUsd) || !isNumber(durationMs) || !isNumber(queueMs)) return undefined;
  return [
    "prompt finished",
    colors.cyan(clean(model)),
    `in ${inputTokens} · out ${outputTokens} tok`,
    `$${costUsd.toFixed(4)}`,
    duration(durationMs),
    colors.dim(`queued ${duration(queueMs)}`),
    ...shortId(entry, colors),
  ].join("  ");
}

function promptFailed(entry: Entry, colors: Palette): string | undefined {
  const { code, queueMs } = entry;
  if (typeof code !== "string" || !isNumber(queueMs)) return undefined;
  return [
    "prompt failed",
    colors.red(clean(code)),
    colors.dim(`queued ${duration(queueMs)}`),
    ...shortId(entry, colors),
  ].join("  ");
}

const SPECIAL: Record<string, (entry: Entry, colors: Palette) => string | undefined> = {
  request,
  "prompt finished": promptFinished,
  "prompt failed": promptFailed,
};

/** One log entry as a single readable line (without the time and level prefix). */
export function formatLine(entry: Entry, colors: Palette): string {
  const special = typeof entry.msg === "string" ? SPECIAL[entry.msg] : undefined;
  return special?.(entry, colors) ?? generic(entry, colors);
}
