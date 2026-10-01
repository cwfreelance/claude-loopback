import { AppError } from "../../errors.ts";
import type { ProcessExit } from "../../process/runner.ts";
import type { RunResult } from "../types.ts";
import type { CliOutcome } from "./stream-parser.ts";

const AUTH_CATEGORIES = new Set(["authentication_failed", "oauth_org_not_allowed"]);
// Commander-style argument errors from the CLI, e.g. "error: unknown option '--x'".
const INCOMPATIBLE = /\berror: (unknown option|unknown command|too many arguments|option )/i;
const NOT_LOGGED_IN = /not logged in|please run \/login/i;
// Categories come from the CLI; only echo ones that look like its fixed identifiers.
const SAFE_CATEGORY = /^[a-z_]{1,40}$/;
const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 3600;
// Epoch seconds stay below this until the year 5138; anything larger must be milliseconds.
const MILLISECONDS_THRESHOLD = 1e11;

/** Seconds until `resetsAt` (epoch seconds or ms), capped at a week; undefined if not in the future. */
function secondsUntil(resetsAt: number | undefined, nowMs: number): number | undefined {
  if (resetsAt === undefined) return undefined;
  const resetsAtSeconds = resetsAt > MILLISECONDS_THRESHOLD ? resetsAt / 1000 : resetsAt;
  const wait = Math.ceil(resetsAtSeconds - nowMs / 1000);
  return Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_RETRY_AFTER_SECONDS) : undefined;
}

/**
 * Success needs every signal to agree. `subtype` alone can't detect errors (a logged-out run
 * reports "success" with is_error), but any disagreeing field vetoes a success.
 */
function isSuccess(result: NonNullable<CliOutcome["result"]>): boolean {
  return (
    !result.isError &&
    result.subtype === "success" &&
    (result.terminalReason === undefined || result.terminalReason === "completed") &&
    result.value.stopReason !== "tool_deferred"
  );
}

const notLoggedIn = () =>
  new AppError(
    "cli_not_authenticated",
    "Claude CLI is not logged in on this machine; run `claude` and /login",
  );

function fromCategory(outcome: CliOutcome, nowMs: number): AppError {
  const category = outcome.errorCategory;
  if (category !== undefined && AUTH_CATEGORIES.has(category)) return notLoggedIn();
  if (category === "rate_limit" || outcome.rateLimit?.status === "rejected") {
    const waitSeconds = secondsUntil(outcome.rateLimit?.resetsAt, nowMs);
    return new AppError(
      "usage_limit",
      "Claude subscription usage limit reached",
      waitSeconds === undefined ? {} : { retryAfterSeconds: waitSeconds },
    );
  }
  const detail = category !== undefined && SAFE_CATEGORY.test(category) ? ` (${category})` : "";
  return new AppError("cli_failed", `Claude run failed${detail}`);
}

/**
 * Turns what the CLI said and how its process ended into a RunResult or an AppError. Messages
 * are fixed strings: CLI result text and stderr never reach clients.
 */
export function classifyOutcome(outcome: CliOutcome, exit: ProcessExit, nowMs: number): RunResult {
  const { result } = outcome;
  if (result !== undefined) {
    if (isSuccess(result)) return result.value;
    throw fromCategory(outcome, nowMs);
  }

  switch (exit.killReason) {
    case "timeout":
      throw new AppError("timeout", "Claude did not finish within the time limit");
    case "output_too_large":
      throw new AppError("output_too_large", "Claude produced more output than allowed");
    case "shutdown":
      throw new AppError("shutting_down", "Server is shutting down");
    case "aborted":
      throw new AppError("cancelled", "Run was cancelled");
  }

  if (outcome.errorCategory !== undefined) throw fromCategory(outcome, nowMs);
  if (INCOMPATIBLE.test(exit.stderrTail)) {
    throw new AppError(
      "cli_incompatible",
      "The installed Claude CLI rejected loopback's arguments; check the CLI version",
    );
  }
  if (NOT_LOGGED_IN.test(exit.stderrTail)) throw notLoggedIn();
  if (exit.code === 0)
    throw new AppError("cli_protocol_error", "Claude CLI exited without a result");
  throw new AppError("cli_failed", `Claude CLI exited with code ${exit.code ?? "unknown"}`);
}
