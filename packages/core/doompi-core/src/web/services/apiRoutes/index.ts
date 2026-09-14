let resolveWorkspace: ((sessionId: string) => string | undefined) | undefined;

/** The host owns session summaries; package clients use the same ownership lookup. */
export function bindSessionApiWorkspace(resolve: (sessionId: string) => string | undefined): void {
  resolveWorkspace = resolve;
}

/** Canonical session resource. Unknown ownership must never select a different scope. */
export function sessionApiPath(sessionId: string): string {
  const workspaceId = resolveWorkspace?.(sessionId);
  if (!workspaceId) throw new Error(`Workspace is unavailable for session '${sessionId}'.`);
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
}
