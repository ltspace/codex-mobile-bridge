export class BridgeError extends Error {
  constructor(message, { status = 500, code = "bridge_error", retryable = false, details = null } = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function publicError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const expose = status < 500 || error instanceof BridgeError;
  return {
    status,
    body: {
      error: {
        code: error?.code || "internal_error",
        message: expose ? (error?.message || "Unexpected error") : "Bridge internal error",
        retryable: Boolean(error?.retryable || status >= 500),
        ...(error?.details ? { details: error.details } : {}),
      },
    },
  };
}
