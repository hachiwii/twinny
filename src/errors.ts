export class TwinnyError extends Error {
  constructor(
    message: string,
    readonly code = "TWINNY_ERROR",
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "TwinnyError";
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
