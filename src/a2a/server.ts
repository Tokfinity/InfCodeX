import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

import type {
  RuntimeAgentBindingService,
  RuntimeBoundDefaultAgent,
  RuntimeBoundLocalAgent,
  RuntimeEvent,
  RuntimeInput,
  RuntimeRunHandle,
  RuntimeRunPhase,
  RuntimeRunResult,
} from '../sdk-runtime.js';
import { A2AError, errorMessage } from './errors.js';
import { isRecord, parseA2AMessage, parseJsonRpcRequest } from './schemas.js';
import { A2AFileTaskStore, type A2AServerTaskRecord } from './task-store.js';
import {
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AJsonRpcRequest,
  type A2AMessage,
  type A2AOperation,
  type A2APart,
  type A2APrincipal,
  type A2AServerEvent,
  type A2AServerHotOptions,
  type A2AServerOptions,
  type A2AServerExecution,
  type A2ATask,
  type A2ATaskState,
  type KodaXA2AServer,
} from './types.js';

type RequestInitWithDuplex = RequestInit & { readonly duplex: 'half' };

interface PreparedA2AExecution {
  readonly service: RuntimeAgentBindingService;
  readonly ownerSessionId: string;
  readonly binding: RuntimeBoundDefaultAgent | RuntimeBoundLocalAgent;
  readonly declaration: A2AServerExecution;
  prepareWorkspace(contextKey: string): Promise<string>;
  start(input: {
    readonly sessionId: string;
    readonly inputs: readonly RuntimeInput[];
    readonly principalKey: string;
  }): Promise<RuntimeRunHandle>;
  close(): Promise<void>;
}

interface PreparedA2AServerOptions extends A2AServerOptions {
  readonly preparedExecution?: PreparedA2AExecution;
}

const TERMINAL_STATES = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function principalKey(principal: A2APrincipal): string {
  return sha256(`${principal.subject}\0${principal.tenant ?? ''}`);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Published A2A base URL must use HTTPS, except on loopback.');
  }
  if (url.username || url.password) throw new Error('Published A2A base URL must not contain credentials.');
  return url;
}

function operationForMethod(method: string): A2AOperation {
  const operations: Readonly<Record<string, A2AOperation>> = {
    SendMessage: 'send-message',
    SendStreamingMessage: 'send-streaming-message',
    GetTask: 'get-task',
    ListTasks: 'list-tasks',
    CancelTask: 'cancel-task',
    SubscribeToTask: 'subscribe-to-task',
    GetExtendedAgentCard: 'get-extended-agent-card',
  };
  const operation = operations[method];
  if (!operation) throw new A2AError(-32601, 'Method not found.');
  return operation;
}

function statusState(phase: RuntimeRunPhase): A2ATaskState {
  const states: Record<RuntimeRunPhase, A2ATaskState> = {
    queued: 'TASK_STATE_SUBMITTED',
    running: 'TASK_STATE_WORKING',
    waiting_permission: 'TASK_STATE_WORKING',
    waiting_user_input: 'TASK_STATE_INPUT_REQUIRED',
    completed: 'TASK_STATE_COMPLETED',
    failed: 'TASK_STATE_FAILED',
    cancelled: 'TASK_STATE_CANCELED',
    interrupted: 'TASK_STATE_FAILED',
  };
  return states[phase];
}

function agentMessage(taskId: string, contextId: string, text: string): A2AMessage {
  return {
    messageId: randomUUID(),
    taskId,
    contextId,
    role: 'ROLE_AGENT',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

function buildCard(options: A2AServerOptions, baseUrl = options.agent.publicBaseUrl): A2AAgentCard {
  const url = new URL('/', validateBaseUrl(baseUrl)).href;
  return {
    name: options.agent.name,
    description: options.agent.description,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    version: options.agent.version,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: options.extendedAgentCard !== undefined },
    securitySchemes: options.authentication.securitySchemes,
    securityRequirements: options.authentication.securityRequirements,
    defaultInputModes: options.agent.inputModes,
    defaultOutputModes: options.agent.outputModes,
    skills: options.agent.skills,
  };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new A2AError(-32600, 'A2A request exceeds the configured limit.', 413);
  }
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('A2A request size limit exceeded.');
      throw new A2AError(-32600, 'A2A request exceeds the configured limit.', 413);
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function rpcResult(id: A2AJsonRpcRequest['id'], result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, error: A2AError): Response {
  const reasons: Readonly<Record<number, string>> = {
    [-32001]: 'TASK_NOT_FOUND',
    [-32002]: 'TASK_NOT_CANCELABLE',
    [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
    [-32004]: 'UNSUPPORTED_OPERATION',
    [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
    [-32006]: 'INVALID_AGENT_RESPONSE',
    [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
    [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
    [-32009]: 'VERSION_NOT_SUPPORTED',
  };
  const reason = reasons[error.code];
  const data = error.data ?? (reason ? [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'kodax.ai',
  }] : undefined);
  return jsonResponse({
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(data !== undefined ? { data } : {}),
    },
  }, error.httpStatus);
}

function messageDigest(message: A2AMessage): string {
  return sha256(JSON.stringify(message));
}

function partBytes(part: A2APart): number {
  if (part.text !== undefined) return Buffer.byteLength(part.text);
  if (part.raw !== undefined) return Buffer.byteLength(part.raw, 'base64');
  if (part.url !== undefined) return Buffer.byteLength(part.url);
  return Buffer.byteLength(JSON.stringify(part.data));
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(item);
    else if (entry.isFile()) total += fs.statSync(item).size;
  }
  return total;
}

function validateInput(message: A2AMessage, maxPartBytes: number, inputModes: readonly string[]): void {
  if (message.role !== 'ROLE_USER') throw new A2AError(-32602, 'Inbound message role must be ROLE_USER.');
  for (const part of message.parts) {
    if (partBytes(part) > maxPartBytes) throw new A2AError(-32602, 'Message Part exceeds the configured limit.');
    if (part.url !== undefined) throw new A2AError(-32602, 'Remote file URLs are not accepted by this server.');
    if (part.raw !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.raw)) {
      throw new A2AError(-32602, 'Message Part raw content is not valid base64.');
    }
    const mediaType = part.mediaType ?? (part.text !== undefined ? 'text/plain'
      : part.data !== undefined ? 'application/json' : 'application/octet-stream');
    if (!inputModes.includes(mediaType)) throw new A2AError(-32005, `Media type ${mediaType} is not supported.`);
  }
}

function withHistory(task: A2ATask, history: readonly A2AMessage[], historyLength?: number): A2ATask {
  if (historyLength === 0) {
    const { history: _ignored, ...withoutHistory } = task;
    return withoutHistory;
  }
  const selected = historyLength === undefined ? history : history.slice(-historyLength);
  return { ...task, history: selected };
}

class KodaXA2AServerRuntime implements KodaXA2AServer {
  readonly #store: A2AFileTaskStore;
  readonly #now: () => Date;
  readonly #runtimeSubscriptions = new Map<string, { close(): void }>();
  readonly #streamClosers = new Set<() => void>();
  readonly #messageTails = new Map<string, Promise<void>>();
  readonly #ready: Promise<void>;
  #nodeServer: Server | undefined;
  #closed = false;
  #card: A2AAgentCard;
  #listeningBaseUrl: string | undefined;

  constructor(private options: PreparedA2AServerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#store = new A2AFileTaskStore(options.dataDir);
    this.#card = buildCard(options);
    this.#ready = this.recover();
  }

  get agentCard(): A2AAgentCard {
    return structuredClone(this.#card);
  }

  async whenReady(): Promise<void> {
    await this.#ready;
  }

  updateHot(options: A2AServerHotOptions): void {
    if (this.#closed) throw new Error('A2A server is closed.');
    this.options = { ...this.options, ...options };
    this.#card = buildCard(this.options, options.agent.publicBaseUrl);
  }

  async handle(request: Request): Promise<Response> {
    await this.#ready;
    if (this.#closed) return jsonResponse({ error: 'A2A server is closed.' }, 503);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      const body = JSON.stringify(this.#card);
      return jsonResponse(this.#card, 200, {
        etag: `"${sha256(body)}"`,
        'cache-control': 'public, max-age=300',
      });
    }
    if (request.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/a2a')) {
      return jsonResponse({ error: 'Not found.' }, 404);
    }
    return this.handleRpc(request);
  }

  async listen(input: { readonly hostname: string; readonly port: number; readonly publicBaseUrl?: string }): Promise<string> {
    if (this.#nodeServer) throw new Error('A2A server is already listening.');
    if (!isLoopbackHostname(input.hostname)) {
      throw new Error('The built-in A2A HTTP listener is loopback-only; use handle() behind TLS for public service.');
    }
    const server = createServer((request, response) => {
      void this.handleNodeRequest(request).then((result) => {
        response.statusCode = result.status;
        result.headers.forEach((value, key) => response.setHeader(key, value));
        if (!result.body) {
          response.end();
          return;
        }
        Readable.fromWeb(result.body).pipe(response);
      }).catch((error: unknown) => {
        const diagnosticId = sha256(errorMessage(error)).slice(0, 16);
        this.emit({ type: 'server.request_failed', time: nowIso(this.#now), outcome: 'failed', diagnosticId });
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Internal server error.', diagnosticId }));
      });
    });
    this.#nodeServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(input.port, input.hostname, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('A2A server did not expose a TCP address.');
    const baseUrl = `http://${input.hostname}:${address.port}`;
    this.#listeningBaseUrl = input.publicBaseUrl ?? baseUrl;
    this.#card = buildCard(this.options, this.#listeningBaseUrl);
    return baseUrl;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const close of this.#streamClosers) close();
    this.#streamClosers.clear();
    for (const subscription of this.#runtimeSubscriptions.values()) subscription.close();
    this.#runtimeSubscriptions.clear();
    this.#store.close();
    const server = this.#nodeServer;
    this.#nodeServer = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await this.options.preparedExecution?.close();
  }

  private async handleNodeRequest(request: import('node:http').IncomingMessage): Promise<Response> {
    const host = request.headers.host ?? '127.0.0.1';
    const url = `http://${host}${request.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else for (const item of value ?? []) headers.append(key, item);
    }
    const init: RequestInitWithDuplex = {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD'
        ? {} : { body: Readable.toWeb(request) as ReadableStream<Uint8Array> }),
      duplex: 'half',
    };
    return this.handle(new Request(url, init));
  }

  private async handleRpc(request: Request): Promise<Response> {
    let id: string | number | null = null;
    try {
      const requestedVersion = request.headers.get('a2a-version');
      if (requestedVersion && requestedVersion !== A2A_PROTOCOL_VERSION) {
        throw new A2AError(-32009, 'A2A version is not supported.');
      }
      if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new A2AError(-32600, 'A2A JSON-RPC requests require application/json.', 415);
      }
      const body = await readBoundedBody(request, this.options.limits.maxRequestBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        throw new A2AError(-32700, 'Invalid JSON payload.');
      }
      const rpc = parseJsonRpcRequest(parsed);
      id = rpc.id;
      const principal = await this.options.authentication.authenticate(request);
      if (!principal) throw new A2AError(-32600, 'Authentication required.', 401);
      if (PUSH_METHODS.has(rpc.method)) throw new A2AError(-32003, 'Push notifications are not supported.');
      const operation = operationForMethod(rpc.method);
      const taskId = typeof rpc.params?.id === 'string'
        ? rpc.params.id
        : isRecord(rpc.params?.message) && typeof rpc.params.message.taskId === 'string'
          ? rpc.params.message.taskId : undefined;
      const allowed = await this.options.authorize({ principal, operation, ...(taskId ? { taskId } : {}) });
      if (!allowed) throw new A2AError(-32001, 'Task not found.');
      return await this.dispatch(rpc, principal);
    } catch (error: unknown) {
      const diagnosticId = sha256(errorMessage(error)).slice(0, 16);
      const normalized = error instanceof A2AError
        ? error
        : new A2AError(-32603, 'Internal error.', 500, [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'INTERNAL',
            domain: 'kodax.ai',
            metadata: { diagnosticId },
          }]);
      this.emit({ type: 'rpc.failed', time: nowIso(this.#now), outcome: 'failed', diagnosticId });
      return rpcError(id, normalized);
    }
  }

  private async dispatch(rpc: A2AJsonRpcRequest, principal: A2APrincipal): Promise<Response> {
    switch (rpc.method) {
      case 'SendMessage': return rpcResult(rpc.id, { task: await this.sendMessage(rpc.params, principal, false) });
      case 'SendStreamingMessage': {
        const task = await this.sendMessage(rpc.params, principal, true);
        return this.streamTask(rpc.id, task.id, principalKey(principal));
      }
      case 'GetTask': return rpcResult(rpc.id, await this.getTask(rpc.params, principal));
      case 'ListTasks': return rpcResult(rpc.id, this.listTasks(rpc.params, principal));
      case 'CancelTask': return rpcResult(rpc.id, await this.cancelTask(rpc.params, principal));
      case 'SubscribeToTask': return this.subscribeTask(rpc.id, rpc.params, principal);
      case 'GetExtendedAgentCard': {
        if (!this.options.extendedAgentCard) throw new A2AError(-32007, 'Extended Agent Card is not configured.');
        return rpcResult(rpc.id, this.options.extendedAgentCard);
      }
      default: throw new A2AError(-32601, 'Method not found.');
    }
  }

  private async sendMessage(
    params: Readonly<Record<string, unknown>> | undefined,
    principal: A2APrincipal,
    streaming: boolean,
  ): Promise<A2ATask> {
    const key = principalKey(principal);
    const previous = this.#messageTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#messageTails.set(key, tail);
    await previous;
    try {
      return await this.sendMessageUnserialized(params, principal, streaming);
    } finally {
      release();
      if (this.#messageTails.get(key) === tail) this.#messageTails.delete(key);
    }
  }

  private async sendMessageUnserialized(
    params: Readonly<Record<string, unknown>> | undefined,
    principal: A2APrincipal,
    streaming: boolean,
  ): Promise<A2ATask> {
    const message = parseA2AMessage(params?.message);
    validateInput(message, this.options.limits.maxPartBytes, this.options.agent.inputModes);
    const key = principalKey(principal);
    const digest = messageDigest(message);
    const duplicate = this.#store.findByMessage(key, message.messageId);
    if (duplicate) {
      if (duplicate.messageDigests[message.messageId] !== digest) {
        throw new A2AError(-32602, 'Message ID was reused with different content.');
      }
      this.emit({ type: 'task.deduplicated', time: nowIso(this.#now), taskId: duplicate.taskId, contextId: duplicate.contextId });
      return duplicate.task;
    }
    const existing = message.taskId ? this.requireOwnedTask(message.taskId, key) : undefined;
    if (existing && message.contextId !== undefined && message.contextId !== existing.contextId) {
      throw new A2AError(-32602, 'Message contextId does not match the task.');
    }
    if (existing && existing.task.status.state !== 'TASK_STATE_INPUT_REQUIRED' && existing.task.status.state !== 'TASK_STATE_AUTH_REQUIRED') {
      throw new A2AError(-32004, 'Task is not waiting for input.');
    }
    const records = this.#store.list(key);
    const retainedLimit = this.options.limits.maxRetainedTasksPerPrincipal
      ?? this.options.limits.maxTasksPerPrincipal
      ?? 100;
    if (!existing && records.length >= retainedLimit) {
      throw new A2AError(-32004, 'Principal task limit reached.');
    }
    const activeForPrincipal = records.filter((record) => !TERMINAL_STATES.has(record.task.status.state)).length;
    if (!existing && activeForPrincipal >= (this.options.limits.maxActiveTasksPerPrincipal ?? 4)) {
      throw new A2AError(-32004, 'Principal active task limit reached.');
    }
    const active = this.#store.all().filter((record) => !TERMINAL_STATES.has(record.task.status.state)).length;
    if (!existing && active >= this.options.limits.maxConcurrentTasks) {
      throw new A2AError(-32004, 'Server task concurrency limit reached.');
    }
    const record = existing ?? await this.createRecord(message, key);
    const next = existing ? this.appendMessage(record, message, digest) : record;
    const started = await this.startRun(next, message);
    const immediate = streaming || isRecord(params?.configuration) && params.configuration.returnImmediately === true;
    return immediate ? started.task : (await this.waitForTask(started.taskId)).task;
  }

  private async createRecord(message: A2AMessage, key: string): Promise<A2AServerTaskRecord> {
    const contextId = message.contextId ?? randomUUID();
    const related = this.#store.list(key).find((record) => record.contextId === contextId);
    const contextKey = sha256(`${key}\0${contextId}`);
    const workspaceRoot = related?.workspaceRoot
      ?? await this.options.preparedExecution?.prepareWorkspace(contextKey);
    const session = related
      ? { id: related.sessionId }
      : await this.options.runtime.sessions.create({
          title: `A2A: ${this.options.agent.name}`,
          surface: 'a2a',
          ...(this.options.execution?.profileId || this.options.agent.profileId
            ? { profileId: this.options.execution?.profileId ?? this.options.agent.profileId }
            : {}),
          ...(workspaceRoot
            ? { projectPath: workspaceRoot, gitRoot: workspaceRoot }
            : this.options.agent.projectPath
              ? { projectPath: this.options.agent.projectPath }
              : {}),
        });
    const taskId = randomUUID();
    const timestamp = nowIso(this.#now);
    return this.#store.save({
      taskId,
      contextId,
      principalKey: key,
      runtimeIdentity: this.options.runtime.identity.runtimeId,
      sessionId: session.id,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(this.options.preparedExecution ? {
        executionPolicyRevision: this.options.preparedExecution.binding.executionPolicyRevision,
      } : {}),
      messageDigests: { [message.messageId]: messageDigest(message) },
      runIds: [],
      task: {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp },
        history: [{ ...message, taskId, contextId }],
      },
      history: [{ ...message, taskId, contextId }],
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSeq: 1,
      lastRuntimeEventSeq: 0,
      runtimeEventCount: 0,
      runtimeEventBytes: 0,
    });
  }

  private appendMessage(record: A2AServerTaskRecord, message: A2AMessage, digest: string): A2AServerTaskRecord {
    const normalized = { ...message, taskId: record.taskId, contextId: record.contextId };
    return this.#store.save({
      ...record,
      messageDigests: { ...record.messageDigests, [message.messageId]: digest },
      history: [...record.history, normalized],
      task: { ...record.task, history: [...record.history, normalized] },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
  }

  private async startRun(record: A2AServerTaskRecord, message: A2AMessage): Promise<A2AServerTaskRecord> {
    const input = await this.inputsForMessage(record.taskId, message);
    const prepared = this.options.preparedExecution;
    if (prepared && record.executionPolicyRevision !== prepared.binding.executionPolicyRevision) {
      throw new A2AError(-32004, 'A2A task execution binding revision changed.');
    }
    const handle = prepared
      ? await prepared.start({
          sessionId: record.sessionId,
          inputs: input,
          principalKey: record.principalKey,
        })
      : await this.options.runtime.runs.start({
          sessionId: record.sessionId,
          input,
          mode: 'managed_task',
          permissionBroker: 'runtime',
          ...(this.options.agent.runOptions ? { options: this.options.agent.runOptions } : {}),
          agentContext: { actorId: `a2a:${record.principalKey.slice(0, 16)}` },
        });
    const working = this.#store.save({
      ...record,
      runIds: [...record.runIds, handle.runId],
      task: { ...record.task, status: { state: 'TASK_STATE_WORKING', timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    this.subscribeRuntime(working, handle.runId);
    void handle.result.then((result) => this.finishRun(working.taskId, result)).catch((error: unknown) => {
      this.failTask(working.taskId, errorMessage(error));
    });
    this.emit({ type: 'task.started', time: nowIso(this.#now), taskId: working.taskId, contextId: working.contextId, runId: handle.runId, outcome: 'accepted' });
    return working;
  }

  private async inputsForMessage(taskId: string, message: A2AMessage): Promise<readonly RuntimeInput[]> {
    const inputs: RuntimeInput[] = [];
    for (const part of message.parts) {
      if (part.text !== undefined) {
        inputs.push({ type: 'text', text: part.text });
        continue;
      }
      inputs.push(await this.materializePart(taskId, part));
    }
    return inputs;
  }

  private async materializePart(taskId: string, part: A2APart): Promise<RuntimeInput> {
    const mediaType = part.mediaType ?? (part.data !== undefined ? 'application/json' : 'application/octet-stream');
    const extension = part.data !== undefined ? '.json' : '.bin';
    const record = this.#store.get(taskId);
    const directory = record?.workspaceRoot
      ? path.join(record.workspaceRoot, 'inbox', sha256(taskId))
      : path.join(path.resolve(this.options.dataDir), 'attachments', sha256(taskId));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const content = part.data !== undefined
      ? Buffer.from(JSON.stringify(part.data), 'utf8')
      : Buffer.from(part.raw ?? '', 'base64');
    const workspaceLimit = this.options.limits.maxWorkspaceBytesPerContext ?? 1_073_741_824;
    if (record?.workspaceRoot && directoryBytes(record.workspaceRoot) + content.byteLength > workspaceLimit) {
      throw new A2AError(-32004, 'A2A context workspace size limit reached.');
    }
    const safeName = part.filename
      ? path.basename(part.filename).replace(/[^A-Za-z0-9._-]/g, '_')
      : `${randomUUID()}${extension}`;
    const file = path.join(directory, `${randomUUID()}-${safeName}`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    const kind = mediaType.startsWith('image/') ? 'image'
      : mediaType.startsWith('video/') ? 'video' : 'file';
    const artifact = await this.options.runtime.artifacts.create({
      kind,
      path: file,
      mediaType,
      mimeType: mediaType,
      ...(part.filename ? { name: path.basename(part.filename) } : {}),
      source: 'user-inline',
      description: 'Inbound A2A message part',
    });
    return { type: 'artifact_ref', artifactId: artifact.id, description: 'Inbound A2A attachment' };
  }

  private subscribeRuntime(record: A2AServerTaskRecord, runId: string): void {
    this.#runtimeSubscriptions.get(record.taskId)?.close();
    const subscription = this.options.runtime.events.subscribe({ runId }, (event) => this.onRuntimeEvent(record.taskId, event));
    this.#runtimeSubscriptions.set(record.taskId, subscription);
  }

  private onRuntimeEvent(taskId: string, event: RuntimeEvent): void {
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const runtimeEventCount = record.runtimeEventCount + 1;
    const runtimeEventBytes = record.runtimeEventBytes + eventBytes;
    if (runtimeEventCount > (this.options.limits.maxEventsPerTask ?? 1_000)
      || runtimeEventBytes > (this.options.limits.maxEventBytesPerTask ?? 16_777_216)) {
      const runId = record.runIds.at(-1);
      if (runId) void this.options.runtime.runs.abort(runId);
      this.failTask(taskId, 'A2A task event quota exceeded.');
      return;
    }
    const state = event.type === 'user_input.requested' ? 'TASK_STATE_INPUT_REQUIRED' : record.task.status.state;
    this.#store.save({
      ...record,
      task: { ...record.task, status: { ...record.task.status, state, timestamp: event.time } },
      updatedAt: event.time,
      eventSeq: record.eventSeq + 1,
      lastRuntimeEventSeq: Math.max(record.lastRuntimeEventSeq, event.seq),
      runtimeEventCount,
      runtimeEventBytes,
    });
  }

  private finishRun(taskId: string, result: RuntimeRunResult): void {
    if (this.#closed) return;
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const state = statusState(result.phase);
    const output = result.result?.lastText ?? result.error?.message ?? '';
    const message = output ? agentMessage(taskId, record.contextId, output) : undefined;
    const history = message ? [...record.history, message] : record.history;
    const artifact = output ? [{
      artifactId: `final-${taskId}`,
      name: 'final-output',
      parts: [{ text: output, mediaType: 'text/plain' }],
    }] : undefined;
    this.#store.save({
      ...record,
      history,
      task: {
        ...record.task,
        status: { state, ...(message ? { message } : {}), timestamp: nowIso(this.#now) },
        ...(artifact ? { artifacts: artifact } : {}),
        history,
      },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    this.#runtimeSubscriptions.get(taskId)?.close();
    this.#runtimeSubscriptions.delete(taskId);
    this.emit({ type: 'task.finished', time: nowIso(this.#now), taskId, contextId: record.contextId, outcome: state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed' });
  }

  private failTask(taskId: string, message: string): void {
    if (this.#closed) return;
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const statusMessage = agentMessage(taskId, record.contextId, message);
    this.#store.save({
      ...record,
      task: { ...record.task, status: { state: 'TASK_STATE_FAILED', message: statusMessage, timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
  }

  private async getTask(params: Readonly<Record<string, unknown>> | undefined, principal: A2APrincipal): Promise<A2ATask> {
    const id = typeof params?.id === 'string' ? params.id : '';
    const record = this.requireOwnedTask(id, principalKey(principal));
    const historyLength = typeof params?.historyLength === 'number' ? params.historyLength : undefined;
    return withHistory(record.task, record.history, historyLength);
  }

  private listTasks(params: Readonly<Record<string, unknown>> | undefined, principal: A2APrincipal): unknown {
    const records = this.#store.list(principalKey(principal)).filter((record) => {
      if (typeof params?.contextId === 'string' && record.contextId !== params.contextId) return false;
      if (typeof params?.status === 'string' && record.task.status.state !== params.status) return false;
      return true;
    });
    const pageSize = typeof params?.pageSize === 'number'
      ? Math.max(1, Math.min(100, Math.floor(params.pageSize))) : 50;
    const offset = typeof params?.pageToken === 'string' && params.pageToken
      ? Number(Buffer.from(params.pageToken, 'base64url').toString('utf8')) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new A2AError(-32602, 'Invalid page token.');
    const page = records.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      tasks: page.map((record) => params?.includeArtifacts === true
        ? record.task
        : { ...record.task, artifacts: undefined }),
      nextPageToken: nextOffset < records.length ? Buffer.from(String(nextOffset)).toString('base64url') : '',
      pageSize,
      totalSize: records.length,
    };
  }

  private async cancelTask(params: Readonly<Record<string, unknown>> | undefined, principal: A2APrincipal): Promise<A2ATask> {
    const id = typeof params?.id === 'string' ? params.id : '';
    const record = this.requireOwnedTask(id, principalKey(principal));
    if (TERMINAL_STATES.has(record.task.status.state)) throw new A2AError(-32002, 'Task is not cancelable.');
    const runId = record.runIds.at(-1);
    if (runId) await this.options.runtime.runs.abort(runId);
    const canceled = this.#store.save({
      ...record,
      task: { ...record.task, status: { state: 'TASK_STATE_CANCELED', timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    return canceled.task;
  }

  private subscribeTask(
    id: A2AJsonRpcRequest['id'],
    params: Readonly<Record<string, unknown>> | undefined,
    principal: A2APrincipal,
  ): Response {
    const taskId = typeof params?.id === 'string' ? params.id : '';
    const record = this.requireOwnedTask(taskId, principalKey(principal));
    if (TERMINAL_STATES.has(record.task.status.state)) throw new A2AError(-32004, 'Cannot subscribe to a terminal task.');
    return this.streamTask(id, taskId, record.principalKey);
  }

  private streamTask(id: A2AJsonRpcRequest['id'], taskId: string, key: string): Response {
    const initial = this.requireOwnedTask(taskId, key);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let cleanup = () => undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.close();
        };
        cleanup = () => {
          unsubscribe?.();
          this.#streamClosers.delete(close);
        };
        this.#streamClosers.add(close);
        controller.enqueue(encoder.encode(this.sse(id, { task: initial.task })));
        if (TERMINAL_STATES.has(initial.task.status.state)) {
          close();
          return;
        }
        unsubscribe = this.#store.subscribe(taskId, (record) => {
          controller.enqueue(encoder.encode(this.sse(id, {
            statusUpdate: { taskId, contextId: record.contextId, status: record.task.status },
          })));
          if (TERMINAL_STATES.has(record.task.status.state)
            || record.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
            || record.task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
            close();
          }
        });
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        cleanup();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  private sse(id: A2AJsonRpcRequest['id'], result: unknown): string {
    return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
  }

  private waitForTask(taskId: string): Promise<A2AServerTaskRecord> {
    const current = this.#store.get(taskId);
    if (!current) return Promise.reject(new A2AError(-32001, 'Task not found.'));
    if (TERMINAL_STATES.has(current.task.status.state)
      || current.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
      || current.task.status.state === 'TASK_STATE_AUTH_REQUIRED') return Promise.resolve(current);
    return new Promise((resolve) => {
      const unsubscribe = this.#store.subscribe(taskId, (record) => {
        if (TERMINAL_STATES.has(record.task.status.state)
          || record.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
          || record.task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
          unsubscribe();
          resolve(record);
        }
      });
    });
  }

  private requireOwnedTask(taskId: string, key: string): A2AServerTaskRecord {
    const record = this.#store.get(taskId);
    if (!record || record.principalKey !== key) throw new A2AError(-32001, 'Task not found.');
    return record;
  }

  private async recover(): Promise<void> {
    for (const record of this.#store.all()) {
      if (TERMINAL_STATES.has(record.task.status.state)) continue;
      const runId = record.runIds.at(-1);
      if (!runId || record.runtimeIdentity !== this.options.runtime.identity.runtimeId) {
        this.failTask(record.taskId, 'Runtime execution was interrupted before A2A recovery.');
        continue;
      }
      try {
        const status = await this.options.runtime.runs.get(runId);
        if (status.phase === 'running' || status.phase === 'queued' || status.phase === 'waiting_permission' || status.phase === 'waiting_user_input') {
          for (const event of await this.options.runtime.events.replay({ runId, sinceSeq: record.lastRuntimeEventSeq })) {
            this.onRuntimeEvent(record.taskId, event);
          }
          this.subscribeRuntime(record, runId);
          void this.options.runtime.runs.await(runId).then((result) => this.finishRun(record.taskId, result)).catch((error: unknown) => {
            this.failTask(record.taskId, errorMessage(error));
          });
        } else {
          this.finishRun(record.taskId, { runId, sessionId: record.sessionId, phase: status.phase });
        }
      } catch {
        this.failTask(record.taskId, 'Runtime execution was unavailable during A2A recovery.');
      }
    }
  }

  private emit(event: A2AServerEvent): void {
    this.options.onEvent?.(event);
  }
}

export function createKodaXA2AServer(options: A2AServerOptions): KodaXA2AServer {
  return new KodaXA2AServerRuntime(options);
}

async function prepareExecution(options: A2AServerOptions): Promise<PreparedA2AExecution> {
  const declaration = options.execution;
  if (!declaration) throw new Error('A2A execution declaration is required for prepared serving.');
  const service = options.runtime.agents.execution;
  if (!service) throw new Error('local-agent-capability-unavailable: Runtime does not own an embedded execution binding service.');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('A2A preparation aborted.');
  const owner = await service.openOwnerSession();
  try {
    const binding = declaration.kind === 'local-agent'
      ? await service.bindLocal({
          ownerSessionId: owner.ownerSessionId,
          ref: declaration.agentRef,
          profileId: declaration.profileId,
          workspace: declaration.workspace,
          toolPolicy: declaration.toolPolicy,
          workspaceByteLimit: options.limits.maxWorkspaceBytesPerContext,
        })
      : await service.bindDefault({
          ownerSessionId: owner.ownerSessionId,
          profileId: declaration.profileId,
          workspace: declaration.workspace,
          toolPolicy: declaration.toolPolicy,
          workspaceByteLimit: options.limits.maxWorkspaceBytesPerContext,
        });
    let closed = false;
    return {
      service,
      ownerSessionId: owner.ownerSessionId,
      binding,
      declaration,
      prepareWorkspace(contextKey) {
        return service.prepareWorkspace({
          ownerSessionId: owner.ownerSessionId,
          bindingId: binding.bindingId,
          contextKey,
        });
      },
      start(input) {
        const base = {
          ownerSessionId: owner.ownerSessionId,
          bindingId: binding.bindingId,
          expectedExecutionPolicyRevision: binding.executionPolicyRevision,
          sessionId: input.sessionId,
          input: input.inputs,
          permissionBroker: 'runtime' as const,
          agentContext: { actorId: `a2a:${input.principalKey.slice(0, 16)}` },
        };
        if (declaration.kind === 'local-agent') {
          const revision = 'configurationRevision' in binding
            && typeof binding.configurationRevision === 'string'
            ? binding.configurationRevision
            : undefined;
          if (!revision) throw new Error('Prepared local-Agent binding is missing its revision.');
          return service.startLocal({ ...base, expectedConfigurationRevision: revision });
        }
        return service.startDefault(base);
      },
      async close() {
        if (closed) return;
        closed = true;
        await service.closeOwnerSession(owner.ownerSessionId);
      },
    };
  } catch (error: unknown) {
    await service.closeOwnerSession(owner.ownerSessionId);
    throw error;
  }
}

/** Prepare an immutable Runtime execution binding before exposing an A2A handler. */
export async function prepareKodaXA2AServer(options: A2AServerOptions): Promise<KodaXA2AServer> {
  const preparedExecution = await prepareExecution(options);
  try {
    const server = new KodaXA2AServerRuntime({ ...options, preparedExecution });
    await server.whenReady();
    return server;
  } catch (error: unknown) {
    await preparedExecution.close();
    throw error;
  }
}
