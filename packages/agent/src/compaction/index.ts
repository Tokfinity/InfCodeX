/**
 * @kodax/agent Compaction Module
 *
 * 上下文压缩模块 - 智能摘要与文件追踪
 */

// Types
export type {
  CompactionConfig,
  CompactionDetails,
  CompactionResult,
  FileOperations,
} from './types.js';

// File Tracking
export { extractFileOps, mergeFileOps } from './file-tracker.js';

// Utils
export { serializeConversation } from './utils.js';

// Summary Generator
export { generateSummary } from './summary-generator.js';

// Compaction Core
export { needsCompaction, compact } from './compaction.js';
