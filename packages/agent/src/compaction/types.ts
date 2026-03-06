/**
 * @kodax/agent Compaction Types
 *
 * 上下文压缩相关类型定义
 */

import type { KodaXMessage } from '@kodax/ai';

/**
 * 压缩配置
 */
export interface CompactionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** 触发压缩的阈值百分比 (0-100)，例如 75 表示使用 75% 上下文时触发 */
  triggerPercent: number;
  /** 保留最近消息的百分比 (0-100)。例如 10 表示保留最近 10% 的消息 */
  keepRecentPercent: number;
  /** (可选) 覆盖 Provider 的 contextWindow */
  contextWindow?: number;
}

/**
 * 压缩详情
 *
 * 记录压缩过程中追踪的文件操作
 */
export interface CompactionDetails {
  /** 读取过的文件路径列表 */
  readFiles: string[];
  /** 修改过的文件路径列表 */
  modifiedFiles: string[];
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否执行了压缩 */
  compacted: boolean;
  /** 压缩后的消息列表 */
  messages: KodaXMessage[];
  /** 生成的摘要文本（如果执行了压缩） */
  summary?: string;
  /** 压缩前的 token 数 */
  tokensBefore: number;
  /** 压缩后的 token 数 */
  tokensAfter: number;
  /** 移除的消息数量 */
  entriesRemoved: number;
  /** 压缩详情（如果执行了压缩） */
  details?: CompactionDetails;
}

/**
 * 文件操作记录
 *
 * 从消息中提取的文件操作集合
 */
export interface FileOperations {
  /** 读取过的文件路径列表 */
  readFiles: string[];
  /** 修改过的文件路径列表 */
  modifiedFiles: string[];
}
