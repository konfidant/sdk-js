export class KonfidantApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable `error` field of the response body (e.g. `upload_incomplete`), if any. */
  readonly code: string | undefined;
  /** Raw response body (parsed JSON when possible). */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown, code?: string) {
    super(message);
    this.name = 'KonfidantApiError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}
