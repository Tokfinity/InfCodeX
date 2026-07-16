import type {
  AgentExecutorPlaneStore,
  AgentTaskEvent,
  AgentTaskSnapshot,
  ExternalAgentRegistration,
} from './types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryAgentExecutorPlaneStore(): AgentExecutorPlaneStore {
  let registrations: readonly ExternalAgentRegistration[] = [];
  let taskRegistrationSnapshots: readonly ExternalAgentRegistration[] = [];
  const tasks = new Map<string, AgentTaskSnapshot>();
  const events = new Map<string, AgentTaskEvent[]>();

  return {
    async loadRegistrations() {
      return clone(registrations);
    },
    async saveRegistrations(next) {
      registrations = clone(next);
    },
    async loadTaskRegistrationSnapshots() {
      return clone(taskRegistrationSnapshots);
    },
    async saveTaskRegistrationSnapshots(next) {
      taskRegistrationSnapshots = clone(next);
    },
    async loadTasks() {
      return [...tasks.values()].map(clone);
    },
    async saveTask(task) {
      tasks.set(task.taskId, clone(task));
    },
    async loadEvents(taskId) {
      return (events.get(taskId) ?? []).map(clone);
    },
    async appendEvent(event) {
      const current = events.get(event.taskId) ?? [];
      current.push(clone(event));
      events.set(event.taskId, current);
    },
  };
}
