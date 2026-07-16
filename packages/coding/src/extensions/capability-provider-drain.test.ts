import { describe, expect, it, vi } from 'vitest';

import type { CapabilityProvider } from './types.js';
import { createExtensionRuntime } from './runtime.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Capability provider replacement', () => {
  it('keeps the previous provider alive until its in-flight call drains', async () => {
    const call = deferred<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[] }>();
    const dispose = vi.fn(async () => undefined);
    const previous: CapabilityProvider = {
      id: 'mcp',
      kinds: ['tool'],
      execute: vi.fn(() => call.promise),
      dispose,
    };
    const next: CapabilityProvider = {
      id: 'mcp',
      kinds: ['tool'],
      async execute() { return { content: [{ type: 'text', text: 'next' }] }; },
    };
    const runtime = createExtensionRuntime();
    runtime.registerCapabilityProvider(previous);

    const executing = runtime.executeCapability('mcp', 'old', {});
    await vi.waitFor(() => expect(previous.execute).toHaveBeenCalledOnce());
    const replacing = runtime.replaceCapabilityProvider('mcp', next);
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();

    call.resolve({ content: [{ type: 'text', text: 'previous' }] });
    await expect(executing).resolves.toEqual({ content: [{ type: 'text', text: 'previous' }] });
    await replacing;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(runtime.executeCapability('mcp', 'new', {}))
      .resolves.toEqual({ content: [{ type: 'text', text: 'next' }] });
    await runtime.dispose();
  });

  it('keeps the replacement active when previous-provider cleanup fails', async () => {
    const previous: CapabilityProvider = {
      id: 'mcp',
      kinds: ['tool'],
      async execute() { return { content: [{ type: 'text', text: 'previous' }] }; },
      async dispose() { throw new Error('token=SECRET123 C:\\private\\provider'); },
    };
    const next: CapabilityProvider = {
      id: 'mcp',
      kinds: ['tool'],
      async execute() { return { content: [{ type: 'text', text: 'next' }] }; },
    };
    const runtime = createExtensionRuntime();
    runtime.registerCapabilityProvider(previous);

    await expect(runtime.replaceCapabilityProvider('mcp', next)).resolves.toBeUndefined();
    await expect(runtime.executeCapability('mcp', 'new', {}))
      .resolves.toEqual({ content: [{ type: 'text', text: 'next' }] });
    const failure = runtime.getDiagnostics().failures.find((item) => item.stage === 'dispose');
    expect(failure).toMatchObject({ target: 'capability-provider:mcp' });
    expect(failure?.message).not.toContain('SECRET123');
    expect(failure?.message).not.toContain('C:\\private');
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});
