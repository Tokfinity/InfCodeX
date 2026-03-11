import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';
import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type SessionNotification,
    type RequestPermissionRequest,
    type RequestPermissionResponse
} from '@agentclientprotocol/sdk';

export interface AcpClientOptions {
    /** 启动子进程的命令，如果是原生 ACP 则必填 */
    command?: string;
    /** 启动子进程的参数，如果是原生 ACP 则必填 */
    args?: string[];
    /** 如果是内部模拟进程（Pseudo Server），直接传入 Web 标准的流 */
    inputStream?: ReadableStream<Uint8Array>;
    outputStream?: WritableStream<Uint8Array>;
    /** 当前工作目录 */
    cwd?: string;
    /** Session Update 回调 */
    onSessionUpdate?: (update: SessionNotification) => void;
    /** 模拟进程下用于关闭资源的钩子 */
    abort?: () => void;
    /** 直接暴露的底层执行器，用于验证是否安装 */
    executor?: import('./executor.js').CLIExecutor;
}

export class AcpClient {
    private client: ClientSideConnection | null = null;
    private agentProcess: ChildProcess | null = null;
    private options: AcpClientOptions;

    constructor(options: AcpClientOptions) {
        this.options = options;
    }

    async connect(): Promise<void> {
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
                stdio: ['pipe', 'pipe', 'inherit']
            });

            if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
                throw new Error("Failed to create ACP stdio pipes");
            }

            outStream = Writable.toWeb(this.agentProcess.stdin);
            inStream = Readable.toWeb(this.agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
        } else {
            throw new Error("AcpClient requires either a command or I/O streams");
        }

        const stream = ndJsonStream(outStream, inStream);

        this.client = new ClientSideConnection(
            () => ({
                sessionUpdate: async (params: SessionNotification) => {
                    this.options.onSessionUpdate?.(params);
                },
                requestPermission: async (_params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                    const options = _params.options ?? [];
                    const allowOption = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
                    if (allowOption) {
                        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                    }
                    return { outcome: { outcome: 'cancelled' } };
                }
            }),
            stream
        );

        await this.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "kodax-ai-acp-client", version: "1.0.0" }
        });
    }

    async createNewSession(): Promise<string> {
        if (!this.client) throw new Error("Client not connected");

        const session = await this.client.newSession({
            cwd: this.options.cwd ?? process.cwd(),
            mcpServers: []
        });

        return session.sessionId;
    }

    async prompt(text: string, sessionId: string, signal?: AbortSignal): Promise<void> {
        if (!this.client) throw new Error("Client not connected");

        let responsePromise = this.client.prompt({
            sessionId,
            prompt: [{ type: "text", text }]
        });

        if (signal) {
            const onAbort = () => {
                this.client?.cancel({ sessionId }).catch(() => { });
            };
            signal.addEventListener('abort', onAbort);
            responsePromise = responsePromise.finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
        }

        await responsePromise;
    }

    disconnect(): void {
        this.agentProcess?.kill();
        this.options.abort?.(); // triggering cleanup in pseudo server
        try { (this.client as any)?.close?.(); } catch (e) { }
        this.client = null;
    }
}
