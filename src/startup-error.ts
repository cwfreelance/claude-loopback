/** A reason the server can't start, with a message meant for the person starting it. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StartupError";
  }
}
