import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { countTokens, estimateTokens } from '../tokenizer.js';

export type RuntimeContextOptimizationProfile =
  | 'off'
  | 'report_only'
  | 'balanced'
  | 'small_window'
  | 'aggressive';

export type RuntimeContextPressure = 'low' | 'medium' | 'high' | 'critical';

export interface RuntimeContextBudgetBreakdown {
  readonly systemPrompt: number;
  readonly toolSchemas: number;
  readonly skillCatalog: number;
  readonly mcpCatalog: number;
  readonly transcript: number;
  readonly pendingInput: number;
  readonly recentToolResults: number;
  readonly reservedResponse: number;
  readonly total: number;
}

export interface RuntimeContextBudgetSnapshot {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly profile: RuntimeContextOptimizationProfile;
  readonly contextWindow: number;
  readonly smallWindow: boolean;
  readonly pressure: RuntimeContextPressure;
  readonly tokenBreakdown: RuntimeContextBudgetBreakdown;
  readonly usedTokens: number;
  readonly availableTokens: number;
  readonly usedRatio: number;
  readonly toolSchemaRatio: number;
  readonly recommendations: readonly RuntimeContextBudgetRecommendation[];
  readonly createdAt: string;
}

export type RuntimeContextBudgetRecommendation =
  | 'prefer_progressive_tool_exposure'
  | 'compact_or_summarize_history'
  | 'trim_recent_tool_results'
  | 'reserve_response_budget';

export interface RuntimeContextBudgetSnapshotInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: RuntimeContextOptimizationProfile;
  readonly contextWindow: number;
  readonly systemPrompt?: string;
  readonly toolDefinitions?: readonly KodaXToolDefinition[];
  readonly skillCatalogText?: string;
  readonly mcpCatalogText?: string;
  readonly messages?: readonly KodaXMessage[];
  readonly pendingInput?: string;
  readonly recentToolResults?: readonly string[];
  readonly reservedResponseTokens?: number;
  readonly now?: () => Date;
}

export function estimateToolSchemaTokens(
  definition: KodaXToolDefinition,
  descriptionOverride?: string,
): number {
  return estimateStringTokens(JSON.stringify({
    name: definition.name,
    description: descriptionOverride ?? definition.description,
    parameters: definition.input_schema,
  }));
}

export function createRuntimeContextBudgetSnapshot(
  input: RuntimeContextBudgetSnapshotInput,
): RuntimeContextBudgetSnapshot {
  const contextWindow = toNonNegativeInteger(input.contextWindow);
  const reservedResponse = toNonNegativeInteger(input.reservedResponseTokens ?? 0);
  const systemPrompt = estimateStringTokens(input.systemPrompt ?? '');
  const toolSchemas = sumTokens(input.toolDefinitions ?? [], estimateToolSchemaTokens);
  const skillCatalog = estimateStringTokens(input.skillCatalogText ?? '');
  const mcpCatalog = estimateStringTokens(input.mcpCatalogText ?? '');
  const transcript = estimateTokens(input.messages ?? []);
  const pendingInput = estimateStringTokens(input.pendingInput ?? '');
  const recentToolResults = sumTokens(input.recentToolResults ?? [], estimateStringTokens);
  const total = systemPrompt
    + toolSchemas
    + skillCatalog
    + mcpCatalog
    + transcript
    + pendingInput
    + recentToolResults
    + reservedResponse;
  const availableTokens = contextWindow > 0 ? Math.max(0, contextWindow - total) : 0;
  const usedRatio = contextWindow > 0 ? clampRatio(total / contextWindow) : 1;
  const toolSchemaRatio = contextWindow > 0 ? clampRatio(toolSchemas / contextWindow) : 0;
  const smallWindow = contextWindow > 0 && contextWindow <= 32_000;
  const pressure = classifyContextPressure({
    availableTokens,
    contextWindow,
    smallWindow,
    usedRatio,
  });

  return {
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    provider: input.provider,
    model: input.model,
    profile: input.profile ?? 'report_only',
    contextWindow,
    smallWindow,
    pressure,
    tokenBreakdown: {
      systemPrompt,
      toolSchemas,
      skillCatalog,
      mcpCatalog,
      transcript,
      pendingInput,
      recentToolResults,
      reservedResponse,
      total,
    },
    usedTokens: total,
    availableTokens,
    usedRatio,
    toolSchemaRatio,
    recommendations: buildRecommendations({
      pressure,
      recentToolResults,
      reservedResponse,
      toolSchemaRatio,
    }),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

function estimateStringTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(0, countTokens(value));
}

function sumTokens<T>(
  values: readonly T[],
  estimator: (value: T) => number,
): number {
  let total = 0;
  for (const value of values) {
    total += estimator(value);
  }
  return total;
}

function classifyContextPressure(input: {
  readonly availableTokens: number;
  readonly contextWindow: number;
  readonly smallWindow: boolean;
  readonly usedRatio: number;
}): RuntimeContextPressure {
  if (input.contextWindow <= 0 || input.availableTokens <= 0 || input.usedRatio >= 0.9) {
    return 'critical';
  }
  if (input.availableTokens <= Math.max(1_024, input.contextWindow * 0.05)) {
    return 'critical';
  }
  if (input.usedRatio >= 0.75) {
    return 'high';
  }
  if (input.availableTokens <= Math.max(2_048, input.contextWindow * 0.15)) {
    return 'high';
  }
  if (input.usedRatio >= 0.55 || (input.smallWindow && input.usedRatio >= 0.4)) {
    return 'medium';
  }
  return 'low';
}

function buildRecommendations(input: {
  readonly pressure: RuntimeContextPressure;
  readonly recentToolResults: number;
  readonly reservedResponse: number;
  readonly toolSchemaRatio: number;
}): readonly RuntimeContextBudgetRecommendation[] {
  if (input.pressure === 'low') return [];

  const recommendations: RuntimeContextBudgetRecommendation[] = [];
  if (input.toolSchemaRatio >= 0.08) {
    recommendations.push('prefer_progressive_tool_exposure');
  }
  if (input.pressure === 'high' || input.pressure === 'critical') {
    recommendations.push('compact_or_summarize_history');
  }
  if (input.recentToolResults > 0) {
    recommendations.push('trim_recent_tool_results');
  }
  if (input.reservedResponse === 0) {
    recommendations.push('reserve_response_budget');
  }
  return recommendations;
}

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}
