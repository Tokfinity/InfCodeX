import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { KodaXRuntime } from '../sdk-runtime.js';
import type { A2AServerConfig } from './config.js';
import type {
  A2AAuthentication,
  A2AServerHotOptions,
  A2AServerOptions,
} from './types.js';

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  return match?.[1];
}

function equalSecret(left: string, right: string): boolean {
  const expected = Buffer.from(left);
  const actual = Buffer.from(right);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function createBearerEnvA2AAuthentication(
  config: A2AServerConfig['authentication'],
  env: NodeJS.ProcessEnv = process.env,
): A2AAuthentication {
  const expected = env[config.tokenEnv];
  if (!expected) throw new Error(`A2A bearer token environment variable is unset: ${config.tokenEnv}.`);
  return {
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque' } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    async authenticate(request) {
      const actual = bearerToken(request);
      return actual && equalSecret(expected, actual)
        ? { subject: config.principalId, scopes: ['a2a:invoke'] }
        : null;
    },
  };
}

function publishedAgent(config: A2AServerConfig, baseUrl: string) {
  return {
    name: config.published.name,
    description: config.published.description,
    version: config.published.version,
    publicBaseUrl: config.publicBaseUrl ?? baseUrl,
    skills: config.published.skills,
    inputModes: config.published.inputModes,
    outputModes: config.published.outputModes,
    ...(config.execution.profileId ? { profileId: config.execution.profileId } : {}),
  };
}

function authorization(): Promise<boolean> {
  return Promise.resolve(true);
}

export function createA2AServerOptionsFromConfig(input: {
  readonly runtime: KodaXRuntime;
  readonly config: A2AServerConfig;
  readonly listenBaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
}): A2AServerOptions {
  return {
    runtime: input.runtime,
    agent: publishedAgent(input.config, input.listenBaseUrl),
    execution: input.config.execution,
    dataDir: expandHome(input.config.dataDir),
    limits: input.config.limits,
    authentication: createBearerEnvA2AAuthentication(input.config.authentication, input.env),
    authorize: authorization,
  };
}

export function createA2AServerHotOptions(input: {
  readonly config: A2AServerConfig;
  readonly listenBaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
}): A2AServerHotOptions {
  return {
    agent: publishedAgent(input.config, input.listenBaseUrl),
    limits: input.config.limits,
    authentication: createBearerEnvA2AAuthentication(input.config.authentication, input.env),
    authorize: authorization,
  };
}
