import { AgentLimitReachedError } from './errors.js';

export class AgentTurnScheduler {
  private readonly active = new Set<string>();

  constructor(readonly maxConcurrentThreads: number) {
    if (!Number.isSafeInteger(maxConcurrentThreads) || maxConcurrentThreads < 1) {
      throw new Error('maxConcurrentThreadsPerSession must be a positive safe integer.');
    }
  }

  get activeNonRootTurns(): number {
    return this.active.size;
  }

  reserve(turnId: string): void {
    if (this.active.has(turnId)) return;
    if (this.active.size >= this.maxConcurrentThreads - 1) {
      throw new AgentLimitReachedError(this.maxConcurrentThreads, this.active.size);
    }
    this.active.add(turnId);
  }

  release(turnId: string): void {
    this.active.delete(turnId);
  }

  restore(turnIds: readonly string[]): void {
    this.active.clear();
    for (const turnId of turnIds) this.reserve(turnId);
  }
}
