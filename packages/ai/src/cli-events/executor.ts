import { spawn } from 'node:child_process';
import process from 'node:process';
import type { CLIExecutorConfig, CLIEvent, CLIExecutionOptions } from './types.js';

export abstract class CLIExecutor {
    protected config: CLIExecutorConfig;
    private _installedCache: boolean | null = null;

    constructor(config: CLIExecutorConfig) {
        this.config = config;
    }

    /**
     * 检测 CLI 是否安装（带缓存，避免每次 stream() 重复 spawn）
     */
    async isInstalled(): Promise<boolean> {
        if (this._installedCache !== null) return this._installedCache;
        this._installedCache = await this.checkInstalled();
        return this._installedCache;
    }

    /**
     * 子类实现的安装检测
     */
    protected abstract checkInstalled(): Promise<boolean>;

    /**
     * 执行 CLI 并流式返回事件
     */
    async *execute(options: CLIExecutionOptions): AsyncGenerator<CLIEvent> {
        const args = this.buildArgs(options);
        const env = { ...process.env, ...this.config.env };

        const isWin = process.platform === 'win32';
        const cmd = isWin && !this.config.command.endsWith('.cmd') ? `${this.config.command}.cmd` : this.config.command;

        const child = spawn(cmd, args, {
            cwd: this.config.cwd ?? process.cwd(),
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // 收集 stderr 用于错误诊断
        let stderrOutput = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrOutput += chunk.toString();
        });

        // 处理 abort 信号
        let exited = false;
        const abortHandler = () => { if (!exited) child.kill('SIGTERM'); };
        options.signal?.addEventListener('abort', abortHandler);
        child.on('exit', () => { exited = true; });

        try {
            // 解析 JSON Lines 输出
            yield* this.parseOutputStream(child.stdout!, options.signal);

            // 如果 stderr 有内容且没有解析到任何有效事件，抛出错误
            if (stderrOutput.trim()) {
                console.error(`[CLIExecutor] stderr: ${stderrOutput.trim()}`);
            }
        } finally {
            options.signal?.removeEventListener('abort', abortHandler);
            if (!exited) child.kill();
        }
    }

    /**
     * 构建命令行参数
     */
    protected abstract buildArgs(options: CLIExecutionOptions): string[];

    /**
     * 解析输出流
     */
    protected async *parseOutputStream(
        stream: NodeJS.ReadableStream,
        signal?: AbortSignal
    ): AsyncGenerator<CLIEvent> {
        let buffer = '';

        for await (const chunk of stream) {
            if (signal?.aborted) break;

            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                const event = this.parseLine(line.trim());
                if (event) yield event;
            }
        }

        // 处理剩余 buffer
        if (buffer.trim() && !signal?.aborted) {
            const event = this.parseLine(buffer.trim());
            if (event) yield event;
        }
    }

    /**
     * 解析单行 JSON
     */
    protected abstract parseLine(line: string): CLIEvent | null;
}
