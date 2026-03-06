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

  // 4. 提取文件操作
  const fileOps = extractFileOps(toCompact);

  // 5. 生成 LLM 摘要（传入 systemPrompt 和 previousSummary 支持多轮压缩）
  const summary = await generateSummary(
    toCompact,
    provider,
    fileOps,
    customInstructions,
    systemPrompt,
    previousSummary
  );

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
    details: fileOps,
  };
}

/**
 * 找到切割点
 *
 * 从最新消息往前累加，直到达到 keepRecentTokens
 * 确保不在 tool_result 处切割（必须与对应的 tool_use 在一起）
 *
 * 参考 pi-mono 的实现：
 * - 可以在 user 或 assistant 消息处切割
 * - 如果在 assistant 消息处切割，它的 tool_result 会跟随它
 * - 永远不在 tool_result 处切割
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
  const validCutPoints: number[] = [];

  // 1. 从后往前找到所有有效切割点
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    // user 和 assistant 消息是有效切割点
    // 注意：system 消息通常在开头，不应该作为切割点
    if (msg.role === 'user' || msg.role === 'assistant') {
      validCutPoints.push(i);
    }
  }

  // 2. 从最新消息往前累加，找到第一个超过预算的位置
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    tokenCount += estimateTokens([msg]);

    if (tokenCount > keepRecentTokens) {
      // 找到第一个 >= i 的有效切割点
      const cutPoint = validCutPoints.find(cp => cp >= i);
      if (cutPoint !== undefined) {
        return cutPoint;
      }
      // 如果没有找到 >= i 的切割点，使用最大的（最靠前的）有效切割点
      if (validCutPoints.length > 0) {
        return validCutPoints[validCutPoints.length - 1];
      }
      // 如果完全没有有效切割点，返回 0（保留所有消息）
      return 0;
    }
  }

  // 所有消息都需要保留
  return 0;
}

