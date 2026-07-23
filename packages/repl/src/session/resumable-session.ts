const RESUMABLE_SESSION_SCAN_LIMIT = 1000;

export async function findMostRecentResumableSession<
  T extends { readonly id: string; readonly msgCount: number },
>(
  storage: {
    list(
      gitRoot?: string,
      options?: { limit?: number },
    ): Promise<T[]>;
  },
  gitRoot?: string,
): Promise<T | undefined> {
  const sessions = await storage.list(gitRoot, {
    limit: RESUMABLE_SESSION_SCAN_LIMIT,
  });
  return sessions.find((session) => session.msgCount > 0);
}
