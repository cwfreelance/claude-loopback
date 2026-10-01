import type { RunResult } from "../backends/types.ts";

/** The JSON response for a finished run (and the SSE `result` event). */
export function resultBody(id: string, result: RunResult, queueMs: number) {
  return {
    id,
    text: result.text,
    ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
    model: result.model,
    stopReason: result.stopReason,
    durationMs: result.durationMs,
    queueMs,
    usage: result.usage,
    costUsd: result.costUsd,
  };
}
