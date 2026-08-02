/** Errors that carry scheduling intent back to the worker. */

/** The work could not proceed now but should be retried at a specific time (rate limits, 503s). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

/** The work can never succeed as specified; retrying wastes attempts. */
export class PermanentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'PermanentError';
  }
}
