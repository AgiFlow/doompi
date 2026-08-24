import { SESSIONS_API_ROUTE } from '../../types/hub.ts';

export type CreateSessionResult = { sessionId: string } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Asks the hub to start a new doompi-server in the given directory.
 *
 * The one place the page talks REST to the hub; if creation ever moves onto
 * the WebSocket, only this file changes.
 */
export async function createSession(input: { cwd: string; name?: string }): Promise<CreateSessionResult> {
  let response: Response;
  try {
    response = await fetch(SESSIONS_API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok && isRecord(body) && typeof body.sessionId === 'string') return { sessionId: body.sessionId };
  const error = isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`;
  return { error };
}
