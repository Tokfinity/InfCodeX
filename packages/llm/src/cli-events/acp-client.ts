import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';
import type {
    ClientSideConnection,
    SessionNotification,
    PromptResponse,
    RequestPermissionRequest,
    RequestPermissionResponse
} from '@agentclientprotocol/sdk';
import { killChildProcessTree, rememberChildProcessTree } from './process-tree.js';

export interface AcpClientOptions {
    /** Command used to launch a native ACP server process. */
    command?: string;
    /** Arguments passed to the native ACP server process. */
    args?: string[];
    /** Readable side of an in-memory pseudo ACP server transport. */
    inputStream?: ReadableStream<Uint8Array>;
    outputStream?: WritableStream<Uint8Array>;
    /** Working directory for spawned native ACP processes. */
    cwd?: string;
    /** Session update callback forwarded from the ACP connection. */
    onSessionUpdate?: (update: SessionNotification) => void;
    /** Cleanup hook used by the in-memory pseudo server transport. */
    abort?: () => void;
    /** Release pseudo-server state for a completed one-shot ACP session. */
    releaseSession?: (sessionId: string) => void;
    /** Create a fresh equivalent transport after the current one is closed. */
    recreate?: () => AcpClientOptions;
    /** Optional executor exposed for install checks in higher layers. */
    executor?: import('./executor.js').CLIExecutor;
}

export class AcpTransportClosedError extends Error {
    constructor() {
        super('ACP transport closed before the request completed');
        this.name = 'AcpTransportClosedError';
    }
}

export class AcpClient {
    private client: ClientSideConnection | null = null;
    private agentProcess: ChildProcess | null = null;
    private options: AcpClientOptions;

    constructor(options: AcpClientOptions) {
        this.options = options;
    }

    async connect(): Promise<void> {
        const {
            ClientSideConnection,
            PROTOCOL_VERSION,
            ndJsonStream,
        } = await import('@agentclientprotocol/sdk');
        let inStream: ReadableStream<Uint8Array>;
        let outStream: WritableStream<Uint8Array>;

        if (this.options.inputStream && this.options.outputStream) {
            inStream = this.options.inputStream;
            outStream = this.options.outputStream;
        } else if (this.options.command) {
            const isWin = process.platform === 'win32';
            const cmd = isWin && !this.options.command.endsWith('.cmd') ? `${this.options.command}.cmd` : this.options.command;

            this.agentProcess = spawn(cmd, this.options.args ?? [], {
                cwd: this.options.cwd ?? process.cwd(),
                stdio: ['pipe', 'pipe', 'inherit'],
                detached: process.platform !== 'win32',
                windowsHide: true,
            });
            rememberChildProcessTree(this.agentProcess);

            if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
                throw new Error('Failed to create ACP stdio pipes');
            }

            outStream = Writable.toWeb(this.agentProcess.stdin);
            inStream = Readable.toWeb(this.agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
        } else {
            throw new Error('AcpClient requires either a command or I/O streams');
        }

        const stream = ndJsonStream(outStream, inStream);

        this.client = new ClientSideConnection(
            () => ({
                sessionUpdate: async (params: SessionNotification) => {
                    this.options.onSessionUpdate?.(params);
                },
                requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                    const options = params.options ?? [];
                    const allowOption = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
                    if (allowOption) {
                        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                    }
                    return { outcome: { outcome: 'cancelled' } };
                }
            }),
            stream
        );

        if (this.client.signal.aborted) throw new AcpTransportClosedError();
        await this.awaitWhileConnected(this.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'kodax-ai-acp-client', version: '1.0.0' }
        }));
    }

    async createNewSession(): Promise<string> {
        if (!this.client) throw new Error('Client not connected');
        if (this.client.signal.aborted) throw new AcpTransportClosedError();

        const session = await this.awaitWhileConnected(this.client.newSession({
            cwd: this.options.cwd ?? process.cwd(),
            mcpServers: []
        }));

        return session.sessionId;
    }

    async prompt(
        text: string,
        sessionId: string,
        signal?: AbortSignal,
        options?: { model?: string; reasoningEffort?: string },
    ): Promise<PromptResponse> {
        if (!this.client) throw new Error('Client not connected');
        signal?.throwIfAborted();
        if (this.client.signal.aborted) throw new AcpTransportClosedError();

        const request: {
            sessionId: string;
            prompt: Array<{ type: 'text'; text: string }>;
            model?: string;
            effort?: string;
        } = {
            sessionId,
            prompt: [{ type: 'text', text }]
        };

        if (options?.model) {
            request.model = options.model;
        }
        if (options?.reasoningEffort) {
            request.effort = options.reasoningEffort;
        }

        let responsePromise = (this.client as unknown as {
            prompt: (params: typeof request) => Promise<PromptResponse>;
        }).prompt(request);

        if (signal) {
            let rejectForAbort: ((reason: unknown) => void) | undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
                rejectForAbort = reject;
            });
            const onAbort = () => {
                this.client?.cancel({ sessionId }).catch(() => { });
                const fallback = new Error('ACP prompt aborted');
                fallback.name = 'AbortError';
                rejectForAbort?.(signal.reason ?? fallback);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            responsePromise = Promise.race([responsePromise, aborted]).finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
        }

        return await this.awaitWhileConnected(responsePromise);
    }

    isConnectionOpen(): boolean {
        return this.client !== null && !this.client.signal.aborted;
    }

    releaseSession(sessionId: string): void {
        this.options.releaseSession?.(sessionId);
    }

    disconnect(): void {
        if (this.agentProcess) {
            void killChildProcessTree(this.agentProcess);
        }
        this.options.abort?.();
        try { (this.client as any)?.close?.(); } catch { }
        this.client = null;
        this.agentProcess = null;
    }

    private async awaitWhileConnected<T>(operation: Promise<T>): Promise<T> {
        const client = this.client;
        if (!client || client.signal.aborted) {
            void operation.catch(() => undefined);
            throw new AcpTransportClosedError();
        }

        let onClosed: (() => void) | undefined;
        const closed = new Promise<never>((_resolve, reject) => {
            onClosed = () => reject(new AcpTransportClosedError());
            client.signal.addEventListener('abort', onClosed, { once: true });
        });
        try {
            return await Promise.race([operation, closed]);
        } finally {
            if (onClosed) {
                client.signal.removeEventListener('abort', onClosed);
            }
        }
    }
}
