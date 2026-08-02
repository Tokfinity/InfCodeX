import { spawn } from 'node:child_process';
import process from 'node:process';
import type { CLIExecutorConfig, CLIEvent, CLIExecutionOptions } from './types.js';
import {
    killChildProcessTree,
    rememberChildProcessTree,
    type ProcessTreeKillResult,
} from './process-tree.js';

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
            detached: process.platform !== 'win32',
            windowsHide: true,
        });

        // Capture stderr for diagnostics without interleaving it into stdout JSONL.
        let stderrOutput = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrOutput += chunk.toString();
        });

        // Forward caller cancellation and the executor's own timeout to the
        // child through one signal so stdout parsing and process cleanup agree.
        const executionController = new AbortController();
        const abortMarker = {};
        let resolveAbort: (() => void) | undefined;
        const abortReached = new Promise<typeof abortMarker>((resolve) => {
            resolveAbort = () => resolve(abortMarker);
        });
        rememberChildProcessTree(child);
        const forwardExternalAbort = () => {
            if (executionController.signal.aborted) return;
            const reason = options.signal?.reason;
            if (reason === undefined) {
                executionController.abort();
            } else {
                executionController.abort(reason);
            }
        };
        options.signal?.addEventListener('abort', forwardExternalAbort);
        if (options.signal?.aborted) {
            forwardExternalAbort();
        }

        let exited = false;
        let terminationPromise: Promise<ProcessTreeKillResult> | undefined;
        const terminateChild = (): Promise<ProcessTreeKillResult> => {
            if (!terminationPromise) {
                terminationPromise = (async () => {
                    let result: ProcessTreeKillResult = { status: 'unknown' };
                    for (let attempt = 0; attempt < 3; attempt += 1) {
                        rememberChildProcessTree(child);
                        result = await killChildProcessTree(child);
                        if (result.status !== 'unknown') return result;
                        if (exited && !executionController.signal.aborted) return result;
                        if (attempt < 2) {
                            await new Promise((resolve) => setTimeout(resolve, 50));
                        }
                    }
                    return result;
                })();
            }
            return terminationPromise;
        };
        const abortHandler = () => {
            resolveAbort?.();
            if (!exited) {
                void terminateChild();
                // A provider may keep its stdout pipe open even after process
                // termination was requested. Interrupt the async iterator so
                // timeout and caller cancellation can reject immediately.
                child.stdout?.destroy();
            }
        };
        executionController.signal.addEventListener('abort', abortHandler);
        if (executionController.signal.aborted) {
            abortHandler();
        }
        child.on('exit', () => {
            exited = true;
            rememberChildProcessTree(child);
        });

        let timedOut = false;
        let timeoutError: Error | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutMs = this.config.timeout;
        if (
            timeoutMs !== undefined
            && Number.isFinite(timeoutMs)
            && timeoutMs > 0
            && !executionController.signal.aborted
        ) {
            timeoutHandle = setTimeout(() => {
                if (executionController.signal.aborted) return;
                timedOut = true;
                timeoutError = new Error(`Provider CLI timed out after ${timeoutMs}ms`);
                executionController.abort(timeoutError);
            }, timeoutMs);
            timeoutHandle.unref?.();
        }
        const waitForExecution = async <T>(operation: Promise<T>): Promise<T> => {
            const result = await Promise.race([operation, abortReached]);
            if (result === abortMarker) {
                throw executionController.signal.reason
                    ?? timeoutError
                    ?? new Error('Provider CLI execution aborted');
            }
            return result as T;
        };

        const exitResult = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });

        try {
            // Parse JSONL output from stdout.
            const eventIterator = this
                .parseOutputStream(child.stdout!, executionController.signal)
                [Symbol.asyncIterator]();
            while (true) {
                const next = await waitForExecution(eventIterator.next());
                if (next.done) break;
                yield next.value;
            }

            if (executionController.signal.aborted) {
                throw executionController.signal.reason;
            }
            const exit = await waitForExecution(exitResult);
            if (timedOut) {
                throw timeoutError ?? executionController.signal.reason;
            }
            const stderr = stderrOutput.trim();
            if (!options.signal?.aborted && exit.code !== 0) {
                const exitLabel = exit.code === null
                    ? `signal ${exit.signal ?? 'unknown'}`
                    : `code ${exit.code}`;
                throw new Error(
                    `Provider CLI exited with ${exitLabel}${stderr ? `: ${stderr}` : ''}`,
                );
            }
            if (stderr) {
                console.error(`[CLIExecutor] stderr: ${stderr}`);
            }
        } catch (error) {
            // If stdout parsing failed before the child emitted its own error,
            // observe that secondary promise so it cannot become unhandled.
            void exitResult.catch(() => undefined);
            if (executionController.signal.aborted) {
                throw executionController.signal.reason;
            }
            throw error;
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            options.signal?.removeEventListener('abort', forwardExternalAbort);
            executionController.signal.removeEventListener('abort', abortHandler);
            if (
                process.platform === 'win32'
                || terminationPromise !== undefined
                || !exited
            ) {
                const cleanupWasAlreadyRequested = terminationPromise !== undefined;
                const result = await terminateChild();
                if (
                    result.status === 'unknown'
                    && (cleanupWasAlreadyRequested || !exited)
                ) {
                    throw new Error('Provider CLI process-tree termination could not be verified');
                }
            }
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
