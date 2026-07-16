import { AsyncLocalStorage } from 'node:async_hooks';

interface ProviderCredentialScope {
  readonly provider: string;
  readonly credential: string;
}

const providerCredentialStorage = new AsyncLocalStorage<ProviderCredentialScope>();

/** Run a provider operation with an in-memory, run-scoped credential override. */
export function runWithProviderCredential<T>(
  provider: string,
  credential: string,
  operation: () => T,
): T {
  if (!provider || !credential) throw new Error('Provider credential scope requires non-empty values.');
  return providerCredentialStorage.run({ provider, credential }, operation);
}

/** Internal provider lookup. The credential is never copied to config or diagnostics. */
export function getScopedProviderCredential(provider: string): string | undefined {
  const scope = providerCredentialStorage.getStore();
  return scope?.provider === provider ? scope.credential : undefined;
}

/**
 * Resolve a provider credential without escaping an active run scope.
 * A mismatched provider deliberately receives no fallback credential.
 */
export function resolveProviderCredential(
  provider: string,
  fallback: string | undefined,
): string | undefined {
  const scope = providerCredentialStorage.getStore();
  if (!scope) return fallback;
  return scope.provider === provider ? scope.credential : undefined;
}

/** Remove the active run credential from DTOs before diagnostics or persistence. */
export function redactScopedProviderCredential<T>(value: T): T {
  const credential = providerCredentialStorage.getStore()?.credential;
  if (!credential) return value;
  return redactCredentialValue(value, credential, new WeakMap()) as T;
}

function redactCredentialValue(
  value: unknown,
  credential: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return value.split(credential).join('[REDACTED_CREDENTIAL]');
  if (value === null || typeof value !== 'object') return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (value instanceof Error) {
    const redacted = new Error(
      redactCredentialValue(value.message, credential, seen) as string,
    );
    seen.set(value, redacted);
    redacted.name = value.name;
    if (value.stack !== undefined) {
      redacted.stack = redactCredentialValue(value.stack, credential, seen) as string;
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    for (const item of value) redacted.push(redactCredentialValue(item, credential, seen));
    return redacted;
  }
  const redacted: Record<string, unknown> = {};
  seen.set(value, redacted);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) continue;
    const safeKey = key.split(credential).join('[REDACTED_CREDENTIAL]');
    redacted[safeKey] = redactCredentialValue(descriptor.value, credential, seen);
  }
  return redacted;
}
