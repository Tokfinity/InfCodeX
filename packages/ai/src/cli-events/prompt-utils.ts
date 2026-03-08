import type { KodaXMessage } from '../types.js';

/**
 * 将 KodaX 消息数组解析成纯文本 Prompt 传给 CLI
 *
 * 如果是 resume 模式（CLI 已有上下文），只发送最新一条 user 消息；
 * 否则将全部消息扁平化为文本。
 */
export function buildCLIPrompt(messages: KodaXMessage[], isResuming: boolean): string {
    const parts: string[] = [];

    // 如果已经在 CLI 态，CLI 知道之前的上下文，所以我们只需发送最新的一条 user 消息
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
