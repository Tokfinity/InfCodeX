import { KodaXAcpProvider } from './acp-base.js';
import { GeminiCLIExecutor } from '../cli-events/gemini-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';
import { getGeminiCliDefaultModel, getGeminiCliKnownModels } from './cli-bridge-models.js';
import type {
    KodaXImageBlock,
    KodaXProviderCapabilityProfile,
} from '../types.js';
import { cloneCapabilityProfile } from './capability-profile.js';

const DEFAULT_GEMINI_MODEL = getGeminiCliDefaultModel();
const GEMINI_MODELS = getGeminiCliKnownModels();

// FEATURE_134 v0.7.40 — Gemini CLI 2.x supports `@<path>` file-include
// references in the prompt grammar (any file the CLI's working-dir tree can
// read, including images). Surface a capability profile that mirrors the
// CLI-bridge baseline but advertises image input, so downstream policy
// checks know vision input is viable on this bridge.
const GEMINI_CLI_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
    transport: 'cli-bridge',
    conversationSemantics: 'last-user-message',
    mcpSupport: 'none',
    contextFidelity: 'lossy',
    toolCallingFidelity: 'limited',
    sessionSupport: 'stateless',
    longRunningSupport: 'limited',
    multimodalSupport: 'image-input',
    evidenceSupport: 'limited',
};

export class KodaXGeminiCliProvider extends KodaXAcpProvider {
    readonly name = 'gemini-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'GEMINI_CLI_API_KEY', // Dummy, not used but required by base
        model: DEFAULT_GEMINI_MODEL,
        models: GEMINI_MODELS
            .filter((model) => model !== DEFAULT_GEMINI_MODEL)
            .map((model) => ({ id: model, displayName: model })),
        supportsThinking: false,
        reasoningCapability: 'prompt-only',
        contextWindow: 1048576, // Gemini 1M context
    };

    protected readonly acpClientOptions: AcpClientOptions;

    constructor() {
        super();
        const executor = new GeminiCLIExecutor({ model: DEFAULT_GEMINI_MODEL });
        this.acpClientOptions = createPseudoAcpServer(executor);
    }

    override getCapabilityProfile(): KodaXProviderCapabilityProfile {
        return cloneCapabilityProfile(GEMINI_CLI_CAPABILITY_PROFILE);
    }

    protected override serializeImageBlockToPromptToken(block: KodaXImageBlock): string | null {
        // Gemini CLI's `@<path>` syntax inlines arbitrary file content.
        // The REPL paste pipeline writes to `$TMPDIR/kodax-paste/paste-<hex>.ext`
        // (space-free by construction); SDK callers SHOULD pass absolute,
        // space-free paths.
        //
        // Defensive: if a caller passes a path containing whitespace, the
        // Gemini CLI prompt tokenizer will split the `@<path>` reference
        // at the first space, silently resolving to a non-existent file —
        // worse than dropping the image entirely. So we fail loud (warn
        // + drop) rather than emit a broken token. Use the bracket-quote
        // form if Gemini CLI adds support in the future.
        if (/\s/.test(block.path)) {
            // eslint-disable-next-line no-console
            console.warn(
                `[gemini-cli] Image path contains whitespace and cannot be safely passed via @<path> syntax — dropping image block. Path: ${JSON.stringify(block.path)}`,
            );
            return null;
        }
        return `@${block.path}`;
    }
}
