import { createHash, randomUUID } from 'node:crypto';

import type {
  AgentArtifactReference,
  AgentContinuationInput,
  AgentExecutor,
  AgentExecutorEvent,
  AgentExecutorFactory,
  AgentExecutorFactoryContext,
  AgentExecutorTaskReference,
  AgentExecutorTaskSnapshot,
  AgentTaskStartInput,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';

import { A2AError } from './errors.js';
import { assertSafeA2AUrl, decodeUtf8, safeA2AFetch } from './safe-fetch.js';
import { isRecord, parseA2AAgentCard, parseA2AMessage, parseA2ATask } from './schemas.js';
import {
  A2A_EXECUTOR_ID,
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AArtifact,
  type A2AClientOptions,
  type A2ADiscoveredRegistration,
  type A2AJsonRpcResponse,
  type A2AMessage,
  type A2ARegistrationInput,
  type A2ATask,
  type A2ATaskState,
} from './types.js';

interface A2AExecutorConfig {
  readonly agentCardUrl: string;
  readonly interfaceUrl: string;
  readonly tenant?: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function executorConfig(registration: ExternalAgentRegistration): A2AExecutorConfig {
  const config = registration.executorConfig;
  if (!isRecord(config)) throw new Error('A2A registration executorConfig is missing.');
  if (typeof config.agentCardUrl !== 'string' || typeof config.interfaceUrl !== 'string') {
    throw new Error('A2A registration endpoints are invalid.');
  }
  return {
    agentCardUrl: config.agentCardUrl,
    interfaceUrl: config.interfaceUrl,
    ...(typeof config.tenant === 'string' ? { tenant: config.tenant } : {}),
  };
}

function chooseInterface(card: A2AAgentCard): A2AAgentCard['supportedInterfaces'][number] {
  const selected = card.supportedInterfaces.find((entry) => (
    entry.protocolBinding.toUpperCase() === 'JSONRPC'
    && entry.protocolVersion === A2A_PROTOCOL_VERSION
  ));
  if (!selected) throw new Error('Agent Card has no supported A2A 1.0 JSONRPC interface.');
  return selected;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function discoverA2ARegistration(
  input: A2ARegistrationInput,
  options: A2AClientOptions,
): Promise<A2ADiscoveredRegistration> {
  const result = await safeA2AFetch(
    new URL(input.agentCardUrl),
    { headers: { accept: 'application/json' } },
    options.networkPolicy,
    options.fetch,
  );
  if (!result.response.ok) throw new Error(`Agent Card request failed with HTTP ${result.response.status}.`);
  if (!result.response.headers.get('content-type')?.toLowerCase().includes('json')) {
    throw new Error('Agent Card response is not JSON.');
  }
  const card = parseA2AAgentCard(parseJson(decodeUtf8(result.body), 'Agent Card'));
  const selected = chooseInterface(card);
  const identity = stableJson({
    agentCardUrl: result.url.href,
    interfaceUrl: selected.url,
    protocolBinding: selected.protocolBinding,
    protocolVersion: selected.protocolVersion,
    tenant: selected.tenant ?? '',
  });
  const revision = sha256(stableJson(card));
  return {
    agentCard: card,
    registration: {
      agentId: input.agentId,
      displayName: card.name,
      description: card.description,
      enabled: true,
      executorId: A2A_EXECUTOR_ID,
      protocol: 'a2a',
      configurationRevision: revision,
      endpointIdentityHash: sha256(identity),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      executorConfig: {
        agentCardUrl: result.url.href,
        interfaceUrl: selected.url,
        ...(selected.tenant ? { tenant: selected.tenant } : {}),
      },
      skills: card.skills.map((skill) => skill.id),
      inputModalities: card.defaultInputModes,
      outputModalities: card.defaultOutputModes,
      capabilities: {
        streaming: card.capabilities.streaming ? 'supported' : 'unsupported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: input.effects.remote, workspace: 'proposal' },
      health: { status: 'healthy', checkedAt: new Date().toISOString() },
    },
  };
}

function metadata(reference: AgentExecutorTaskReference): Readonly<Record<string, unknown>> {
  return reference.metadata ?? {};
}

function directMessage(reference: AgentExecutorTaskReference): A2AMessage | undefined {
  const value = metadata(reference).directMessage;
  return value === undefined ? undefined : parseA2AMessage(value);
}

function taskState(state: A2ATaskState): AgentExecutorTaskSnapshot['state'] {
  const mapping: Record<A2ATaskState, AgentExecutorTaskSnapshot['state']> = {
    TASK_STATE_UNSPECIFIED: 'unknown',
    TASK_STATE_SUBMITTED: 'submitted',
    TASK_STATE_WORKING: 'working',
    TASK_STATE_COMPLETED: 'completed',
    TASK_STATE_FAILED: 'failed',
    TASK_STATE_CANCELED: 'canceled',
    TASK_STATE_INPUT_REQUIRED: 'input-required',
    TASK_STATE_REJECTED: 'rejected',
    TASK_STATE_AUTH_REQUIRED: 'auth-required',
  };
  return mapping[state];
}

function textFromParts(parts: readonly { readonly text?: string }[]): string {
  return parts.flatMap((part) => part.text === undefined ? [] : [part.text]).join('\n');
}

function artifactReference(artifact: A2AArtifact): AgentArtifactReference {
  const urlPart = artifact.parts.find((part) => part.url !== undefined);
  return {
    name: artifact.name ?? artifact.artifactId,
    ...(artifact.parts[0]?.mediaType ? { mimeType: artifact.parts[0].mediaType } : {}),
    ...(urlPart?.url ? { uri: urlPart.url } : {}),
    provenance: 'a2a',
  };
}

function snapshotFromTask(task: A2ATask): AgentExecutorTaskSnapshot {
  const artifactText = (task.artifacts ?? []).flatMap((artifact) => textFromParts(artifact.parts));
  const statusText = task.status.message ? textFromParts(task.status.message.parts) : '';
  const output = [...artifactText, statusText].filter(Boolean).join('\n');
  return {
    state: taskState(task.status.state),
    ...(output ? { output } : {}),
    ...(task.status.state === 'TASK_STATE_FAILED' ? { error: statusText || 'Remote A2A task failed.' } : {}),
    ...(task.artifacts?.length ? { artifacts: task.artifacts.map(artifactReference) } : {}),
  };
}

function snapshotFromMessage(message: A2AMessage): AgentExecutorTaskSnapshot {
  return { state: 'completed', output: textFromParts(message.parts) };
}

function isTerminal(state: AgentExecutorTaskSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

class A2AClientExecutor implements AgentExecutor {
  #disposed = false;

  constructor(
    private readonly registration: ExternalAgentRegistration,
    private readonly context: AgentExecutorFactoryContext,
    private readonly options: A2AClientOptions,
  ) {}

  async preflight(): Promise<{ readonly ok: boolean; readonly reasons?: readonly string[] }> {
    try {
      executorConfig(this.registration);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
    }
  }

  async start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference> {
    const idempotencyKey = input.idempotencyKey;
    if (!idempotencyKey) throw new Error('A2A executor requires an idempotency key.');
    const result = await this.sendMessage({
      message: {
        messageId: idempotencyKey,
        role: 'ROLE_USER',
        parts: [{ text: input.input ?? input.objective, mediaType: 'text/plain' }],
      },
      configuration: { returnImmediately: true },
    });
    if (isRecord(result.task)) {
      const task = parseA2ATask(result.task);
      return {
        idempotencyKey,
        remoteTaskId: task.id,
        metadata: { contextId: task.contextId },
      };
    }
    if (result.message !== undefined) {
      return { idempotencyKey, metadata: { directMessage: parseA2AMessage(result.message) } };
    }
    throw new Error('A2A SendMessage returned neither task nor message.');
  }

  async *events(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    const direct = directMessage(reference);
    if (direct) {
      yield snapshotFromMessage(direct);
      return;
    }
    if (this.registration.capabilities.streaming === 'supported' && !this.registration.credentialRef) {
      try {
        yield* this.streamEvents(reference);
        return;
      } catch {
        yield { progress: { message: 'A2A stream unavailable; polling.' } };
      }
    }
    while (!this.#disposed) {
      const snapshot = await this.get(reference);
      yield snapshot;
      if (isTerminal(snapshot.state) || snapshot.state === 'input-required' || snapshot.state === 'auth-required') return;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
  }

  async get(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    const direct = directMessage(reference);
    if (direct) return snapshotFromMessage(direct);
    if (!reference.remoteTaskId) throw new Error('A2A task reference has no remote task ID.');
    return snapshotFromTask(parseA2ATask(await this.rpc('GetTask', this.taskParams(reference))));
  }

  async sendInput(reference: AgentExecutorTaskReference, input: AgentContinuationInput): Promise<void> {
    if (!reference.remoteTaskId) throw new Error('Direct A2A responses cannot accept input.');
    await this.sendMessage({
      message: {
        messageId: randomUUID(),
        taskId: reference.remoteTaskId,
        ...(typeof metadata(reference).contextId === 'string'
          ? { contextId: metadata(reference).contextId as string } : {}),
        role: 'ROLE_USER',
        parts: [{ text: input.content, mediaType: 'text/plain' }],
      },
      configuration: { returnImmediately: true },
    });
  }

  async cancel(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    if (!reference.remoteTaskId) return this.get(reference);
    return snapshotFromTask(parseA2ATask(await this.rpc('CancelTask', this.taskParams(reference))));
  }

  async reconcile(reference: AgentExecutorTaskReference): Promise<AgentExecutorTaskSnapshot> {
    return this.get(reference);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
  }

  private async *streamEvents(reference: AgentExecutorTaskReference): AsyncIterable<AgentExecutorEvent> {
    if (!reference.remoteTaskId) throw new Error('A2A stream requires a remote task ID.');
    const config = executorConfig(this.registration);
    const url = new URL(config.interfaceUrl);
    await assertSafeA2AUrl(url, this.options.networkPolicy);
    const headers = new Headers({
      accept: 'text/event-stream',
      'a2a-version': A2A_PROTOCOL_VERSION,
      'content-type': 'application/json',
    });
    if (this.options.authorization) headers.set('authorization', this.options.authorization);
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers,
      redirect: 'manual',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'SubscribeToTask',
        params: this.taskParams(reference),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`A2A stream failed with HTTP ${response.status}.`);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new Error('A2A stream returned an invalid content type.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let receivedBytes = 0;
    while (!this.#disposed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > this.options.networkPolicy.maxResponseBytes) {
        throw new Error('A2A stream exceeded the response size limit.');
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const event = this.snapshotFromStreamPayload(parseJson(data, 'A2A stream'));
        if (!event) continue;
        yield event;
        if (event.state && (isTerminal(event.state) || event.state === 'input-required' || event.state === 'auth-required')) return;
      }
    }
  }

  private snapshotFromStreamPayload(payload: unknown): AgentExecutorTaskSnapshot | undefined {
    if (!isRecord(payload)) throw new Error('A2A stream frame is invalid.');
    if (payload.error !== undefined) {
      const error = isRecord(payload.error) ? payload.error : {};
      throw new A2AError(typeof error.code === 'number' ? error.code : -32603, typeof error.message === 'string' ? error.message : 'A2A stream error.');
    }
    if (!isRecord(payload.result)) return undefined;
    if (payload.result.task !== undefined) return snapshotFromTask(parseA2ATask(payload.result.task));
    if (payload.result.message !== undefined) return snapshotFromMessage(parseA2AMessage(payload.result.message));
    if (isRecord(payload.result.statusUpdate) && isRecord(payload.result.statusUpdate.status)) {
      const state = payload.result.statusUpdate.status.state;
      if (typeof state !== 'string') throw new Error('A2A status update has no state.');
      const message = payload.result.statusUpdate.status.message;
      const output = message === undefined ? '' : textFromParts(parseA2AMessage(message).parts);
      return {
        state: taskState(state as A2ATaskState),
        ...(output ? { output } : {}),
      };
    }
    if (isRecord(payload.result.artifactUpdate) && payload.result.artifactUpdate.artifact !== undefined) {
      const task = parseA2ATask({
        id: 'stream-artifact',
        contextId: 'stream-artifact',
        status: { state: 'TASK_STATE_WORKING' },
        artifacts: [payload.result.artifactUpdate.artifact],
      });
      return snapshotFromTask(task);
    }
    return undefined;
  }

  private taskParams(reference: AgentExecutorTaskReference): Readonly<Record<string, unknown>> {
    const config = executorConfig(this.registration);
    return { id: reference.remoteTaskId, ...(config.tenant ? { tenant: config.tenant } : {}) };
  }

  private async sendMessage(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const result = await this.rpc('SendMessage', {
      ...params,
      ...(executorConfig(this.registration).tenant
        ? { tenant: executorConfig(this.registration).tenant } : {}),
    });
    if (!isRecord(result)) throw new Error('A2A SendMessage result is invalid.');
    return result;
  }

  private async rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#disposed) throw new Error('A2A executor is disposed.');
    const run = (authorization?: string) => this.rpcWithAuthorization(method, params, authorization);
    if (this.registration.credentialRef) {
      return this.context.withCredential(this.registration.credentialRef, (credential) => run(`Bearer ${credential}`));
    }
    return run(this.options.authorization);
  }

  private async rpcWithAuthorization(
    method: string,
    params: Readonly<Record<string, unknown>>,
    authorization: string | undefined,
  ): Promise<unknown> {
    const config = executorConfig(this.registration);
    const headers = new Headers({
      accept: 'application/json',
      'a2a-version': A2A_PROTOCOL_VERSION,
      'content-type': 'application/json',
    });
    if (authorization) headers.set('authorization', authorization);
    const result = await safeA2AFetch(new URL(config.interfaceUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    }, this.options.networkPolicy, this.options.fetch);
    if (!result.response.headers.get('content-type')?.toLowerCase().includes('json')) {
      throw new Error('A2A JSON-RPC response has an invalid content type.');
    }
    const payload = parseJson(decodeUtf8(result.body), 'A2A endpoint');
    if (!isRecord(payload)) throw new Error('A2A JSON-RPC response is invalid.');
    const response = payload as unknown as A2AJsonRpcResponse;
    if (response.error) throw new A2AError(response.error.code, response.error.message, result.response.status);
    if (!result.response.ok) throw new Error(`A2A request failed with HTTP ${result.response.status}.`);
    return response.result;
  }
}

export function createA2AAgentExecutorFactory(options: A2AClientOptions): AgentExecutorFactory {
  return {
    executorId: A2A_EXECUTOR_ID,
    protocol: 'a2a',
    async create(registration, context) {
      return new A2AClientExecutor(registration, context, options);
    },
  };
}
