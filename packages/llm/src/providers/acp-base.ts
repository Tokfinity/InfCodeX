import { KodaXBaseProvider } from './base.js';
import { AcpClient, AcpClientOptions } from '../cli-events/acp-client.js';
import {
    CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    cloneCapabilityProfile,
} from './capability-profile.js';
import { stripCacheBoundaries } from '../cache-control.js';
import type {
    KodaXImageBlock,
    KodaXMessage,
    KodaXNormalizedReasoningRequest,
    KodaXProviderCapabilityProfile,
    KodaXReasoningRequest,
    KodaXStreamResult,
    KodaXProviderStreamOptions,
    KodaXToolDefinition,
    KodaXTextBlock,
    KodaXTokenUsage,
    KodaXToolUseBlock,
    KodaXVerifyCredentialResult
} from '../types.js';

interface ActiveStreamContext {
    streamOptions?: KodaXProviderStreamOptions;
    output: { text: string };
}

function normalizeAcpUsage(usage: unknown): KodaXTokenUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const usageRecord = usage as Record<string, unknown>;

  const inputTokens = typeof usageRecord.inputTokens === 'number' ? usageRecord.inputTokens : 0;
  const outputTokens = typeof usageRecord.outputTokens === 'number' ? usageRecord.outputTokens : 0;
  const totalTokens = typeof usageRecord.totalTokens === 'number' ? usageRecord.totalTokens : inputTokens + outputTokens;

    if ([inputTokens, outputTokens, totalTokens].some((value) => !Number.isFinite(value) || value < 0)) {
        return undefined;
    }

    if (totalTokens < inputTokens || totalTokens < outputTokens) {
        return undefined;
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedReadTokens:
            typeof usageRecord.cachedReadTokens === 'number' ? usageRecord.cachedReadTokens : undefined,
        cachedWriteTokens:
            typeof usageRecord.cachedWriteTokens === 'number' ? usageRecord.cachedWriteTokens : undefined,
        thoughtTokens:
            typeof usageRecord.thoughtTokens === 'number' ? usageRecord.thoughtTokens : undefined,
    };
}

function selectAcpReasoningEffort(
    reasoning: KodaXNormalizedReasoningRequest,
): string | undefined {
    if (reasoning.effort === 'none') {
        return 'none';
    }
    if (!reasoning.enabled || reasoning.effort === 'auto') {
        return undefined;
    }
    return reasoning.effort;
}

/**
 * Shared base class for ACP-backed providers.
 * It can connect either to a native ACP server process or to our in-memory
 * pseudo ACP bridge that adapts CLI executors into ACP session updates.
 */
export abstract class KodaXAcpProvider extends KodaXBaseProvider {
    protected abstract readonly acpClientOptions: AcpClientOptions;
    private _client: AcpClient | null = null;
    private _sessionMap = new Map<string, string>();
    private _activeStreams = new Map<string, ActiveStreamContext>();

    // CLI-backed ACP adapters do not require a real API key.
    override isConfigured(): boolean {
        return true;
    }

    /**
     * FEATURE_216 v0.7.45 — CLI-bridge providers manage credentials in
     * the CLI binary's own token store (gemini CLI / codex CLI OAuth
     * tokens, etc.), which lives outside SDK reach. There is no HTTP
     * primitive to probe. Always returns `unsupported` regardless of
     * `verifyStrategy` (which provider-capabilities.json validates as
     * 'unsupported' for cliBridge entries).
     */
    override async verifyCredential(): Promise<KodaXVerifyCredentialResult> {
        return {
            ok: false,
            error: 'unsupported',
            strategy: 'unsupported',
            durationMs: 0,
            approxTokensSpent: 0,
            message: `CLI-bridge provider "${this.name}" manages credentials in its CLI binary's token store; not verifiable from the KodaX SDK`,
        };
    }

    override getCapabilityProfile(): KodaXProviderCapabilityProfile {
        return cloneCapabilityProfile(CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE);
    }

    /**
     * FEATURE_134 (v0.7.40) — extension point for CLI bridges that have a
     * file-include syntax in their prompt grammar. Default implementation
     * returns `null`, which makes the prompt flatten path drop image blocks
     * silently (preserving the pre-FEATURE_134 behavior for CLIs that do
     * not accept image input — Codex CLI's `codex exec --json --full-auto`
     * mode currently has no image attachment surface).
     *
     * Subclasses that DO accept image input should override and return a
     * single-token string the CLI will resolve to file content — for
     * Gemini CLI 2.x that is `@<absolutePath>` (the `@file` reference
     * syntax inlines arbitrary file content, including images).
     *
     * Callers must pass a `block.path` that already exists on disk;
     * KodaX does not stat-check at this point because the image blocks
     * come from `KodaXImageBlock` instances that the REPL or SDK has
     * already validated (`preparePromptInputArtifacts` rewrites missing
     * images to placeholders before they ever reach this layer).
     */
    protected serializeImageBlockToPromptToken(_block: KodaXImageBlock): string | null {
        return null;
    }

    /**
     * FEATURE_116 (v0.7.37) — Strip any `cache-boundary` markers from
     * KodaXMessage content arrays before they reach the ACP CLI bridge.
     * The CLI subprocess does not understand KodaX-internal cache markers;
     * stripping at the entry point keeps the marker abstraction purely
     * client-side.
     *
     * Idempotent: messages with no boundary content return the same
     * reference.
     */
    protected stripCacheBoundariesFromMessages(
        messages: KodaXMessage[],
    ): KodaXMessage[] {
        return messages.map((m) => {
            if (typeof m.content === 'string') return m;
            const stripped = stripCacheBoundaries(m.content);
            return stripped.length === m.content.length
                ? m
                : { ...m, content: stripped };
        });
    }

    async stream(
        messages: KodaXMessage[],
        tools: KodaXToolDefinition[],
        system: string,
        reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal
    ): Promise<KodaXStreamResult> {
        const normalizedReasoning = this.normalizeReasoning(reasoning);
        const reasoningEffort = selectAcpReasoningEffort(normalizedReasoning);

        // FEATURE_116 (v0.7.37): strip boundary markers up front so the
        // CLI bridge never sees them.
        messages = this.stripCacheBoundariesFromMessages(messages);

        void tools;
        void system;

        // Pseudo-server adapters expose their executor so we can fail closed when
        // the required local CLI is missing.
        if (this.acpClientOptions.executor && typeof this.acpClientOptions.executor.isInstalled === 'function') {
            if (!await this.acpClientOptions.executor.isInstalled()) {
                throw new Error(
                    `${this.name} requires a local CLI environment, but the CLI was not found or is not configured correctly.`,
                );
            }
        }

        const textBlocks: KodaXTextBlock[] = [];
        const toolBlocks: KodaXToolUseBlock[] = [];

        // Flatten the latest KodaX message into a string because ACP prompt()
        // primarily accepts prompt blocks rather than full KodaX messages.
        // FEATURE_134 v0.7.40: image blocks are routed through the
        // `serializeImageBlockToPromptToken` extension point — subclasses with
        // an underlying CLI that understands a file-include syntax (Gemini
        // CLI's `@<path>`) override it to inject a token; the default returns
        // null which preserves the prior silent-drop behavior for CLIs that
        // have no image-input path.
        const latestMessage = messages[messages.length - 1];
        let promptText = '';
        if (latestMessage && typeof latestMessage.content === 'string') {
            promptText = latestMessage.content;
        } else if (latestMessage && Array.isArray(latestMessage.content)) {
            const parts: string[] = [];
            for (const b of latestMessage.content) {
                if (b.type === 'text') {
                    parts.push((b as KodaXTextBlock).text);
                } else if (b.type === 'image') {
                    const token = this.serializeImageBlockToPromptToken(b as KodaXImageBlock);
                    if (token) parts.push(token);
                }
            }
            promptText = parts.join('\n');
        }

        // Build client event hooks once and route updates into the active stream.
        const options: AcpClientOptions = {
            ...this.acpClientOptions,
            onSessionUpdate: (notification: any) => {
                const update = notification.update;
                const sessionId = notification.sessionId;
                if (!('sessionUpdate' in update)) return;

                const activeCtx = sessionId ? this._activeStreams.get(sessionId) : undefined;
                if (!activeCtx) return;

                switch (update.sessionUpdate) {
                    case 'agent_message_chunk':
                        if (update.content?.type === 'text') {
                            const chunk = update.content.text;
                            activeCtx.output.text += chunk;
                            activeCtx.streamOptions?.onTextDelta?.(chunk);
                        }
                        break;

                    case 'tool_call': {
                        let toolArgs = '{}';
                        const rawArgs =
                            (update as any).arguments ??
                            (update as any).parameters;
                        if (rawArgs) {
                            toolArgs = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                        }

                        activeCtx.streamOptions?.onToolInputDelta?.(update.title, toolArgs);
                        const logEntry = `\n> [Tool Use] ${update.title}: ${toolArgs}\n`;
                        activeCtx.output.text += logEntry;
                        activeCtx.streamOptions?.onTextDelta?.(logEntry);
                        break;
                    }

                    case 'tool_call_update':
                        if (update.status) {
                            const resEntry = `> [Tool Result] ${update.status}\n\n`;
                            activeCtx.output.text += resEntry;
                            activeCtx.streamOptions?.onTextDelta?.(resEntry);
                        }
                        break;
                }
            }
        };

        const kodaxSessionId = streamOptions?.sessionId ?? 'default';

        if (!this._client) {
            this._client = new AcpClient(options);
            await this._client.connect();
        }

        let acpSessionId = this._sessionMap.get(kodaxSessionId);
        if (!acpSessionId) {
            acpSessionId = await this._client.createNewSession();
            this._sessionMap.set(kodaxSessionId, acpSessionId);
        }

        const localOutput = { text: '' };
        this._activeStreams.set(acpSessionId, {
            streamOptions,
            output: localOutput
        });

        let promptResponse: Awaited<ReturnType<AcpClient['prompt']>> | undefined;

        try {
            promptResponse = await this._client.prompt(
                promptText,
                acpSessionId,
                signal,
                {
                    model: streamOptions?.modelOverride,
                    reasoningEffort,
                },
            );
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                // User cancellation is expected.
            } else {
                throw err;
            }
        } finally {
            this._activeStreams.delete(acpSessionId);
        }

        if (localOutput.text) {
            textBlocks.push({ type: 'text', text: localOutput.text });
        }

        return {
            textBlocks,
            toolBlocks,
            thinkingBlocks: [],
            usage: normalizeAcpUsage(promptResponse?.usage),
        };
    }

    /**
     * Manually close and clear the ACP connection maintained by this provider.
     */
    disconnect(): void {
        if (this._client) {
            this._client.disconnect();
            this._client = null;
        }
        this._activeStreams.clear();
        this._sessionMap.clear();
    }
}
