/**
 * @kodax/agent File Tracking
 *
 * 从消息中提取文件操作
 */

import type { KodaXMessage, KodaXContentBlock, KodaXToolUseBlock } from '@kodax/ai';
import type { FileOperations } from './types.js';

/**
 * 从消息中提取文件操作
 *
 * 分析 tool_use 块，记录 read/write/edit 操作
 *
 * @param messages - 消息列表
 * @returns 文件操作记录
 */
export function extractFileOps(messages: KodaXMessage[]): FileOperations {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  for (const msg of messages) {
    // 只处理包含 content block 的消息
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      // 只处理 tool_use 块
      if (!isToolUseBlock(block)) continue;

      const input = block.input as Record<string, unknown>;

      // read 操作
      if (block.name === 'read' && typeof input.path === 'string') {
        readFiles.add(input.path);
      }
      // write 操作
      else if (block.name === 'write' && typeof input.path === 'string') {
        modifiedFiles.add(input.path);
      }
      // edit 操作
      else if (block.name === 'edit' && typeof input.path === 'string') {
        modifiedFiles.add(input.path);
      }
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
  };
}

/**
 * 合并文件操作 (用于累积追踪)
 *
 * 当多次压缩时，合并历史文件操作记录
 *
 * @param ops1 - 第一次文件操作
 * @param ops2 - 第二次文件操作
 * @returns 合并后的文件操作
 */
export function mergeFileOps(
  ops1: FileOperations,
  ops2: FileOperations
): FileOperations {
  return {
    readFiles: [...new Set([...ops1.readFiles, ...ops2.readFiles])],
    modifiedFiles: [...new Set([...ops1.modifiedFiles, ...ops2.modifiedFiles])],
  };
}

/**
 * 类型守卫：检查是否为 tool_use 块
 */
function isToolUseBlock(block: KodaXContentBlock): block is KodaXToolUseBlock {
  return block.type === 'tool_use';
}
