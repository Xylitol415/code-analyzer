/** Stable across worker RPC and HTTP boundaries. */
export class MemoryError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 503 = 503) {
    super(message); this.name = 'MemoryError';
  }
}
