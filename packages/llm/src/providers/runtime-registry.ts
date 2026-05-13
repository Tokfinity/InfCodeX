import type { KodaXBaseProvider } from './base.js';
import { isProviderName } from './registry.js';
import { isCustomProviderName } from './custom-registry.js';

export type ModelProviderFactory = () => KodaXBaseProvider;

interface RuntimeModelProviderRegistration {
  id: string;
  name: string;
  factory: ModelProviderFactory;
}

const runtimeProviders = new Map<string, RuntimeModelProviderRegistration[]>();
let nextRegistrationId = 0;

function getActiveRuntimeProviderRegistration(
  name: string,
): RuntimeModelProviderRegistration | undefined {
  const registrations = runtimeProviders.get(name);
  if (!registrations || registrations.length === 0) {
    return undefined;
  }
  return registrations[registrations.length - 1];
}

function removeRuntimeProviderRegistration(registrationId: string): void {
  for (const [name, registrations] of runtimeProviders) {
    const next = registrations.filter((registration) => registration.id !== registrationId);
    if (next.length === registrations.length) {
      continue;
    }

    if (next.length === 0) {
      runtimeProviders.delete(name);
    } else {
      runtimeProviders.set(name, next);
    }
    return;
  }
}

export function registerModelProvider(
  name: string,
  factory: ModelProviderFactory,
): () => void {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Model provider name cannot be empty.');
  }

  if (isProviderName(normalizedName)) {
    throw new Error(
      `Runtime model provider "${normalizedName}" conflicts with a built-in provider.`,
    );
  }

  if (isCustomProviderName(normalizedName)) {
    throw new Error(
      `Runtime model provider "${normalizedName}" conflicts with an existing config-defined custom provider.`,
    );
  }

  const registration: RuntimeModelProviderRegistration = {
    id: `runtime-provider:${++nextRegistrationId}`,
    name: normalizedName,
    factory,
  };

  const existing = runtimeProviders.get(normalizedName) ?? [];
  runtimeProviders.set(normalizedName, [...existing, registration]);

  return () => {
    removeRuntimeProviderRegistration(registration.id);
  };
}

export function getRuntimeModelProvider(
  name: string,
): KodaXBaseProvider | undefined {
  const registration = getActiveRuntimeProviderRegistration(name);
  return registration ? registration.factory() : undefined;
}

export function isRuntimeModelProviderName(name: string): boolean {
  return getActiveRuntimeProviderRegistration(name) !== undefined;
}

export function getRuntimeModelProviderNames(): string[] {
  return Array.from(runtimeProviders.keys())
    .filter((name) => getActiveRuntimeProviderRegistration(name) !== undefined);
}

export function clearRuntimeModelProviders(): void {
  runtimeProviders.clear();
}
