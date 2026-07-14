import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import type { CapabilityResult } from '@kodax-ai/agent';
import type { ExtensionRuntimeContract } from '@kodax-ai/coding';
import type {
  RuntimeCredentialLease,
  RuntimeHostToolDescriptor,
  RuntimeHostToolLease,
  RuntimeHostToolResult,
  RuntimeHostToolInvocationStatus,
  RuntimeRunRequirements,
  RuntimeSubscription,
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
const MAX_HOST_TOOL_INVOCATION_STATES = 1_000;

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
  readonly invocationId: string;
  readonly resolve: (result: RuntimeHostToolResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly notification: RuntimeDaemonNotification;
  readonly leaseId: string;
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
  attachTransport(
    notify: (notification: RuntimeDaemonNotification) => void,
  ): RuntimeSubscription;
  registerCredential(input: {
    readonly leaseId: string;
    readonly providers: readonly string[];
    readonly expiresAt?: string;
  }): RuntimeCredentialLease;
  getCredential(leaseId: string): RuntimeCredentialLease | undefined;
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
  getHostTools(leaseId: string): RuntimeHostToolLease | undefined;
  revokeHostTools(leaseId: string): boolean;
  completeHostTool(input: {
    readonly invocationId: string;
    readonly result?: RuntimeHostToolResult;
    readonly error?: string;
  }): boolean;
  getHostToolInvocation(invocationId: string): RuntimeHostToolInvocationStatus | undefined;
  createHostToolRuntime(input: {
    readonly leaseId: string;
    readonly sessionId: string;
    readonly runId: string;
  }): ExtensionRuntimeContract;
  getRunRequirements(runId: string): RuntimeRunRequirements | undefined;
  close(): void;
}

export interface RuntimeDaemonReverseBridgeHubAttachment {
  readonly bridge: RuntimeDaemonReverseBridge;
  close(): void;
}

export interface RuntimeDaemonReverseBridgeHub {
  attach(input: {
    readonly principalId: string;
    readonly connectionId: string;
    readonly instanceSecret?: string;
    readonly notify: (notification: RuntimeDaemonNotification) => void;
  }): RuntimeDaemonReverseBridgeHubAttachment;
  getRunRequirements(runId: string): RuntimeRunRequirements | undefined;
  close(): void;
}

export interface RuntimeDaemonReverseBridgeHubOptions {
  /** Daemon-owned metadata only; arguments, results, and credentials are never stored. */
  readonly invocationStateFile?: string;
}

interface RuntimeDaemonReverseBridgeOptions {
  readonly initialInvocations?: readonly RuntimeHostToolInvocationStatus[];
  readonly onInvocationsChanged?: (
    invocations: readonly RuntimeHostToolInvocationStatus[],
  ) => void;
}

export function createRuntimeDaemonReverseBridge(
  initialNotify: ((notification: RuntimeDaemonNotification) => void) | undefined,
  options: RuntimeDaemonReverseBridgeOptions = {},
): RuntimeDaemonReverseBridge {
  const limits = runtimeDaemonReverseBridgeLimits();
  const credentials = new Map<string, CredentialLeaseRecord>();
  const hostTools = new Map<string, HostToolLeaseRecord>();
  const pendingCredentials = new Map<string, PendingCredential>();
  const pendingHostTools = new Map<string, PendingHostTool>();
  const hostToolInvocations = new Map(
    (options.initialInvocations ?? []).map((invocation) => [invocation.invocationId, invocation]),
  );
  const activeHostLeases = new Set<string>();
  const credentialRuns = new Map<string, { readonly leaseId: string; readonly provider: string }>();
  const hostToolRuns = new Map<string, string>();
  let activeTransport: {
    readonly id: string;
    readonly notify: (notification: RuntimeDaemonNotification) => void;
  } | undefined;
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

  const rejectPendingCredentialRequests = (message: string): void => {
    for (const pending of pendingCredentials.values()) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError('credential_unavailable', message));
    }
    pendingCredentials.clear();
  };

  const rejectDispatchedHostCalls = (): void => {
    for (const [invocationId, pending] of pendingHostTools) {
      if (!pending.dispatched) continue;
      pendingHostTools.delete(invocationId);
      clearTimeout(pending.timer);
      updateHostToolInvocation(invocationId, 'unknown');
      pending.reject(bridgeError(
        'host_tool_unknown',
        'Host tool client disconnected; the side-effect outcome is unknown.',
      ));
    }
  };

  const updateHostToolInvocation = (
    invocationId: string,
    state: RuntimeHostToolInvocationStatus['state'],
  ): void => {
    const current = hostToolInvocations.get(invocationId);
    if (current === undefined) return;
    const updated = {
      ...current,
      state,
      updatedAt: new Date().toISOString(),
    };
    const next = new Map(hostToolInvocations);
    next.delete(invocationId);
    next.set(invocationId, updated);
    while (next.size > MAX_HOST_TOOL_INVOCATION_STATES) {
      const oldest = next.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    options.onInvocationsChanged?.([...next.values()]);
    hostToolInvocations.clear();
    for (const [id, invocation] of next) hostToolInvocations.set(id, invocation);
  };

  const dispatchPendingHostCall = (invocationId: string, pending: PendingHostTool): void => {
    const transport = activeTransport;
    if (
      pending.dispatched
      || transport === undefined
      || !activeHostLeases.has(pending.leaseId)
    ) return;
    try {
      updateHostToolInvocation(invocationId, 'dispatched');
      pending.dispatched = true;
      transport.notify(pending.notification);
    } catch {
      pendingHostTools.delete(invocationId);
      clearTimeout(pending.timer);
      updateHostToolInvocation(invocationId, 'unknown');
      pending.reject(bridgeError(
        'host_tool_unknown',
        'Host tool transport failed after durable dispatch; the side-effect outcome is unknown.',
      ));
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
    const invocationId = `hostcall_${randomUUID().replace(/-/g, '')}`;
    const notification = createRuntimeDaemonNotification('host_tool.invoke', {
      invocationId,
      leaseId: input.lease.id,
      toolName: input.descriptor.name,
      sessionId: input.sessionId,
      runId: input.runId,
      input: input.toolInput,
      sideEffect: input.descriptor.sideEffect,
    });
    const invocation: RuntimeHostToolInvocationStatus = {
      invocationId,
      leaseId: input.lease.id,
      toolName: input.descriptor.name,
      sessionId: input.sessionId,
      runId: input.runId,
      state: 'prepared',
      updatedAt: new Date().toISOString(),
    };
    const nextInvocations = new Map(hostToolInvocations);
    nextInvocations.set(invocationId, invocation);
    while (nextInvocations.size > MAX_HOST_TOOL_INVOCATION_STATES) {
      const oldest = nextInvocations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      nextInvocations.delete(oldest);
    }
    options.onInvocationsChanged?.([...nextInvocations.values()]);
    hostToolInvocations.clear();
    for (const [id, status] of nextInvocations) hostToolInvocations.set(id, status);
    const result = new Promise<RuntimeHostToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingHostTools.get(invocationId);
        if (!pending) return;
        pendingHostTools.delete(invocationId);
        updateHostToolInvocation(
          invocationId,
          pending.dispatched ? 'unknown' : 'not_dispatched',
        );
        reject(bridgeError(
          pending.dispatched ? 'host_tool_unknown' : 'host_tool_unavailable',
          pending.dispatched
            ? `Host tool ${input.descriptor.name} did not return a certain result before timeout.`
            : `Host tool ${input.descriptor.name} had no connected host before timeout.`,
        ));
      }, limits.callTimeoutMs);
      timer.unref?.();
      pendingHostTools.set(invocationId, {
        invocationId,
        resolve,
        reject,
        timer,
        notification,
        leaseId: input.lease.id,
        dispatched: false,
      });
    });
    const pending = pendingHostTools.get(invocationId);
    if (pending) dispatchPendingHostCall(invocationId, pending);
    return result;
  };

  if (initialNotify !== undefined) {
    activeTransport = { id: `bridge_${randomUUID().replace(/-/g, '')}`, notify: initialNotify };
  }

  return {
    attachTransport(notify) {
      requireOpen();
      if (activeTransport !== undefined) {
        rejectPendingCredentialRequests('Credential client connection was replaced.');
        rejectDispatchedHostCalls();
      }
      const id = `bridge_${randomUUID().replace(/-/g, '')}`;
      activeTransport = { id, notify };
      activeHostLeases.clear();
      return {
        close() {
          if (activeTransport?.id !== id) return;
          activeTransport = undefined;
          activeHostLeases.clear();
          rejectPendingCredentialRequests('Credential client disconnected.');
          rejectDispatchedHostCalls();
        },
      };
    },
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
    getCredential(leaseId) {
      pruneExpiredCredentials();
      const lease = credentials.get(leaseId);
      return lease === undefined ? undefined : publicCredentialLease(lease);
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
      const transport = activeTransport;
      if (!transport) throw bridgeError('credential_unavailable', 'Credential broker transport is unavailable.');
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
        transport.notify(createRuntimeDaemonNotification('credential.request', {
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
      return result.then((credential) => {
        credentialRuns.set(input.runId, { leaseId: input.leaseId, provider: input.provider });
        return credential;
      });
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
      activeHostLeases.add(input.leaseId);
      return { id: lease.id, tools: lease.tools };
    },
    getHostTools(leaseId) {
      const lease = hostTools.get(leaseId);
      if (lease !== undefined) {
        activeHostLeases.add(leaseId);
        for (const [invocationId, pending] of pendingHostTools) {
          if (pending.leaseId === leaseId) dispatchPendingHostCall(invocationId, pending);
        }
      }
      return lease === undefined ? undefined : { id: lease.id, tools: lease.tools };
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
      if (input.result !== undefined) {
        updateHostToolInvocation(input.invocationId, 'completed');
        pending.resolve(input.result);
      } else {
        updateHostToolInvocation(input.invocationId, 'unknown');
        pending.reject(bridgeError('host_tool_unknown', input.error ?? 'Host tool result is unknown.'));
      }
      return true;
    },
    getHostToolInvocation(invocationId) {
      return hostToolInvocations.get(invocationId);
    },
    createHostToolRuntime(input) {
      requireOpen();
      const lease = hostTools.get(input.leaseId);
      if (!lease) throw bridgeError('host_tool_unavailable', 'Host tool lease is missing.');
      hostToolRuns.set(input.runId, input.leaseId);
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
    getRunRequirements(runId) {
      const credential = credentialRuns.get(runId);
      const hostLeaseId = hostToolRuns.get(runId);
      if (credential === undefined && hostLeaseId === undefined) return undefined;
      return {
        ...(credential !== undefined
          ? {
              credential: {
                ...credential,
                state: 'ready' as const,
              },
            }
          : {}),
        ...(hostLeaseId !== undefined
          ? {
              hostTools: {
                leaseId: hostLeaseId,
                state: !hostTools.has(hostLeaseId)
                  ? 'expired' as const
                  : activeHostLeases.has(hostLeaseId)
                    ? 'ready' as const
                    : 'waiting_host' as const,
              },
            }
          : {}),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      activeTransport = undefined;
      activeHostLeases.clear();
      credentials.clear();
      hostTools.clear();
      rejectPendingCredentialRequests('Credential client disconnected.');
      for (const pending of pendingHostTools.values()) {
        clearTimeout(pending.timer);
        updateHostToolInvocation(
          pending.invocationId,
          pending.dispatched ? 'unknown' : 'not_dispatched',
        );
        pending.reject(bridgeError(
          pending.dispatched ? 'host_tool_unknown' : 'host_tool_unavailable',
          pending.dispatched
            ? 'Host tool client disconnected; the side-effect outcome is unknown.'
            : 'Host tool client disconnected before dispatch.',
        ));
      }
      pendingHostTools.clear();
      hostToolInvocations.clear();
    },
  };
}

export function createRuntimeDaemonReverseBridgeHub(
  options: RuntimeDaemonReverseBridgeHubOptions = {},
): RuntimeDaemonReverseBridgeHub {
  const bridges = new Map<string, RuntimeDaemonReverseBridge>();
  const persistedInvocations = loadHostToolInvocationStore(options.invocationStateFile);
  let closed = false;
  return {
    attach(input) {
      if (closed) throw bridgeError('host_tool_unavailable', 'Host bridge hub is closed.');
      if (
        input.instanceSecret !== undefined
        && (input.instanceSecret.length < 32 || input.instanceSecret.length > 512)
      ) {
        throw bridgeError(
          'invalid_params',
          'Runtime client instanceSecret must contain between 32 and 512 characters.',
        );
      }
      const key = input.instanceSecret === undefined
        ? `ephemeral:${input.connectionId}`
        : `stable:${input.principalId}:${createHash('sha256').update(input.instanceSecret).digest('hex')}`;
      const recovered = key.startsWith('stable:')
        ? recoverHostToolInvocationStates(persistedInvocations.get(key) ?? [])
        : [];
      const bridge = bridges.get(key) ?? createRuntimeDaemonReverseBridge(undefined, {
        initialInvocations: recovered,
        ...(key.startsWith('stable:')
          ? {
              onInvocationsChanged(invocations) {
                persistedInvocations.set(key, invocations);
                saveHostToolInvocationStore(options.invocationStateFile, persistedInvocations);
              },
            }
          : {}),
      });
      if (!bridges.has(key) && recovered.length > 0) {
        persistedInvocations.set(key, recovered);
        saveHostToolInvocationStore(options.invocationStateFile, persistedInvocations);
      }
      bridges.set(key, bridge);
      const transport = bridge.attachTransport(input.notify);
      return {
        bridge,
        close() {
          transport.close();
        },
      };
    },
    getRunRequirements(runId) {
      for (const bridge of bridges.values()) {
        const requirements = bridge.getRunRequirements(runId);
        if (requirements !== undefined) return requirements;
      }
      return undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const bridge of bridges.values()) bridge.close();
      bridges.clear();
    },
  };
}

function recoverHostToolInvocationStates(
  invocations: readonly RuntimeHostToolInvocationStatus[],
): readonly RuntimeHostToolInvocationStatus[] {
  const recoveredAt = new Date().toISOString();
  return invocations.map((invocation) => {
    if (invocation.state === 'prepared') {
      return { ...invocation, state: 'not_dispatched', updatedAt: recoveredAt };
    }
    if (invocation.state === 'dispatched') {
      return { ...invocation, state: 'unknown', updatedAt: recoveredAt };
    }
    return invocation;
  });
}

function loadHostToolInvocationStore(
  file: string | undefined,
): Map<string, readonly RuntimeHostToolInvocationStatus[]> {
  if (file === undefined || !fs.existsSync(file)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new Error(`Host Tool invocation recovery store is untrusted: ${normalizeError(error).message}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.clients)) {
    throw new Error('Host Tool invocation recovery store is untrusted: invalid root shape.');
  }
  const result = new Map<string, readonly RuntimeHostToolInvocationStatus[]>();
  for (const item of parsed.clients) {
    if (!isRecord(item) || typeof item.key !== 'string' || !Array.isArray(item.invocations)) {
      throw new Error('Host Tool invocation recovery store is untrusted: invalid client entry.');
    }
    const invocations = item.invocations.map(parseHostToolInvocationStatus);
    result.set(item.key, invocations);
  }
  return result;
}

function saveHostToolInvocationStore(
  file: string | undefined,
  clients: ReadonlyMap<string, readonly RuntimeHostToolInvocationStatus[]>,
): void {
  if (file === undefined) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      clients: [...clients].map(([key, invocations]) => ({ key, invocations })),
    }, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function parseHostToolInvocationStatus(value: unknown): RuntimeHostToolInvocationStatus {
  if (
    !isRecord(value)
    || typeof value.invocationId !== 'string'
    || typeof value.leaseId !== 'string'
    || typeof value.toolName !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.runId !== 'string'
    || !isHostToolInvocationState(value.state)
    || typeof value.updatedAt !== 'string'
  ) {
    throw new Error('Host Tool invocation recovery store is untrusted: invalid invocation entry.');
  }
  return {
    invocationId: value.invocationId,
    leaseId: value.leaseId,
    toolName: value.toolName,
    sessionId: value.sessionId,
    runId: value.runId,
    state: value.state,
    updatedAt: value.updatedAt,
  };
}

function isHostToolInvocationState(
  value: unknown,
): value is RuntimeHostToolInvocationStatus['state'] {
  return value === 'prepared'
    || value === 'dispatched'
    || value === 'completed'
    || value === 'unknown'
    || value === 'not_dispatched';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
