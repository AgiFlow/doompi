import { type ApiScopeAddress, scopeApiRoot } from '../apiPaths';

let resolveWorkspace: ((sessionId: string) => string | undefined) | undefined;

/** The host owns session summaries; package clients use the same ownership lookup. */
export function bindSessionApiWorkspace(resolve: (sessionId: string) => string | undefined): void {
  resolveWorkspace = resolve;
}

/** Canonical global resource. */
export function globalApiPath(): string {
  return scopeApiRoot({ scope: 'global' });
}

/** Canonical workspace resource. */
export function workspaceApiPath(workspaceId: string): string {
  return scopeApiRoot({ scope: 'workspace', workspaceId });
}

/**
 * Who a session id names, resolved through the host's ownership lookup.
 *
 * A generated client takes a session id and nothing else, because a page knows
 * which session it is showing and must not be trusted to say which workspace
 * owns it. Unknown ownership throws rather than guessing, since guessing would
 * address a different scope.
 */
export function sessionApiAddress(sessionId: string): ApiScopeAddress {
  const workspaceId = resolveWorkspace?.(sessionId);
  if (!workspaceId) throw new Error(`Workspace is unavailable for session '${sessionId}'.`);
  return { scope: 'session', workspaceId, sessionId };
}

/** Canonical session resource. Unknown ownership must never select a different scope. */
export function sessionApiPath(sessionId: string): string {
  return scopeApiRoot(sessionApiAddress(sessionId));
}
