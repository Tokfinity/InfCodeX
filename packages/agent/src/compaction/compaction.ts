/**
 * @kodax/agent Compaction Core
 *
 * 核心压缩逻辑 - 检测并执行上下文压缩
 */

import type { KodaXMessage, KodaXBaseProvider } from '@kodax/ai';
import type { CompactionConfig, CompactionResult } from './types.js';
import { estimateTokens } from '../tokenizer.js';
import { extractFileOps } from './file-tracker.js';
import { generateSummary } from './summary-generator.js';

/**
 * 默认上下文窗口大小
 *
 * Claude 3.5 Sonnet: 200,000 tokens
 */
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * 检查是否需要压缩
 *
 * 触发条件: contextTokens > contextWindow * triggerPercent / 100
 *
 * @param messages - 消息列表
 * @param config - 压缩配置
 * @param contextWindow - 上下文窗口大小（默认 200k）
 * @returns 是否需要压缩
 */
export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW
): boolean {
  if (!config.enabled) return false;

  const tokens = estimateTokens(messages);
  const threshold = contextWindow * (config.triggerPercent / 100);
  return tokens > threshold;
}

/**
 * 执行压缩
 *
 * @param messages - 消息列表
 * @param config - 压缩配置
 * @param provider - LLM Provider
 * @param contextWindow - 上下文窗口大小
 * @param customInstructions - 自定义指令（可选）
 * @param systemPrompt - 项目的系统提示（可选，用于生成更好的摘要）
 * @returns 压缩结果
 */
export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string
): Promise<CompactionResult> {
  const tokensBefore = estimateTokens(messages);

  // 检查是否需要压缩
  if (!needsCompaction(messages, config, contextWindow)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  // 1. 提取之前的摘要（用于多轮压缩）
  let previousSummary: string | undefined;
  let messagesWithoutOldSummary = messages;

  // 查找最近的 system 摘要消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[对话历史摘要]')) {
      previousSummary = msg.content.replace('[对话历史摘要]\n\n', '');
      messagesWithoutOldSummary = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  // 2. 找到切割点 (保留 keepRecentPercent)
  const keepTokens = Math.floor(contextWindow * (config.keepRecentPercent / 100));
  const cutIndex = findCutPoint(messagesWithoutOldSummary, keepTokens);

  // 3. 提取待压缩消息
  const toCompact = messagesWithoutOldSummary.slice(0, cutIndex);
  const toKeep = messagesWithoutOldSummary.slice(cutIndex);

  // 边界情况：没有消息需要压缩
  if (toCompact.length === 0) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  // 4. 提取整体文件操作（用于最终返回和统计）
  const totalFileOps = extractFileOps(toCompact);

  // 5. 生成 LLM 摘要（传入 systemPrompt 和 previousSummary 支持多轮压缩）
  // 引入分块逻辑，按 MAX_TOKENS_PER_CHUNK 拆分，避免单一请求过大触发 429 Rate Limit
  const MAX_TOKENS_PER_CHUNK = 50000;
  let summary = previousSummary || '';

  if (toCompact.length > 0) {
    const chunks = chunkMessages(toCompact, MAX_TOKENS_PER_CHUNK);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length === 0) continue;

      // 取出当前 chunk 的独立文件操作，以免向 LLM 传递属于未来 chunk 的剧透文件信息
      const chunkFileOps = extractFileOps(chunk);

      const chunkSummary = await generateSummary(
        chunk,
        provider,
        chunkFileOps, // 传递当前被压缩片段的文件追踪
        customInstructions,
        systemPrompt,
        summary !== '' ? summary : undefined
      );

      summary = chunkSummary;

      // 非最后一块时，暂缓 2 秒以避免连续请求再次引发 TPM 限制
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // 6. 构建新消息历史
  // 使用 'system' role 明确表示这是历史摘要，而非用户输入
  const summaryMessage: KodaXMessage = {
    role: 'system',
    content: `[对话历史摘要]\n\n${summary}`,
  };

  const compactedMessages = [summaryMessage, ...toKeep];
  const tokensAfter = estimateTokens(compactedMessages);

  return {
    compacted: true,
    messages: compactedMessages,
    summary,
    tokensBefore,
    tokensAfter,
    entriesRemoved: toCompact.length,
    details: totalFileOps,
  };
}

/**
 * 找到切割点
 *
 * 从最新消息往前累加，直到达到 keepRecentTokens
 * CRITICAL: 确保 tool_use 和 tool_result 不被拆散
 *
 * 原子块规则：
 * 1. 普通 user message = 独立块
 * 2. 普通 assistant message = 独立块
 * 3. assistant(含 tool_use) + 下一条 user(含 tool_result) = 原子块，不可拆分
 *
 * @param messages - 消息列表
 * @param keepRecentTokens - 保留的最近 token 数
 * @returns 切割点索引（如果找不到有效切割点返回 0）
 */
function findCutPoint(
  messages: KodaXMessage[],
  keepRecentTokens: number
): number {
  let tokenCount = 0;

  // 1. 识别所有原子块的边界
  const atomicBlocks: Array<{ start: number; end: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // 检查当前 assistant 消息是否包含 tool_use
    const hasToolUse = msg.role === 'assistant' &&
      Array.isArray(msg.content) &&
      msg.content.some((b: any) => b?.type === 'tool_use');

    if (hasToolUse) {
      // 检查下一条是否是 user 且包含 tool_result
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user' &&
        Array.isArray(nextMsg.content) &&
        nextMsg.content.some((b: any) => b?.type === 'tool_result');

      if (hasNextToolResult) {
        // assistant(tool_use) + user(tool_result) = 原子块
        const tokens = estimateTokens([msg, nextMsg]);
        atomicBlocks.push({ start: i, end: i + 1, tokens });
        i++; // 跳过下一条
        continue;
      }
    }

    // 普通消息 = 独立块
    const tokens = estimateTokens([msg]);
    atomicBlocks.push({ start: i, end: i, tokens });
  }

  // 2. 从后往前累加，找到第一个超过预算的原子块边界
  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;

    if (tokenCount > keepRecentTokens) {
      // 返回这个原子块的起始位置作为切割点
      return block.start;
    }
  }

  // 所有消息都需要保留
  return 0;
}

/**
 * 将消息按 Token 和原子块限制拆分为多个分块
 * 这是为了避免一次性产生超长 payload 触发大模型 TPM Rate Limit (429)
 *
 * @param messages - 待分块的消息列表
 * @param maxTokensPerChunk - 每个分块的最大 token 容量
 * @returns 拆分后的分块数组
 */
function chunkMessages(messages: KodaXMessage[], maxTokensPerChunk: number): KodaXMessage[][] {
  const chunks: KodaXMessage[][] = [];
  let currentChunk: KodaXMessage[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    let group: KodaXMessage[] = [msg];

    // 原子块检查逻辑（同 findCutPoint 保持一致）
    const hasToolUse = msg.role === 'assistant' &&
      Array.isArray(msg.content) &&
      msg.content.some((b: any) => b?.type === 'tool_use');

    if (hasToolUse) {
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user' &&
        Array.isArray(nextMsg.content) &&
        nextMsg.content.some((b: any) => b?.type === 'tool_result');

      if (hasNextToolResult) {
        group = [msg, nextMsg]; // 绑定为不可分割的原子块
        i++; // 消耗下一条
      }
    }

    const groupTokens = estimateTokens(group);

    // 如果加入当前组会超过最大分块限制，并且当前 chunk 不为空，则新起一个 chunk
    // 即使单个 group 超过了 maxSize，也只能硬着头皮放入新 chunk 中（不能拆散块）
    if (currentTokens + groupTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
      currentTokens = groupTokens;
    } else {
      currentChunk.push(...group);
      currentTokens += groupTokens;
    }
  }

  // 推入最后一个 chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

