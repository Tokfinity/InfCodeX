/**
 * JSONL event handler for non-interactive CLI mode.
 *
 * stdout carries newline-delimited JSON events only.
 * stderr carries structured error diagnostics.
 */

import type {
  KodaXActivityEventMeta,
  KodaXContextTokenSnapshot,
  KodaXEvents,
  KodaXManagedTaskStatusEvent,
  KodaXRepoIntelligenceTraceEvent,
  KodaXTokenUsage,
  WorkflowEventCorrelation,
} from '@kodax-ai/coding';

type JsonWritable = Pick<NodeJS.WritableStream, 'write'>;

export interface JsonEventOutputOptions {
  stdout?: JsonWritable;
  stderr?: JsonWritable;
}

type JsonEvent =
  | { type: 'session.start'; provider: string; sessionId: string }
  | { type: 'iteration.start'; iter: number; maxIter: number }
  | {
      type: 'iteration.end';
      iter: number;
      maxIter: number;
      tokenCount: number;
      tokenSource: 'api' | 'estimate';
      usage?: KodaXTokenUsage;
      contextTokenSnapshot?: KodaXContextTokenSnapshot;
      scope?: 'parent' | 'worker';
    }
  | ({ type: 'text.delta'; text: string } & JsonActivityMeta)
  | ({ type: 'thinking.delta'; text: string } & JsonActivityMeta)
  | ({ type: 'thinking.end'; thinking: string } & JsonActivityMeta)
  | ({
      type: 'tool.start';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    } & JsonActivityMeta)
  | ({
      type: 'tool.input.delta';
      toolName: string;
      partialJson: string;
      toolId?: string;
    } & JsonActivityMeta)
  | ({
      type: 'tool.result';
      id: string;
      name: string;
      content: string;
    } & JsonActivityMeta)
  | ({ type: 'stream.end' } & JsonActivityMeta)
  | { type: 'compact.start' }
  | { type: 'compact.finish'; estimatedTokens: number }
  | { type: 'compact.stats'; tokensBefore: number; tokensAfter: number }
  | { type: 'compact.end' }
  | { type: 'retry'; reason: string; attempt: number; maxAttempts: number }
  | {
      type: 'provider.recovery';
      stage: string;
      reasonCode: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      nextAt: number;
      recoveryAction: string;
      fallbackUsed: boolean;
    }
  | { type: 'provider.rate_limit'; attempt: number; maxRetries: number; delayMs: number }
  | {
      type: 'repo_intelligence.trace';
      stage: KodaXRepoIntelligenceTraceEvent['stage'];
      summary: string;
      capability?: KodaXRepoIntelligenceTraceEvent['capability'];
      trace?: KodaXRepoIntelligenceTraceEvent['trace'];
    }
  | ({
      type: 'tool.progress';
      id: string;
      message: string;
    } & JsonActivityMeta)
  | {
      type: 'managed_task.status';
      agentMode: KodaXManagedTaskStatusEvent['agentMode'];
      harnessProfile: KodaXManagedTaskStatusEvent['harnessProfile'];
      phase?: KodaXManagedTaskStatusEvent['phase'];
      activeWorkerId?: string;
      activeWorkerTitle?: string;
      childFanoutClass?: KodaXManagedTaskStatusEvent['childFanoutClass'];
      childFanoutCount?: number;
      currentRound?: number;
      maxRounds?: number;
      note?: string;
      detailNote?: string;
      globalWorkBudget?: number;
      budgetUsage?: number;
      budgetApprovalRequired?: boolean;
    }
  | {
      type: 'scout.suspicious_completion';
      confidence: 'uncertain';
      signals: readonly string[];
      sessionId?: string;
      lastTextPreview?: string;
    }
  | { type: 'complete' };

type JsonErrorEvent = {
  type: 'error';
  name: string;
  message: string;
  stack?: string;
};

type JsonActivityMeta = {
  workflowCorrelation?: WorkflowEventCorrelation;
  childAgentId?: string;
  childAgentName?: string;
  parentToolId?: string;
  liveOnly?: boolean;
};

function activityMetaFields(meta?: KodaXActivityEventMeta): JsonActivityMeta {
  return {
    ...(meta?.workflowCorrelation !== undefined ? { workflowCorrelation: meta.workflowCorrelation } : {}),
    ...(meta?.childAgentId !== undefined ? { childAgentId: meta.childAgentId } : {}),
    ...(meta?.childAgentName !== undefined ? { childAgentName: meta.childAgentName } : {}),
    ...(meta?.parentToolId !== undefined ? { parentToolId: meta.parentToolId } : {}),
    ...(meta?.liveOnly !== undefined ? { liveOnly: meta.liveOnly } : {}),
  };
}

function writeJsonLine(stream: JsonWritable, value: JsonEvent | JsonErrorEvent): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function serializeError(error: Error): JsonErrorEvent {
  return {
    type: 'error',
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

export function createJsonEvents(options: JsonEventOutputOptions = {}): KodaXEvents {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return {
    onSessionStart: (info) => {
      writeJsonLine(stdout, {
        type: 'session.start',
        provider: info.provider,
        sessionId: info.sessionId,
      });
    },

    onIterationStart: (iter, maxIter) => {
      writeJsonLine(stdout, { type: 'iteration.start', iter, maxIter });
    },

    onIterationEnd: (info) => {
      writeJsonLine(stdout, {
        type: 'iteration.end',
        iter: info.iter,
        maxIter: info.maxIter,
        tokenCount: info.tokenCount,
        tokenSource: info.tokenSource,
        usage: info.usage,
        contextTokenSnapshot: info.contextTokenSnapshot,
        ...(info.scope !== undefined ? { scope: info.scope } : {}),
      });
    },

    onTextDelta: (text, meta) => {
      writeJsonLine(stdout, { type: 'text.delta', text, ...activityMetaFields(meta) });
    },

    onThinkingDelta: (text, meta) => {
      writeJsonLine(stdout, { type: 'thinking.delta', text, ...activityMetaFields(meta) });
    },

    onThinkingEnd: (thinking, meta) => {
      writeJsonLine(stdout, { type: 'thinking.end', thinking, ...activityMetaFields(meta) });
    },

    onToolUseStart: (tool, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.start',
        id: tool.id,
        name: tool.name,
        input: tool.input,
        ...activityMetaFields(meta),
      });
    },

    onToolInputDelta: (toolName, partialJson, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.input.delta',
        toolName,
        partialJson,
        toolId: meta?.toolId,
        ...activityMetaFields(meta),
      });
    },

    onToolResult: (result, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.result',
        id: result.id,
        name: result.name,
        content: result.content,
        ...activityMetaFields(meta),
      });
    },

    onStreamEnd: (meta) => {
      writeJsonLine(stdout, { type: 'stream.end', ...activityMetaFields(meta) });
    },

    onCompactStart: () => {
      writeJsonLine(stdout, { type: 'compact.start' });
    },

    onCompact: (estimatedTokens) => {
      writeJsonLine(stdout, {
        type: 'compact.finish',
        estimatedTokens,
      });
    },

    onCompactStats: (info) => {
      writeJsonLine(stdout, {
        type: 'compact.stats',
        tokensBefore: info.tokensBefore,
        tokensAfter: info.tokensAfter,
      });
    },

    onCompactEnd: () => {
      writeJsonLine(stdout, { type: 'compact.end' });
    },

    onRetry: (reason, attempt, maxAttempts) => {
      writeJsonLine(stdout, {
        type: 'retry',
        reason,
        attempt,
        maxAttempts,
      });
    },

    onProviderRecovery: (event) => {
      writeJsonLine(stdout, {
        type: 'provider.recovery',
        stage: event.stage,
        reasonCode: event.errorClass,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        nextAt: Date.now() + event.delayMs,
        recoveryAction: event.recoveryAction,
        fallbackUsed: event.fallbackUsed,
      });
    },

    onProviderRateLimit: (attempt, maxRetries, delayMs) => {
      writeJsonLine(stdout, {
        type: 'provider.rate_limit',
        attempt,
        maxRetries,
        delayMs,
      });
    },

    onRepoIntelligenceTrace: (event) => {
      writeJsonLine(stdout, {
        type: 'repo_intelligence.trace',
        stage: event.stage,
        summary: event.summary,
        capability: event.capability,
        trace: event.trace,
      });
    },

    onToolProgress: (update, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.progress',
        id: update.id,
        message: update.message,
        ...activityMetaFields(meta),
      });
    },

    onManagedTaskStatus: (status) => {
      writeJsonLine(stdout, {
        type: 'managed_task.status',
        agentMode: status.agentMode,
        harnessProfile: status.harnessProfile,
        phase: status.phase,
        activeWorkerId: status.activeWorkerId,
        activeWorkerTitle: status.activeWorkerTitle,
        childFanoutClass: status.childFanoutClass,
        childFanoutCount: status.childFanoutCount,
        currentRound: status.currentRound,
        maxRounds: status.maxRounds,
        note: status.note,
        detailNote: status.detailNote,
        globalWorkBudget: status.globalWorkBudget,
        budgetUsage: status.budgetUsage,
        budgetApprovalRequired: status.budgetApprovalRequired,
      });
    },

    onScoutSuspiciousCompletion: (payload) => {
      writeJsonLine(stdout, {
        type: 'scout.suspicious_completion',
        confidence: payload.confidence,
        signals: payload.signals,
        sessionId: payload.sessionId,
        lastTextPreview: payload.lastTextPreview,
      });
    },

    onComplete: () => {
      writeJsonLine(stdout, { type: 'complete' });
    },

    onError: (error) => {
      writeJsonLine(stderr, serializeError(error));
    },
  };
}
