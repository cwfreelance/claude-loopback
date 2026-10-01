import type { Context } from "hono";
import { AppError } from "../errors.ts";

/**
 * Parses the request body as JSON. Malformed bodies become 400 invalid_request; the parser's
 * message (which quotes the body) is dropped rather than wrapped, so it can't reach logs.
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("invalid_request", "Request body is not valid JSON");
  }
}
