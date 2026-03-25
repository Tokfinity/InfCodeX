/**
 * Session Storage - Session storage abstraction layer
 *
 * Provides a shared persistence interface across memory and filesystem storage.
 */

import type { KodaXSessionData, SessionErrorMetadata } from "@kodax/coding";

// Re-export SessionErrorMetadata for backward compatibility
export type { SessionErrorMetadata } from "@kodax/coding";

/**
 * Session data structure.
 */
export type SessionData = KodaXSessionData;

/**
 * Session storage interface.
 */
export interface SessionStorage {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(): Promise<void>;
}

/**
 * In-memory session storage implementation.
 */
export class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, SessionData>();

  async save(id: string, data: SessionData): Promise<void> {
    this.sessions.set(id, data);
  }

  async load(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      title: data.title,
      msgCount: data.messages.length,
    }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(): Promise<void> {
    this.sessions.clear();
  }
}

export function createMemorySessionStorage(): SessionStorage {
  return new MemorySessionStorage();
}
