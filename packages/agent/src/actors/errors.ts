import type { AgentBudgetExhausted, AgentLimitReached } from './types.js';

export class AgentLimitReachedError extends Error implements AgentLimitReached {
  readonly code = 'agent_limit_reached' as const;
  readonly availableNonRootSlots = 0 as const;
  readonly retryable = true as const;

  constructor(
    readonly maxConcurrentThreads: number,
    readonly activeNonRootTurns: number,
  ) {
    super('Agent concurrency limit reached.');
    this.name = 'AgentLimitReachedError';
  }
}

export class AgentBudgetExhaustedError extends Error implements AgentBudgetExhausted {
  readonly code = 'agent_budget_exhausted' as const;
  readonly retryable = false as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AgentBudgetExhaustedError';
  }
}

export type AgentControlErrorCode =
  | 'actor_closed'
  | 'actor_not_found'
  | 'invalid_actor_path'
  | 'invalid_capabilities'
  | 'invalid_fork_turns'
  | 'invalid_message'
  | 'invalid_task_name'
  | 'name_collision'
  | 'no_active_turn'
  | 'permission_denied'
  | 'unsupported_operation';

export class AgentControlError extends Error {
  constructor(readonly code: AgentControlErrorCode, message: string) {
    super(message);
    this.name = 'AgentControlError';
  }
}
