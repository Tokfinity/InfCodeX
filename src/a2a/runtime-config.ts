import {
  emitKodaXDiagnostic,
  type AgentCredentialBroker,
  type ExternalAgentRegistration,
} from '@kodax-ai/agent';
import {
  IntegrationConfigController,
  type IntegrationConfigStatus,
} from '@kodax-ai/repl';

import type { KodaXRuntime, RuntimeExternalAgentsOptions } from '../sdk-runtime.js';
import { createA2AAgentExecutorFactory, discoverA2ARegistration } from './client-executor.js';
import {
  parseA2AIntegrationDocument,
  readA2AIntegration,
  type A2AIntegrationDocument,
  type A2AOutboundAgentConfig,
} from './config.js';
import { A2A_EXECUTOR_ID, type A2ANetworkPolicy } from './types.js';

export interface ConfiguredA2ARuntimeHandle {
  readonly status: () => IntegrationConfigStatus;
  reload(): Promise<void>;
  close(): void;
}

export interface ConfiguredA2ARuntimeIntegration {
  readonly runtimeOptions: RuntimeExternalAgentsOptions;
  start(runtime: KodaXRuntime): Promise<ConfiguredA2ARuntimeHandle>;
}

function isExactLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function networkPolicy(url: URL): A2ANetworkPolicy {
  return {
    allowedOrigins: [url.origin],
    allowPrivateAddresses: isExactLoopback(url.hostname),
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_000_000,
    maxRedirects: 3,
  };
}

function registrationUrl(registration: ExternalAgentRegistration): URL {
  const raw = registration.executorConfig?.interfaceUrl;
  if (typeof raw !== 'string') throw new Error('Configured A2A registration has no interface URL.');
  return new URL(raw);
}

function environmentCredentialBroker(): AgentCredentialBroker {
  const environmentName = (reference: string): string => {
    if (!reference.startsWith('env:') || reference.length === 4) {
      throw new Error('Configured A2A credentials must use an environment reference.');
    }
    return reference.slice(4);
  };
  return {
    isAvailable(reference) {
      const value = process.env[environmentName(reference)];
      return typeof value === 'string' && value.length > 0;
    },
    async withCredential(reference, use) {
      const value = process.env[environmentName(reference)];
      if (!value) throw new Error('Configured A2A credential is unavailable.');
      return use(value);
    },
  };
}

function registrationInput(name: string, config: A2AOutboundAgentConfig) {
  return {
    agentId: `external:${name}`,
    agentCardUrl: config.cardUrl,
    ...(config.credentialEnv ? { credentialRef: `env:${config.credentialEnv}` } : {}),
    effects: { remote: config.effect },
  } as const;
}

export function createConfiguredA2ARuntimeIntegration(input: {
  readonly configHome: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onEvent?: (message: string) => void;
}): ConfiguredA2ARuntimeIntegration {
  const runtimeOptions: RuntimeExternalAgentsOptions = {
    factories: [createA2AAgentExecutorFactory((registration) => ({
      networkPolicy: networkPolicy(registrationUrl(registration)),
      pollIntervalMs: 500,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }))],
    policy: () => ({ allowed: true }),
    credentialBroker: environmentCredentialBroker(),
  };

  return {
    runtimeOptions,
    async start(runtime) {
      const controller = new IntegrationConfigController<A2AIntegrationDocument>({
        domain: 'a2a',
        configHome: input.configHome,
        validate: parseA2AIntegrationDocument,
        read: () => readA2AIntegration(input.configHome),
      });

      const reconcile = async (document: A2AIntegrationDocument): Promise<void> => {
        const current = await runtime.admin.agentRegistrations.list();
        const activeNames = new Set(
          current
            .filter((entry) => entry.executorId === A2A_EXECUTOR_ID)
            .map((entry) => entry.agentId),
        );
        for (const [name, config] of Object.entries(document.agents)) {
          const agentId = `external:${name}`;
          try {
            const url = new URL(config.cardUrl);
            const discovered = await discoverA2ARegistration(
              registrationInput(name, config),
              {
                networkPolicy: networkPolicy(url),
                pollIntervalMs: 500,
                ...(input.fetch ? { fetch: input.fetch } : {}),
              },
            );
            await runtime.admin.agentRegistrations.upsert(discovered.registration);
            activeNames.delete(agentId);
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: 'a2a.runtime-config',
              level: 'warn',
              message: `A2A Agent "${name}" refresh failed; last-known-good registration retained.`,
              detail: error,
            });
            input.onEvent?.(`A2A Agent "${name}" could not be refreshed; its last-known-good registration was retained.`);
            activeNames.delete(agentId);
          }
        }
        for (const name of activeNames) await runtime.admin.agentRegistrations.remove(name);
      };

      const initial = await controller.initialize();
      await reconcile(initial.document);
      controller.subscribe(async (snapshot, previous) => {
        if (snapshot.revision === previous?.revision) return;
        await reconcile(snapshot.document);
        input.onEvent?.(`A2A configuration hot-reloaded (${Object.keys(snapshot.document.agents).length} outbound Agents).`);
      });
      controller.startWatching();
      return {
        status: () => controller.status(),
        async reload() { await controller.reload(); },
        close() { controller.close(); },
      };
    },
  };
}
