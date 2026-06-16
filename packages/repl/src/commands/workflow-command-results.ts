import { existsSync, readFileSync } from 'node:fs';

import type {
  WorkflowApprovalSummary,
  WorkflowArtifactRef,
  WorkflowEvent,
} from '@kodax-ai/agent';

const MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS = 4;
const MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS = 180;
const MAX_WORKFLOW_RESULT_PREVIEW_CHARS = 6000;
const MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS = 360;
const WORKFLOW_RESULT_TRUNCATED_MARKER = '[truncated]';

export type WorkflowRunPresentation = 'command' | 'agentic';
export type WorkflowRunLocale = 'en' | 'zh';

export interface WorkflowResultFormatOptions {
  readonly full?: boolean;
}

export function detectWorkflowLocale(text: string): WorkflowRunLocale {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en';
}

export function inferWorkflowLocaleFromParts(
  ...parts: readonly (string | undefined)[]
): WorkflowRunLocale {
  return detectWorkflowLocale(parts.filter((part): part is string => typeof part === 'string').join('\n'));
}

function trimResultPreview(text: string, options: WorkflowResultFormatOptions = {}): string {
  const trimmed = text.trim();
  if (options.full === true) return trimmed;
  if (trimmed.length <= MAX_WORKFLOW_RESULT_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_WORKFLOW_RESULT_PREVIEW_CHARS).trimEnd()}\n\n${WORKFLOW_RESULT_TRUNCATED_MARKER}`;
}

export function isWorkflowResultPreviewTruncated(text: string): boolean {
  return text.includes(WORKFLOW_RESULT_TRUNCATED_MARKER);
}

function formatWorkflowResultTruncationHint(runId: string, locale: WorkflowRunLocale): string {
  return locale === 'zh'
    ? `[结果预览已截断。完整结果请用 /workflow show --full ${runId} 查看；artifact 文件也保存在本次 run 目录。]`
    : `[Result preview truncated. Use /workflow show --full ${runId} for the complete result; artifacts are also saved in the run directory.]`;
}

export function replaceWorkflowResultTruncationMarker(
  text: string,
  runId: string,
  locale: WorkflowRunLocale,
): string {
  const index = text.lastIndexOf(WORKFLOW_RESULT_TRUNCATED_MARKER);
  if (index < 0) return text;
  return `${text.slice(0, index).trimEnd()}\n\n${formatWorkflowResultTruncationHint(runId, locale)}`;
}

function trimWorkflowLaunchSummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS).trimEnd()}...`;
}

export function formatResult(
  result: unknown,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  if (typeof result === 'string' && result.trim().length > 0) {
    return trimResultPreview(result, options);
  }
  if (result && typeof result === 'object' && 'synthesis' in result) {
    const synthesis = (result as { synthesis?: unknown }).synthesis;
    if (typeof synthesis === 'string' && synthesis.trim().length > 0) {
      return trimResultPreview(synthesis, options);
    }
    if (synthesis && typeof synthesis === 'object' && 'text' in synthesis) {
      const text = (synthesis as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) return trimResultPreview(text, options);
    }
  }
  if (result && typeof result === 'object') {
    for (const key of ['summary', 'report', 'text', 'result']) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return trimResultPreview(value, options);
      }
    }
  }
  // FEATURE_217 — fallback: render any other non-empty value (plain object /
  // array / number / boolean) as readable JSON so a workflow that returns an
  // unrecognized-but-non-empty shape still produces a VISIBLE final answer
  // instead of a content-free "completed" with no body. This keeps the
  // build-time source lint and this runtime formatter in agreement: a
  // non-trivial run() return is displayable. Empty `{}` / `[]` and
  // null/undefined still fall through to the no-result contract path.
  if (result !== undefined && result !== null) {
    try {
      const json = JSON.stringify(result, null, 2);
      if (typeof json === 'string') {
        const trimmed = json.trim();
        if (trimmed.length > 0 && trimmed !== '{}' && trimmed !== '[]' && trimmed !== '""') {
          return trimResultPreview(json, options);
        }
      }
    } catch {
      // Non-serializable (e.g. circular) — fall through to the no-result path.
    }
  }
  return undefined;
}

export function formatFinalEventSummary(
  events: readonly WorkflowEvent[],
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  const completed = [...events]
    .reverse()
    .filter((event) => event.type === 'agent_completed' && readEventString(event, 'status') === 'completed');
  const synthesis = completed.find((event) => readEventString(event, 'name') === 'synthesize');
  const event = synthesis ?? completed[0];
  const summary = event ? readEventString(event, 'summary') : undefined;
  return summary ? trimResultPreview(summary, options) : undefined;
}

function formatArtifactPreview(
  artifact: WorkflowArtifactRef,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  if (!artifact.path || !existsSync(artifact.path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifact.path, 'utf8'));
    const text = formatResult(parsed, options);
    if (text) return text;
    const json = JSON.stringify(parsed, null, 2);
    return typeof json === 'string' && json.trim().length > 0
      ? trimResultPreview(json, options)
      : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `artifact preview unavailable: ${message}`;
  }
}

export function formatArtifactResult(
  artifacts: readonly WorkflowArtifactRef[],
  locale: WorkflowRunLocale,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!artifact) continue;
    const preview = formatArtifactPreview(artifact, options);
    if (preview) {
      return locale === 'zh'
        ? `产物 ${artifact.name}:\n${preview}`
        : `Artifact ${artifact.name}:\n${preview}`;
    }
  }
  if (artifacts.length === 0) return undefined;
  const names = artifacts.map((artifact) => artifact.name).join(', ');
  return locale === 'zh'
    ? `已生成产物: ${names}`
    : `Artifacts created: ${names}`;
}

export function formatWorkflowCompletionAnswer(input: {
  readonly runId: string;
  readonly totalSpawned: number;
  readonly resultText?: string;
  readonly locale: WorkflowRunLocale;
  readonly isFallbackPreview?: boolean;
}): string {
  const displayResultText = input.resultText
    ? replaceWorkflowResultTruncationMarker(input.resultText, input.runId, input.locale)
    : undefined;
  if (input.locale === 'zh') {
    const header = input.resultText && input.isFallbackPreview !== true
      ? `Workflow 已完成（${input.totalSpawned} 个智能体，run ${input.runId}）。`
      : `Workflow 运行结束，但结果契约失败（${input.totalSpawned} 个智能体，run ${input.runId}）。`;
    if (displayResultText) {
      const label = input.isFallbackPreview === true
        ? '结果契约异常：workflow 运行结束，但没有返回完整最终结果。以下是最后综合输出：'
        : '最终结果：';
      return `${header}\n\n${label}\n\n${displayResultText}`;
    }
    return [
      header,
      '',
      '这次 workflow 运行结束，但生成脚本违反结果契约：没有返回可直接展示的最终结果或可预览产物。这不是正常完成状态，需要修复生成脚本后重新运行。',
    ].join('\n');
  }

  const header = input.resultText && input.isFallbackPreview !== true
    ? `Workflow completed (${input.totalSpawned} agents, run ${input.runId}).`
    : `Workflow ended with a result contract failure (${input.totalSpawned} agents, run ${input.runId}).`;
  if (displayResultText) {
    const label = input.isFallbackPreview === true
      ? 'Result contract violation: the workflow ended without returning a complete final result. Last synthesis output:'
      : 'Final result:';
    return `${header}\n\n${label}\n\n${displayResultText}`;
  }
  return [
    header,
    '',
    'The workflow ended, but the generated script violated the result contract: it did not return displayable final text or a previewable artifact. This is not a normal completion state; fix the generated script and rerun it.',
  ].join('\n');
}

export function formatWorkflowLaunchAnswer(input: {
  readonly runId: string;
  readonly summary: WorkflowApprovalSummary;
  readonly approvalSummary: string;
  readonly locale: WorkflowRunLocale;
}): string {
  const phases = input.summary.phases.length > 0
    ? input.summary.phases.join(' -> ')
    : 'dynamic';
  const maxAgents = input.summary.maxAgents === null ? 'unbounded' : String(input.summary.maxAgents);
  const agentScale = input.summary.plannedAgents === undefined
    ? input.locale === 'zh'
      ? `最多 ${maxAgents} 个智能体`
      : `up to ${maxAgents} agents`
    : input.locale === 'zh'
      ? `计划约 ${input.summary.plannedAgents} 个智能体，安全上限 ${maxAgents}`
      : `about ${input.summary.plannedAgents} planned agents, safety cap ${maxAgents}`;
  const maxConcurrency = input.summary.maxConcurrency === null
    ? 'unbounded'
    : String(input.summary.maxConcurrency);
  const plan = trimWorkflowLaunchSummary(input.approvalSummary);
  if (input.locale === 'zh') {
    const writePolicy = input.summary.writesFiles
      ? '如需写文件，仍会经过正常权限确认。'
      : '这是只读探查，不会主动修改文件。';
    return [
      `我会用 workflow 做这次任务，已启动 ${input.summary.name}（${input.runId}）。`,
      `计划：${plan}`,
      `阶段：${phases}；规模：${agentScale}，并发 ${maxConcurrency}。${writePolicy}`,
      '运行过程会在下方动态更新，完成后我会直接汇总结论。',
    ].join('\n');
  }
  const writePolicy = input.summary.writesFiles
    ? 'File-writing work still goes through normal permission gates.'
    : 'This is read-only and will not modify files.';
  return [
    `I will use a workflow for this task: ${input.summary.name} (${input.runId}).`,
    `Plan: ${plan}`,
    `Phases: ${phases}; scale: ${agentScale}, ${maxConcurrency} concurrent. ${writePolicy}`,
    'Progress will update below, and I will summarize the result when it finishes.',
  ].join('\n');
}

function readEventString(event: WorkflowEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function formatWorkflowAgentDigest(
  event: WorkflowEvent,
  locale: WorkflowRunLocale = 'en',
  runId?: string,
): string | undefined {
  if (event.type !== 'agent_completed' && event.type !== 'agent_summary_updated') {
    return undefined;
  }
  if (event.type === 'agent_completed' && readEventString(event, 'status') !== 'completed') {
    return undefined;
  }
  const rawSummary = readEventString(event, 'summary');
  if (!rawSummary) return undefined;
  const rawKind = readEventString(event, 'summaryKind');
  if (rawKind === 'pending') return undefined;
  const summaryKind: WorkflowAgentSummaryKind =
    rawKind === 'digest' ? 'digest' : rawKind === 'digest-failed' ? 'digest-failed' : 'excerpt';
  const name = readEventString(event, 'name') ?? readEventString(event, 'taskId') ?? 'agent';
  return formatWorkflowAgentLongDigest(
    name,
    rawSummary,
    locale,
    runId,
    summaryKind,
  );
}

type WorkflowAgentSummaryKind = 'digest' | 'excerpt' | 'digest-failed';

function trimWorkflowAgentDigestExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS) return compact;
  return `${compact.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS).trimEnd()}...`;
}

function isHighSignalWorkflowAgentDigestLine(line: string): boolean {
  if (/^(?:conclusion|finding|confirmed issue|issue|evidence|risk|next|unresolved|decision|result|summary|结论|发现|问题|证据|风险|下一步|未决|判断|决定|结果|摘要)[:：]/i.test(line)) {
    return true;
  }
  if (/^(?:[A-Z]{1,3}-?\d+|[HMSLP]\d+)[.)：:\s-]/i.test(line)) return true;
  return /(?:critical|high|medium|low)\s+severity|(?:严重|高危|中危|低危)/i.test(line);
}

function isLowInformationWorkflowAgentDigestLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (/\[\/?workflow handoff\]/i.test(line)) return true;
  if (/^\|.*\|$/.test(line)) return true;
  if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) return true;
  if (/^(?:i now have|i have|i now understand|here is|let me|i will|this report|the report)\b/.test(lower)) {
    return true;
  }
  if (/^(?:scope|review scope|范围|审查范围)[:：]/i.test(line)) return true;
  if (/^feature[_\s-]*\d+.*(?:report|review|audit|map|审查|报告|地图|变更地图)/i.test(line)) return true;
  if (/^feature[_\s-]*\d+.*改动分布.*feature/i.test(line)) return true;
  if (/(?:review report|audit|审查报告|综合报告|分析报告|变更地图)$/i.test(line) && line.length < 140) return true;
  return false;
}

interface WorkflowAgentDigestExtractionOptions {
  readonly truncateLines?: boolean;
}

function compactWorkflowAgentDigestLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeWorkflowAgentDigestLine(
  line: string,
  options: WorkflowAgentDigestExtractionOptions = {},
): string | undefined {
  const stripped = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^`{3,}.*$/, '')
    .replace(/^[`"'“”‘’)\]}，,、。；;：:.\s]+/, '')
    .trim();
  const compact = compactWorkflowAgentDigestLine(stripped);
  if (compact.length < 12) return undefined;
  if (/^[-*_`#\s]+$/.test(compact)) return undefined;
  if (isLowInformationWorkflowAgentDigestLine(compact)) return undefined;
  return options.truncateLines === false ? compact : trimWorkflowAgentDigestExcerpt(compact);
}

function extractWorkflowAgentDigestExcerpts(
  summary: string,
  options: WorkflowAgentDigestExtractionOptions = {},
): readonly string[] {
  const highSignal: string[] = [];
  const excerpts: string[] = [];
  for (const rawLine of summary.split(/\r?\n+/)) {
    const line = normalizeWorkflowAgentDigestLine(rawLine, options);
    if (!line) continue;
    const target = isHighSignalWorkflowAgentDigestLine(line) ? highSignal : excerpts;
    if (highSignal.includes(line) || excerpts.includes(line)) continue;
    target.push(line);
  }
  if (highSignal.length > 0) return highSignal.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS);
  if (excerpts.length > 0) return excerpts.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS);
  return [];
}

function formatWorkflowAgentLongDigest(
  name: string,
  summary: string,
  locale: WorkflowRunLocale,
  runId: string | undefined,
  summaryKind: WorkflowAgentSummaryKind = 'excerpt',
): string {
  const isModelDigest = summaryKind === 'digest';
  const excerpts = extractWorkflowAgentDigestExcerpts(summary, {
    truncateLines: !isModelDigest,
  });
  const excerptLines = excerpts.map((line) => `- ${line}`);
  const detailHint = runId
    ? locale === 'zh'
      ? `这是子 Agent 的有界摘要；/workflow show ${runId} 可查看运行事件时间线。`
      : `This is a child-agent digest; use /workflow show ${runId} for the event timeline.`
    : locale === 'zh'
      ? '这是子 Agent 的有界摘要；/workflow show 可查看运行事件时间线。'
      : 'This is a child-agent digest; use /workflow show for the event timeline.';
  // `digest-failed` tells the user the LLM self-distill was attempted but
  // unavailable (error/timeout), so the lines below are a deterministic
  // local excerpt — not the intended smart summary.
  const heading = locale === 'zh'
    ? isModelDigest
      ? `子 Agent ${name} 已完成。摘要：`
      : summaryKind === 'digest-failed'
        ? `子 Agent ${name} 已完成（智能摘要不可用，以下为本地摘录）：`
        : `子 Agent ${name} 已完成。摘录摘要：`
    : isModelDigest
      ? `Agent ${name} completed. Summary:`
      : summaryKind === 'digest-failed'
        ? `Agent ${name} completed (smart summary unavailable; local excerpt):`
        : `Agent ${name} completed. Extracted summary:`;
  if (excerptLines.length === 0) {
    const emptyHeading = locale === 'zh'
      ? `子 Agent ${name} 已完成，但未能提取到有效摘要。`
      : `Agent ${name} completed. No useful summary could be extracted.`;
    return [
      emptyHeading,
      detailHint,
    ].join('\n');
  }
  return [
    heading,
    ...excerptLines,
    detailHint,
  ].join('\n');
}

export function createWorkflowAgentDigestLimiter(
  runId: string,
): (event: WorkflowEvent, locale?: WorkflowRunLocale) => string | undefined {
  return (event, locale = 'en') => {
    return formatWorkflowAgentDigest(event, locale, runId);
  };
}

