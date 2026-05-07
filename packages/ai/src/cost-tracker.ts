/**
 * KodaX Cost Tracker - Immutable session cost tracking
 *
 * 成本追踪器 - 不可变的会话成本追踪
 * 使用 Immutable 模式，每次操作都返回新对象而不修改原有对象
 */

import { type CostRate, calculateCost, getCostRate } from './cost-rates.js';

export interface TokenUsageRecord {
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
  readonly role?: string;
}

export interface ProviderCostSummary {
  readonly cost: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * FEATURE_130 (v0.7.36) — per-retry record. Captures the wait the
 * provider asked us to take so `/cost` can report "X retries, Ys total
 * wait" alongside the token cost. Lives in the same tracker as token
 * records to keep one source of truth for the session.
 */
export interface RetryRecord {
  readonly timestamp: number;
  readonly provider: string;
  readonly waitMs: number;
  readonly reason: 'rate-limit' | 'overloaded';
  readonly source:
    | 'retry-after-seconds'
    | 'retry-after-date'
    | 'retry-after-ms'
    | 'exponential-backoff';
}

export interface SessionCostSummary {
  readonly totalCost: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheTokens: number;
  readonly callCount: number;
  /** FEATURE_130: total retries triggered across the session. */
  readonly retryCount: number;
  /** FEATURE_130: cumulative milliseconds spent in retry-after sleeps. */
  readonly retryWaitMs: number;
  readonly byProvider: Readonly<Record<string, ProviderCostSummary>>;
  readonly byRole: Readonly<Record<string, ProviderCostSummary>>;
}

export interface CostTracker {
  readonly records: readonly TokenUsageRecord[];
  /** FEATURE_130 (v0.7.36): retry-wait records, append-only and immutable. */
  readonly retries: readonly RetryRecord[];
}

export function createCostTracker(): CostTracker {
  return { records: [], retries: [] };
}

/**
 * FEATURE_130 (v0.7.36): record a retry-after wait. The InkREPL spinner
 * (or any other consumer of `KodaXEvents.onRetryAfter`) calls this so
 * `/cost` can surface accurate session-wide retry telemetry.
 */
export function recordRetry(
  tracker: CostTracker,
  entry: {
    readonly provider: string;
    readonly waitMs: number;
    readonly reason: 'rate-limit' | 'overloaded';
    readonly source:
      | 'retry-after-seconds'
      | 'retry-after-date'
      | 'retry-after-ms'
      | 'exponential-backoff';
  },
): CostTracker {
  const record: RetryRecord = {
    timestamp: Date.now(),
    provider: entry.provider,
    waitMs: entry.waitMs,
    reason: entry.reason,
    source: entry.source,
  };
  return { records: tracker.records, retries: [...tracker.retries, record] };
}

export function recordUsage(
  tracker: CostTracker,
  entry: {
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly role?: string;
  },
  userCostOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>,
): CostTracker {
  const rate = getCostRate(entry.provider, entry.model, userCostOverrides);
  const cacheTokens = (entry.cacheReadTokens ?? 0) + (entry.cacheWriteTokens ?? 0);
  const cost = rate ? calculateCost(rate, entry.inputTokens, entry.outputTokens, cacheTokens) : 0;

  const record: TokenUsageRecord = {
    timestamp: Date.now(),
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    cost,
    role: entry.role,
  };

  return { records: [...tracker.records, record], retries: tracker.retries };
}

export function getSummary(tracker: CostTracker): SessionCostSummary {
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;
  const byProvider: Record<string, ProviderCostSummary> = {};
  const byRole: Record<string, ProviderCostSummary> = {};

  for (const r of tracker.records) {
    totalCost += r.cost;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheTokens += r.cacheReadTokens + r.cacheWriteTokens;

    // Aggregate by provider
    const prev = byProvider[r.provider];
    byProvider[r.provider] = {
      cost: (prev?.cost ?? 0) + r.cost,
      calls: (prev?.calls ?? 0) + 1,
      inputTokens: (prev?.inputTokens ?? 0) + r.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + r.outputTokens,
    };

    // Aggregate by role
    const roleKey = r.role ?? 'default';
    const prevRole = byRole[roleKey];
    byRole[roleKey] = {
      cost: (prevRole?.cost ?? 0) + r.cost,
      calls: (prevRole?.calls ?? 0) + 1,
      inputTokens: (prevRole?.inputTokens ?? 0) + r.inputTokens,
      outputTokens: (prevRole?.outputTokens ?? 0) + r.outputTokens,
    };
  }

  let retryWaitMs = 0;
  for (const r of tracker.retries) {
    retryWaitMs += r.waitMs;
  }

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens,
    callCount: tracker.records.length,
    retryCount: tracker.retries.length,
    retryWaitMs,
    byProvider,
    byRole,
  };
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCostReport(summary: SessionCostSummary): string {
  const lines: string[] = [];
  lines.push(`Session Cost: ${formatCost(summary.totalCost)} (${summary.callCount} calls)`);
  lines.push(
    `Tokens: ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`,
  );
  if (summary.totalCacheTokens > 0) {
    lines.push(`Cache: ${summary.totalCacheTokens.toLocaleString()} tokens`);
  }
  if (summary.retryCount > 0) {
    const seconds = (summary.retryWaitMs / 1000).toFixed(1);
    lines.push(`Retries: ${summary.retryCount} (${seconds}s total wait)`);
  }
  lines.push('');

  const providerEntries = Object.entries(summary.byProvider).sort((a, b) => b[1].cost - a[1].cost);
  if (providerEntries.length > 0) {
    lines.push('By Provider:');
    for (const [name, data] of providerEntries) {
      lines.push(
        `  ${name}: ${formatCost(data.cost)} (${data.calls} calls, ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out)`,
      );
    }
    lines.push('');
  }

  const roleEntries = Object.entries(summary.byRole).sort((a, b) => b[1].cost - a[1].cost);
  if (roleEntries.length > 1) {
    lines.push('By Role:');
    for (const [name, data] of roleEntries) {
      lines.push(`  ${name}: ${formatCost(data.cost)} (${data.calls} calls)`);
    }
  }

  return lines.join('\n');
}
