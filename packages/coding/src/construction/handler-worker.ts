import { parentPort, workerData } from 'node:worker_threads';

import {
  serializeHandlerWorkerError,
  type HandlerWorkerBootstrap,
  type HandlerWorkerRequest,
} from './handler-worker-protocol.js';

const port = parentPort;
if (!port) throw new Error('Constructed handler Worker requires a parent MessagePort.');

const bootstrap = workerData as HandlerWorkerBootstrap;
const mod = await import(bootstrap.moduleUrl) as { handler?: unknown };
if (typeof mod.handler !== 'function') {
  port.postMessage({
    kind: 'bootstrap_error',
    error: serializeHandlerWorkerError(new Error(
      `Constructed handler '${bootstrap.label}' did not export 'handler' as a function. Expected: 'export async function handler(input, ctx) { ... }'`,
    )),
  });
  port.close();
} else {
  const handler = mod.handler as (
    input: Record<string, unknown>,
    context: unknown,
  ) => Promise<unknown> | unknown;
  const pendingTools = new Map<number, {
    readonly resolve: (value: string) => void;
    readonly reject: (error: Error) => void;
  }>();
  const abortControllers = new Map<number, AbortController>();
  let nextToolCallId = 0;

  port.on('message', async (message: HandlerWorkerRequest) => {
    if (message.kind === 'tool_result') {
      const pending = pendingTools.get(message.callId);
      if (!pending) return;
      pendingTools.delete(message.callId);
      if (message.error) pending.reject(errorFromWire(message.error));
      else pending.resolve(message.result ?? '');
      return;
    }
    if (message.kind === 'abort') {
      abortControllers.get(message.invocationId)?.abort();
      return;
    }
    if (message.kind !== 'invoke') return;
    try {
      const abortController = new AbortController();
      abortControllers.set(message.invocationId, abortController);
      const tools = createToolsProxy(message.invocationId, pendingTools, () => ++nextToolCallId);
      const result = await handler(message.input, Object.freeze({
        ...message.context,
        abortSignal: abortController.signal,
        tools,
      }));
      port.postMessage({
        kind: 'result',
        invocationId: message.invocationId,
        result: typeof result === 'string' ? result : JSON.stringify(result),
      });
    } catch (error: unknown) {
      port.postMessage({
        kind: 'result',
        invocationId: message.invocationId,
        error: serializeHandlerWorkerError(error),
      });
    } finally {
      abortControllers.delete(message.invocationId);
    }
  });
  port.postMessage({ kind: 'ready' });
}

function createToolsProxy(
  invocationId: number,
  pending: Map<number, { readonly resolve: (value: string) => void; readonly reject: (error: Error) => void }>,
  nextCallId: () => number,
): object {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      return (input?: unknown): Promise<string> => {
        const callId = nextCallId();
        return new Promise<string>((resolve, reject) => {
          pending.set(callId, { resolve, reject });
          parentPort?.postMessage({
            kind: 'tool_call',
            invocationId,
            callId,
            toolName: key,
            input,
          });
        });
      };
    },
    set() {
      throw new Error('Constructed handler attempted to mutate ctx.tools');
    },
    getPrototypeOf() {
      return null;
    },
  });
}

function errorFromWire(input: { readonly name: string; readonly message: string; readonly stack?: string }): Error {
  const error = new Error(input.message);
  error.name = input.name;
  if (input.stack) error.stack = input.stack;
  return error;
}
