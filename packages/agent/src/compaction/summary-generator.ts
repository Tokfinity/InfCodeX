/**
 * @kodax/agent Compaction Summary Generator
 *
 * LLM 摘要生成器 - 使用 LLM 生成结构化摘要
 */

import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';
import type { CompactionDetails } from './types.js';
import { serializeConversation } from './utils.js';

/**
 * 系统提示 - 明确说明这是摘要任务，不是继续对话
 * 参考 pi-mono 的 SUMMARIZATION_SYSTEM_PROMPT
 */
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * 初始摘要 Prompt 模板
 */
const SUMMARY_PROMPT = `请为以下对话生成结构化摘要。

**重要**: 这是一个历史对话摘要任务，不要继续对话，只生成摘要。

输出格式 (必须严格遵循 markdown 格式):

## 目标
[用户想要完成什么 - 1-2句话简洁描述]

## 约束与偏好
- [用户提到的要求和偏好，每条一行]
- [如果没有明确约束，写"无特殊约束"]

## 进度
### 已完成
- [x] [已完成的任务列表，每条一行]

### 进行中
- [ ] [当前正在进行的工作]

### 阻塞
- [遇到的问题，如果没有则写"无阻塞"]

## 关键决策
- **[决策名称]**: [做出这个决策的理由]

## 下一步
1. [接下来应该做什么，按优先级排序]

## 关键上下文
- [继续工作需要的代码片段、文件路径、配置等关键信息]

---

<read-files>
[列出对话中读取过的文件路径，每行一个，如果没有则留空]
</read-files>

<modified-files>
[列出对话中修改过的文件路径，每行一个，如果没有则留空]
</modified-files>

---

对话内容:
`;

/**
 * 更新摘要 Prompt 模板 - 用于多轮压缩
 * 参考 pi-mono 的 UPDATE_SUMMARIZATION_PROMPT
 */
const UPDATE_SUMMARY_PROMPT = `上面的消息是新的对话内容，需要合并到 <previous-summary> 中提供的现有摘要中。

更新现有的结构化摘要。规则：
- 保留所有现有信息
- 添加新的进度、决策和上下文
- 更新"进度"部分：完成时将项目从"进行中"移到"已完成"
- 根据完成的工作更新"下一步"
- 保留确切的文件路径、函数名和错误消息
- 如果某些内容不再相关，可以删除

输出格式 (必须严格遵循 markdown 格式):

## 目标
[保留现有目标，如果任务扩展则添加新目标]

## 约束与偏好
- [保留现有的，添加新发现的]

## 进度
### 已完成
- [x] [包含之前完成的项目 AND 新完成的项目]

### 进行中
- [ ] [当前工作 - 根据进度更新]

### 阻塞
- [当前阻塞 - 如果已解决则删除]

## 关键决策
- **[决策]**: [简要理由] (保留所有之前的，添加新的)

## 下一步
1. [根据当前状态更新]

## 关键上下文
- [保留重要上下文，如果需要则添加新的]

---

<read-files>
[列出对话中读取过的文件路径，每行一个，如果没有则留空]
</read-files>

<modified-files>
[列出对话中修改过的文件路径，每行一个，如果没有则留空]
</modified-files>

保持每个部分简洁。保留确切的文件路径、函数名和错误消息。`;

/**
 * 生成结构化摘要
 *
 * @param messages - 待摘要的消息列表
 * @param provider - LLM Provider
 * @param details - 文件操作详情
 * @param customInstructions - 自定义指令（可选）
 * @param systemPrompt - 项目的系统提示（可选）
 * @param previousSummary - 之前的摘要（用于多轮压缩，可选）
 * @returns 生成的摘要文本
 */
export async function generateSummary(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  details: CompactionDetails,
  customInstructions?: string,
  systemPrompt?: string,
  previousSummary?: string
): Promise<string> {
  // 序列化对话
  const conversationText = serializeConversation(messages);

  // 选择合适的 prompt 模板
  let basePrompt = previousSummary ? UPDATE_SUMMARY_PROMPT : SUMMARY_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\n额外关注: ${customInstructions}`;
  }

  // 构建完整的 prompt
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  // 添加文件追踪信息
  promptText += `\n\n---\n文件追踪信息:\n`;
  promptText += `读取过的文件: ${details.readFiles.length > 0 ? details.readFiles.join(', ') : '无'}\n`;
  promptText += `修改过的文件: ${details.modifiedFiles.length > 0 ? details.modifiedFiles.join(', ') : '无'}\n`;

  // 调用 LLM 生成摘要
  // 使用空 tools 列表，禁用 thinking，使用默认 model
  const result = await provider.stream(
    [{ role: 'user', content: promptText }],
    [], // no tools
    systemPrompt || SUMMARIZATION_SYSTEM_PROMPT, // 使用传入的 system prompt 或默认
    false, // no thinking
    undefined,
    undefined
  );

  // 提取文本
  const summary = result.textBlocks.map(b => b.text).join('\n');

  return summary;
}
