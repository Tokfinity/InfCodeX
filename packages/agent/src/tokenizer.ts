/**
 * @kodax/agent Tokenizer
 *
 * Token 估算 - 使用 tiktoken 进行精确计算
 */

import { getEncoding, Tiktoken } from 'js-tiktoken';
import type { KodaXMessage, KodaXContentBlock } from '@kodax/ai';

// 使用 cl100k_base 编码（Claude/GPT-4 通用）
// 懒加载，只在第一次使用时初始化
let _encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base');
  }
  return _encoder;
}

/**
 * 计算文本的 token 数量
 */
function countTextTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * 估算消息的 token 数量
 *
 * 精确计算包括：
 * - 消息结构开销（每条约 4 tokens）
 * - 角色标识
 * - 内容文本
 * - 工具调用和结果
 */
export function estimateTokens(messages: KodaXMessage[]): number {
  let total = 0;

  for (const m of messages) {
    // 消息结构开销（role, content 包装等）
    total += 4;

    if (typeof m.content === 'string') {
      total += countTextTokens(m.content);
    } else {
      // 内容块数组
      for (const block of m.content as KodaXContentBlock[]) {
        if (block.type === 'text') {
          total += countTextTokens(block.text);
        } else if (block.type === 'tool_use') {
          // 工具调用：名称 + 输入 JSON
          total += countTextTokens(block.name);
          total += countTextTokens(JSON.stringify(block.input));
        } else if (block.type === 'tool_result') {
          // 工具结果
          total += 4; // tool_use_id 引用开销
          total += countTextTokens(block.content);
        } else if (block.type === 'thinking') {
          // 思考块
          total += countTextTokens(block.thinking);
        }
      }
    }
  }

  return total;
}

/**
 * 计算单个文本的 token 数量（便捷函数）
 */
export function countTokens(text: string): number {
  return countTextTokens(text);
}
