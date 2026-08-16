import type { LearningSurfaceSnapshot } from '../types.js';

const LEARNING_RECOVERY_NOTICE_ID = 'learning-recovery';

export function dismissLearningRecoveryAfterQuerySubmit<Notice extends { readonly id: string }>(
  notices: readonly Notice[],
): readonly Notice[] {
  return notices.filter((notice) => notice.id !== LEARNING_RECOVERY_NOTICE_ID);
}

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
