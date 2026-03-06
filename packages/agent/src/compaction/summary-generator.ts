/**
 * @kodax/agent Compaction Summary Generator
 *
 * LLM 摘要生成器 - 使用 LLM 生成结构化摘要
 */

import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';
import type { CompactionDetails } from './types.js';
import { serializeConversation } from './utils.js';

/**
 * 摘要生成 Prompt 模板
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
 * 生成结构化摘要
 *
 * @param messages - 待摘要的消息列表
 * @param provider - LLM Provider
 * @param details - 文件操作详情
 * @param customInstructions - 自定义指令（可选）
 * @returns 生成的摘要文本
 */
export async function generateSummary(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  details: CompactionDetails,
  customInstructions?: string
): Promise<string> {
  // 序列化对话
  const conversationText = serializeConversation(messages);

  // 构建提示
  let prompt = SUMMARY_PROMPT + conversationText;

  // 添加文件追踪信息
  prompt += `\n\n---\n文件追踪信息:\n`;
  prompt += `读取过的文件: ${details.readFiles.length > 0 ? details.readFiles.join(', ') : '无'}\n`;
  prompt += `修改过的文件: ${details.modifiedFiles.length > 0 ? details.modifiedFiles.join(', ') : '无'}\n`;

  // 添加自定义指令
  if (customInstructions) {
    prompt += `\n---\n额外指令: ${customInstructions}\n`;
  }

  // 调用 LLM 生成摘要
  // 使用空 tools 列表，禁用 thinking，使用默认 model
  const result = await provider.stream(
    [{ role: 'user', content: prompt }],
    [], // no tools
    '', // no system prompt
    false, // no thinking
    undefined,
    undefined
  );

  // 提取文本
  const summary = result.textBlocks.map(b => b.text).join('\n');

  return summary;
}
