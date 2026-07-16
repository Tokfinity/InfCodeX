export interface HandlerWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type HandlerWorkerRequest =
  | {
      readonly kind: 'invoke';
      readonly invocationId: number;
      readonly input: Record<string, unknown>;
      readonly context: Record<string, unknown>;
    }
  | {
      readonly kind: 'abort';
      readonly invocationId: number;
    }
  | {
      readonly kind: 'tool_result';
      readonly callId: number;
      readonly result?: string;
      readonly error?: HandlerWorkerError;
    };

export type HandlerWorkerResponse =
  | { readonly kind: 'ready' }
  | { readonly kind: 'bootstrap_error'; readonly error: HandlerWorkerError }
  | { readonly kind: 'result'; readonly invocationId: number; readonly result?: string; readonly error?: HandlerWorkerError }
  | { readonly kind: 'tool_call'; readonly invocationId: number; readonly callId: number; readonly toolName: string; readonly input: unknown };

export interface HandlerWorkerBootstrap {
  readonly moduleUrl: string;
  readonly label: string;
}

export function serializeHandlerWorkerError(error: unknown): HandlerWorkerError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    name: normalized.name,
    message: normalized.message,
    ...(normalized.stack !== undefined ? { stack: normalized.stack } : {}),
  };
}
