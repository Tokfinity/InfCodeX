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
     * Check whether the backing CLI is installed, with a small in-memory cache
     * so repeated stream() calls do not respawn the probe process.
     */
    async isInstalled(): Promise<boolean> {
        if (this._installedCache !== null) return this._installedCache;
        this._installedCache = await this.checkInstalled();
        return this._installedCache;
    }

    /**
     * Provider-specific install probe implementation.
     */
    protected abstract checkInstalled(): Promise<boolean>;

    /**
     * Execute the CLI and stream normalized events back to the caller.
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

        // Capture stderr for diagnostics without interleaving it into stdout JSONL.
        let stderrOutput = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrOutput += chunk.toString();
        });

        // Forward abort requests to the child process.
        let exited = false;
        const abortHandler = () => { if (!exited) child.kill('SIGTERM'); };
        options.signal?.addEventListener('abort', abortHandler);
        child.on('exit', () => { exited = true; });

        try {
            // Parse JSONL output from stdout.
            yield* this.parseOutputStream(child.stdout!, options.signal);

            if (stderrOutput.trim()) {
                console.error(`[CLIExecutor] stderr: ${stderrOutput.trim()}`);
            }
        } finally {
            options.signal?.removeEventListener('abort', abortHandler);
            if (!exited) child.kill();
        }
    }

    /**
     * Build the CLI argument list for a single execution.
     */
    protected abstract buildArgs(options: CLIExecutionOptions): string[];

    /**
     * Parse the subprocess stdout stream as newline-delimited JSON.
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

        // Flush any remaining partial line after the stream ends.
        if (buffer.trim() && !signal?.aborted) {
            const event = this.parseLine(buffer.trim());
            if (event) yield event;
        }
    }

    /**
     * Parse a single JSONL record into a normalized CLI event.
     */
    protected abstract parseLine(line: string): CLIEvent | null;
}
