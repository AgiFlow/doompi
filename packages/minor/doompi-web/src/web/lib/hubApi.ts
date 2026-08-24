import { DIRECTORIES_API_ROUTE, SESSIONS_API_ROUTE } from '../../types/hub.ts';

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

export type StopSessionResult = { ok: true } | { error: string };

/** Asks the hub to stop a session's server; the rail card leaves once the server withdraws its record. */
export async function stopSession(sessionId: string): Promise<StopSessionResult> {
  let response: Response;
  try {
    response = await fetch(`${SESSIONS_API_ROUTE}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
  if (response.ok) return { ok: true };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`;
  return { error };
}

/** File paths under a session's cwd matching the query, for @ completion. */
export async function searchSessionFiles(sessionId: string, query: string): Promise<string[]> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { files?: unknown };
    return Array.isArray(body.files) ? body.files.filter((file): file is string => typeof file === 'string') : [];
  } catch {
    return []; // Completion is a convenience; a failed lookup just shows nothing.
  }
}

/**
 * Directories the typed path could complete to, for the new-session picker.
 * The hub lists the parent directory's children and filters them by the
 * trailing segment as a regular expression.
 */
export async function searchDirectories(query: string): Promise<string[]> {
  try {
    const response = await fetch(`${DIRECTORIES_API_ROUTE}?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { directories?: unknown };
    return Array.isArray(body.directories)
      ? body.directories.filter((directory): directory is string => typeof directory === 'string')
      : [];
  } catch {
    return []; // Suggestions are a convenience; a failed lookup just shows nothing.
  }
}
