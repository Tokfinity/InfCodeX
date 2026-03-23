import type { KodaXMessage } from '../types.js';

/**
 * Convert KodaX messages into a plain-text prompt for CLI-backed providers.
 *
 * When resuming an existing CLI session, we only send the latest user message
 * because the CLI already owns the prior conversational context.
 */
export function buildCLIPrompt(messages: KodaXMessage[], isResuming: boolean): string {
    const parts: string[] = [];

    // For resumed CLI sessions, only forward the latest user message.
    const msgsToProcess = isResuming && messages.length > 0
        ? [messages[messages.length - 1]!]
        : messages;

    for (const msg of msgsToProcess) {
        if (typeof msg.content === 'string') {
            parts.push(msg.content);
        } else {
            const text = msg.content
                .filter(b => b.type === 'text')
                .map(b => (b as { text: string }).text)
                .join('\n');
            if (text) {
                parts.push(text);
            }
        }
    }

    return parts.join('\n\n');
}
