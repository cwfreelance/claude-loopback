const STATUS = {
  invalid_request: 400,
  tool_not_allowed: 400,
  model_not_allowed: 400,
  unauthorized: 401,
  forbidden_host: 403,
  forbidden_origin: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  queue_full: 429,
  rate_limited: 429,
  usage_limit: 429,
  // nginx's "client closed request": the client went away; only ever seen in logs.
  cancelled: 499,
  cli_failed: 502,
  cli_protocol_error: 502,
  output_too_large: 502,
  cli_incompatible: 502,
  cli_unavailable: 503,
  cli_not_authenticated: 503,
  queue_timeout: 503,
  shutting_down: 503,
  timeout: 504,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;
export type ErrorStatus = (typeof STATUS)[ErrorCode];

export interface AppErrorOptions {
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/** An error whose code and message are safe to show to clients. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface ErrorResponse {
  readonly status: ErrorStatus;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly error: { code: ErrorCode; message: string; requestId: string } };
}

export function errorStatus(code: ErrorCode): ErrorStatus {
  return STATUS[code];
}

/** Renders any thrown value as the client-facing error. Only AppError details are exposed. */
export function toErrorResponse(error: unknown, requestId: string): ErrorResponse {
  const safe =
    error instanceof AppError ? error : new AppError("internal", "Internal server error");
  return {
    status: errorStatus(safe.code),
    headers:
      safe.retryAfterSeconds === undefined
        ? {}
        : { "Retry-After": String(Math.ceil(safe.retryAfterSeconds)) },
    body: { error: { code: safe.code, message: safe.message, requestId } },
  };
}
