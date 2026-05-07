/**
 * @kodax/agent/messaging — barrel export
 *
 * FEATURE_115 (v0.7.36).
 */

export type {
  DequeueFilter,
  EnqueueInput,
  MessageMode,
  MessagePriority,
  QueuedMessage,
} from './types.js';

export {
  MessageQueue,
  _resetMessageQueueForTests,
  getMessageQueue,
} from './queue.js';

export type {
  EnqueueChildTaskNotificationInput,
  MaybeDrainMidTurnInput,
} from './drain.js';
export {
  YIELD_TOOL_NAMES,
  enqueueChildTaskNotification,
  maybeDrainMidTurn,
  midTurnDrainPriority,
} from './drain.js';
