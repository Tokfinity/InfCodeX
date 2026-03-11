import { KodaXAcpProvider } from './acp-base.js';
import { CodexCLIExecutor } from '../cli-events/codex-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';

export class KodaXCodexCliProvider extends KodaXAcpProvider {
    readonly name = 'codex-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'CODEX_CLI_API_KEY', // Dummy, not used but required by base
        model: 'codex',
        supportsThinking: false,
        contextWindow: 128000,
    };

    protected readonly acpClientOptions: AcpClientOptions;

    constructor() {
        super();
        const executor = new CodexCLIExecutor();
        this.acpClientOptions = createPseudoAcpServer(executor, this.config.model);
    }
}
