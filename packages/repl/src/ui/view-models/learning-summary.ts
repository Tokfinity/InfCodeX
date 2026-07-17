import type { LearningSurfaceSnapshot } from '../types.js';

export function formatLearningStatus(snapshot: LearningSurfaceSnapshot): string {
  return [
    `ready=${snapshot.ready}`,
    `new=${snapshot.newlyActive}`,
    `attention=${snapshot.attention}`,
    `active=${snapshot.active}`,
  ].join('  ');
}

export function formatLearningRecoverySummary(
  snapshot: LearningSurfaceSnapshot,
): string | undefined {
  const actionable = snapshot.ready + snapshot.newlyActive + snapshot.attention;
  if (actionable === 0) return undefined;
  return `Learning recovery: ${formatLearningStatus(snapshot)}  [/learn]`;
}
