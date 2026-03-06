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
 * @param customInstructions - 自定义指令（可选）
 * @returns 压缩结果
 */
export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string
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

  // 1. 找到切割点 (保留 keepRecentPercent)
  const keepTokens = Math.floor(contextWindow * (config.keepRecentPercent / 100));
  const cutIndex = findCutPoint(messages, keepTokens);

  // 2. 提取待压缩消息
  const toCompact = messages.slice(0, cutIndex);
  const toKeep = messages.slice(cutIndex);

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

  // 3. 提取文件操作
  const fileOps = extractFileOps(toCompact);

  // 4. 生成 LLM 摘要
  const summary = await generateSummary(
    toCompact,
    provider,
    fileOps,
    customInstructions
  );

  // 5. 构建新消息历史
  const summaryMessage: KodaXMessage = {
    role: 'user',
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
 * @param messages - 消息列表
 * @param keepRecentTokens - 保留的最近 token 数
 * @returns 切割点索引
 */
function findCutPoint(
  messages: KodaXMessage[],
  keepRecentTokens: number
): number {
  let tokenCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    tokenCount += estimateTokens([msg]);

    if (tokenCount > keepRecentTokens) {
      // 检查是否是有效的切割点
      if (isValidCutPoint(messages, i)) {
        return i;
      }
      // 否则继续往前找
    }
  }

  // 所有消息都需要保留
  return 0;
}

/**
 * 检查是否是有效的切割点
 *
 * 不能在 tool_result 处切割（必须与前一条 assistant 的 tool_use 在一起）
 *
 * @param messages - 消息列表
 * @param index - 候选切割点索引
 * @returns 是否有效
 */
function isValidCutPoint(messages: KodaXMessage[], index: number): boolean {
  const msg = messages[index];
  if (!msg) return false;

  // user 消息可能包含 tool_result，需要检查
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    const hasToolResult = msg.content.some(b => b.type === 'tool_result');
    if (hasToolResult) {
      // 检查前一条是否是 assistant with tool_use
      if (index > 0) {
        const prev = messages[index - 1];
        if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
          const hasToolUse = prev.content.some(b => b.type === 'tool_use');
          if (hasToolUse) {
            return false; // 不能在这里切割，tool_result 必须与 tool_use 在一起
          }
        }
      }
    }
  }

  return true;
}
