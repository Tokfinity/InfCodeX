import { randomUUID } from 'node:crypto';

import type { CapabilityResult } from '@kodax-ai/agent';
import type { ExtensionRuntimeContract } from '@kodax-ai/coding';
import type {
  RuntimeCredentialLease,
  RuntimeHostToolDescriptor,
  RuntimeHostToolLease,
  RuntimeHostToolResult,
} from '../sdk-runtime.js';
import {
  createRuntimeDaemonNotification,
  type RuntimeDaemonErrorCode,
  type RuntimeDaemonNotification,
} from './protocol.js';

const DEFAULT_REVERSE_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_HOST_TOOL_MAX_RESULT_BYTES = 1_048_576;
const MAX_HOST_TOOLS_PER_LEASE = 64;
const MAX_HOST_TOOL_TEXT_LENGTH = 4_096;

interface CredentialLeaseRecord extends RuntimeCredentialLease {
  readonly providerSet: ReadonlySet<string>;
}

interface HostToolLeaseRecord extends RuntimeHostToolLease {
  readonly byName: ReadonlyMap<string, RuntimeHostToolDescriptor>;
}

interface PendingCredential {
  readonly resolve: (credential: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingHostTool {
  readonly resolve: (result: RuntimeHostToolResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

export interface RuntimeDaemonReverseBridgeLimits {
  readonly callTimeoutMs: number;
  readonly maxResultBytes: number;
}

export function runtimeDaemonReverseBridgeLimits(): RuntimeDaemonReverseBridgeLimits {
  return {
    callTimeoutMs: positiveIntegerEnvironment(
      'KODAX_REVERSE_CALL_TIMEOUT_MS',
      DEFAULT_REVERSE_CALL_TIMEOUT_MS,
    ),
    maxResultBytes: positiveIntegerEnvironment(
      'KODAX_HOST_TOOL_MAX_RESULT_BYTES',
      DEFAULT_HOST_TOOL_MAX_RESULT_BYTES,
    ),
  };
}

export interface RuntimeDaemonReverseBridge {
  registerCredential(input: {
    readonly leaseId: string;
    readonly providers: readonly string[];
    readonly expiresAt?: string;
  }): RuntimeCredentialLease;
  revokeCredential(leaseId: string): boolean;
  supplyCredential(input: {
    readonly requestId: string;
    readonly credential?: string;
    readonly error?: string;
  }): boolean;
  acquireCredential(input: {
    readonly leaseId: string;
    readonly provider: string;
    readonly sessionId: string;
    readonly runId: string;
  }): Promise<string>;
  registerHostTools(input: {
    readonly leaseId: string;
    readonly tools: readonly RuntimeHostToolDescriptor[];
  }): RuntimeHostToolLease;
  revokeHostTools(leaseId: string): boolean;
  completeHostTool(input: {
    readonly invocationId: string;
    readonly result?: RuntimeHostToolResult;
    readonly error?: string;
  }): boolean;
  createHostToolRuntime(input: {
    readonly leaseId: string;
    readonly sessionId: string;
    readonly runId: string;
  }): ExtensionRuntimeContract;
  close(): void;
}

export function createRuntimeDaemonReverseBridge(
  notify: ((notification: RuntimeDaemonNotification) => void) | undefined,
): RuntimeDaemonReverseBridge {
  const limits = runtimeDaemonReverseBridgeLimits();
  const credentials = new Map<string, CredentialLeaseRecord>();
  const hostTools = new Map<string, HostToolLeaseRecord>();
  const pendingCredentials = new Map<string, PendingCredential>();
  const pendingHostTools = new Map<string, PendingHostTool>();
  let closed = false;

  const requireOpen = (): void => {
    if (closed) throw bridgeError('host_tool_unavailable', 'Host bridge connection is closed.');
  };

  const pruneExpiredCredentials = (): void => {
    const now = Date.now();
    for (const [leaseId, lease] of credentials) {
      if (lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= now) {
        credentials.delete(leaseId);
      }
    }
  };

  const invokeHostTool = async (input: {
    readonly lease: HostToolLeaseRecord;
    readonly descriptor: RuntimeHostToolDescriptor;
    readonly sessionId: string;
    readonly runId: string;
    readonly toolInput: Record<string, unknown>;
  }): Promise<RuntimeHostToolResult> => {
    requireOpen();
    if (hostTools.get(input.lease.id) !== input.lease) {
      throw bridgeError('host_tool_unavailable', 'Host tool lease was revoked.');
    }
    if (!notify) throw bridgeError('host_tool_unavailable', 'Host tool transport is unavailable.');
    const invocationId = `hostcall_${randomUUID().replace(/-/g, '')}`;
    const result = new Promise<RuntimeHostToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingHostTools.delete(invocationId);
        reject(bridgeError(
          'host_tool_unknown',
          `Host tool ${input.descriptor.name} did not return a certain result before timeout.`,
        ));
      }, limits.callTimeoutMs);
      timer.unref?.();
      pendingHostTools.set(invocationId, { resolve, reject, timer, dispatched: false });
    });
    try {
      notify(createRuntimeDaemonNotification('host_tool.invoke', {
        invocationId,
        leaseId: input.lease.id,
        toolName: input.descriptor.name,
        sessionId: input.sessionId,
        runId: input.runId,
        input: input.toolInput,
        sideEffect: input.descriptor.sideEffect,
      }));
      const pending = pendingHostTools.get(invocationId);
      if (pending) pending.dispatched = true;
    } catch (error: unknown) {
      const pending = pendingHostTools.get(invocationId);
      if (pending) {
        pendingHostTools.delete(invocationId);
        clearTimeout(pending.timer);
        pending.reject(bridgeError('host_tool_unavailable', 'Host tool was not dispatched.'));
      }
    }
    return result;
  };

  return {
    registerCredential(input) {
      requireOpen();
      pruneExpiredCredentials();
      if (
        input.providers.length === 0
        || input.providers.some((provider) => provider.trim().length === 0)
        || new Set(input.providers).size !== input.providers.length
      ) {
        throw bridgeError('invalid_params', 'Credential lease providers must be non-empty and unique.');
      }
      if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
        throw bridgeError('invalid_params', 'Credential lease expiresAt must be an ISO timestamp.');
      }
      if (credentials.has(input.leaseId)) {
        throw bridgeError('conflict', 'Credential lease ID is already registered on this connection.');
      }
      const lease: CredentialLeaseRecord = {
        id: input.leaseId,
        providers: [...input.providers],
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        providerSet: new Set(input.providers),
      };
      credentials.set(input.leaseId, lease);
      return publicCredentialLease(lease);
    },
    revokeCredential(leaseId) {
      return credentials.delete(leaseId);
    },
    supplyCredential(input) {
      const pending = pendingCredentials.get(input.requestId);
      if (!pending) return false;
      pendingCredentials.delete(input.requestId);
      clearTimeout(pending.timer);
      if (input.credential !== undefined && input.credential.length > 0) {
        pending.resolve(input.credential);
      } else {
        pending.reject(bridgeError(
          'credential_unavailable',
          input.error ?? 'Credential broker returned no credential.',
        ));
      }
      return true;
    },
    async acquireCredential(input) {
      requireOpen();
      const lease = credentials.get(input.leaseId);
      if (!lease || !lease.providerSet.has(input.provider)) {
        throw bridgeError('credential_unavailable', 'Credential lease is missing or does not allow this provider.');
      }
      if (lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= Date.now()) {
        credentials.delete(lease.id);
        throw bridgeError('credential_unavailable', 'Credential lease expired.');
      }
      if (!notify) throw bridgeError('credential_unavailable', 'Credential broker transport is unavailable.');
      const requestId = `credreq_${randomUUID().replace(/-/g, '')}`;
      const timeoutMs = lease.expiresAt === undefined
        ? limits.callTimeoutMs
        : Math.min(
            limits.callTimeoutMs,
            Math.max(1, Date.parse(lease.expiresAt) - Date.now()),
          );
      const result = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCredentials.delete(requestId);
          reject(bridgeError('credential_unavailable', 'Credential lease expired or broker timed out.'));
        }, timeoutMs);
        timer.unref?.();
        pendingCredentials.set(requestId, { resolve, reject, timer });
      });
      try {
        notify(createRuntimeDaemonNotification('credential.request', {
          requestId,
          leaseId: lease.id,
          provider: input.provider,
          sessionId: input.sessionId,
          runId: input.runId,
        }));
      } catch {
        const pending = pendingCredentials.get(requestId);
        if (pending) {
          pendingCredentials.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(bridgeError(
            'credential_unavailable',
            'Credential request was not dispatched.',
          ));
        }
      }
      return result;
    },
    registerHostTools(input) {
      requireOpen();
      const names = input.tools.map((tool) => tool.name);
      if (
        names.length === 0
        || names.length > MAX_HOST_TOOLS_PER_LEASE
        || new Set(names).size !== names.length
      ) {
        throw bridgeError('invalid_params', 'Host tool names must be non-empty and unique.');
      }
      if (hostTools.has(input.leaseId)) {
        throw bridgeError('conflict', 'Host tool lease ID is already registered on this connection.');
      }
      for (const tool of input.tools) validateHostToolDescriptor(tool);
      const lease: HostToolLeaseRecord = {
        id: input.leaseId,
        tools: input.tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
        byName: new Map(input.tools.map((tool) => [tool.name, tool])),
      };
      hostTools.set(input.leaseId, lease);
      return { id: lease.id, tools: lease.tools };
    },
    revokeHostTools(leaseId) {
      return hostTools.delete(leaseId);
    },
    completeHostTool(input) {
      const pending = pendingHostTools.get(input.invocationId);
      if (!pending) return false;
      if (input.result !== undefined) {
        if (typeof input.result.content !== 'string') {
          throw bridgeError('invalid_params', 'Host tool result content must be a string.');
        }
        assertJsonByteLimit(input.result, limits.maxResultBytes, 'Host tool result');
      }
      pendingHostTools.delete(input.invocationId);
      clearTimeout(pending.timer);
      if (input.result !== undefined) pending.resolve(input.result);
      else pending.reject(bridgeError('host_tool_unknown', input.error ?? 'Host tool result is unknown.'));
      return true;
    },
    createHostToolRuntime(input) {
      requireOpen();
      const lease = hostTools.get(input.leaseId);
      if (!lease) throw bridgeError('host_tool_unavailable', 'Host tool lease is missing.');
      return {
        hasCapabilityProvider(providerId) { return providerId === 'mcp'; },
        async searchCapabilities(providerId, query, options) {
          if (providerId !== 'mcp' || (options?.kind !== undefined && options.kind !== 'tool')) return [];
          const normalized = query.toLowerCase();
          return lease.tools
            .filter((tool) => (
              tool.name.toLowerCase().includes(normalized)
              || tool.description.toLowerCase().includes(normalized)
            ))
            .slice(0, options?.limit ?? lease.tools.length)
            .map((tool) => ({
              id: hostToolCapabilityId(lease.id, tool.name),
              name: tool.name,
              description: tool.description,
              kind: 'tool',
              server: 'host',
              inputSchema: tool.inputSchema,
            }));
        },
        async describeCapability(providerId, capabilityId) {
          if (providerId !== 'mcp') return undefined;
          const descriptor = descriptorFromCapabilityId(lease, capabilityId);
          return descriptor ? { ...descriptor, id: capabilityId, kind: 'tool', server: 'host' } : undefined;
        },
        async executeCapability(providerId, capabilityId, toolInput) {
          if (providerId !== 'mcp') throw bridgeError('host_tool_unavailable', 'Unsupported host capability provider.');
          const descriptor = descriptorFromCapabilityId(lease, capabilityId);
          if (!descriptor) throw bridgeError('host_tool_unavailable', 'Host tool is not bound to this run.');
          const result = await invokeHostTool({
            lease,
            descriptor,
            sessionId: input.sessionId,
            runId: input.runId,
            toolInput,
          });
          return result as unknown as CapabilityResult;
        },
        async readCapability() {
          throw bridgeError('host_tool_unavailable', 'Host tools do not expose resource reads.');
        },
        async getCapabilityPrompt() { return undefined; },
        async getCapabilityPromptContext() { return undefined; },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      credentials.clear();
      hostTools.clear();
      for (const pending of pendingCredentials.values()) {
        clearTimeout(pending.timer);
        pending.reject(bridgeError('credential_unavailable', 'Credential client disconnected.'));
      }
      pendingCredentials.clear();
      for (const pending of pendingHostTools.values()) {
        clearTimeout(pending.timer);
        pending.reject(bridgeError(
          pending.dispatched ? 'host_tool_unknown' : 'host_tool_unavailable',
          pending.dispatched
            ? 'Host tool client disconnected; the side-effect outcome is unknown.'
            : 'Host tool client disconnected before dispatch.',
        ));
      }
      pendingHostTools.clear();
    },
  };
}

function publicCredentialLease(lease: CredentialLeaseRecord): RuntimeCredentialLease {
  return {
    id: lease.id,
    providers: lease.providers,
    ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  };
}

function validateHostToolDescriptor(tool: RuntimeHostToolDescriptor): void {
  if (!tool.name || !tool.description || !tool.inputSchema) {
    throw bridgeError('invalid_params', 'Host tool descriptors require name, description, and inputSchema.');
  }
  if (!['none', 'idempotent', 'non_idempotent'].includes(tool.sideEffect)) {
    throw bridgeError('invalid_params', `Invalid host tool sideEffect for ${tool.name}.`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(tool.name)) {
    throw bridgeError('invalid_params', 'Host tool name is invalid.');
  }
  if (tool.description.length > MAX_HOST_TOOL_TEXT_LENGTH) {
    throw bridgeError('invalid_params', `Host tool description is too long: ${tool.name}.`);
  }
}

function assertJsonByteLimit(value: unknown, maxBytes: number, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw bridgeError('invalid_params', `${label} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw bridgeError('invalid_params', `${label} exceeds the ${maxBytes}-byte limit.`);
  }
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function hostToolCapabilityId(leaseId: string, toolName: string): string {
  return `host:${leaseId}:${toolName}`;
}

function descriptorFromCapabilityId(
  lease: HostToolLeaseRecord,
  capabilityId: string,
): RuntimeHostToolDescriptor | undefined {
  const prefix = `host:${lease.id}:`;
  return capabilityId.startsWith(prefix)
    ? lease.byName.get(capabilityId.slice(prefix.length))
    : undefined;
}

function bridgeError(
  code: RuntimeDaemonErrorCode,
  message: string,
): Error & { readonly code: RuntimeDaemonErrorCode } {
  return Object.assign(new Error(message), { code });
}
