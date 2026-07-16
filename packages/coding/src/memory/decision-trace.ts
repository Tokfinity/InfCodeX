import { AsyncLocalStorage } from 'node:async_hooks';

import type { MemoryDecisionReceipt } from '@kodax-ai/agent/experimental-memory';

const memoryDecisionTrace = new AsyncLocalStorage<MemoryDecisionReceipt[]>();

export function withMemoryDecisionTrace<T>(
  target: MemoryDecisionReceipt[],
  run: () => T,
): T {
  return memoryDecisionTrace.run(target, run);
}

export function recordMemoryDecisionReceipt(receipt: MemoryDecisionReceipt): void {
  const target = memoryDecisionTrace.getStore();
  if (target === undefined) return;
  target.push(freezeReceipt(receipt));
}

function freezeReceipt(receipt: MemoryDecisionReceipt): MemoryDecisionReceipt {
  return Object.freeze({
    ...receipt,
    candidateRefs: Object.freeze([...receipt.candidateRefs]),
    selectedRefs: Object.freeze([...receipt.selectedRefs]),
    injectedRefs: Object.freeze([...receipt.injectedRefs]),
    selectionModes: Object.freeze([...receipt.selectionModes]),
  });
}
