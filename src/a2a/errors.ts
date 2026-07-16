export class A2AError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus = 200,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'A2AError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
