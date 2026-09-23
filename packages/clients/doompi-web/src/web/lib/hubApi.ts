import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-core/sessionProtocol';
import { sessionApiPath } from '@agimon-ai/doompi-core/web';

import {
  DIRECTORIES_API_ROUTE,
  WORKSPACES_API_ROUTE,
  type PiSessionHistoryItem,
  type SessionSummary,
  type WorkspaceSummary,
} from '../../types/hub';
import { sealedHttpSession } from './sealedSession';
import { fetchWithStepUp } from './stepUp';

export type CreateSessionResult = { sessionId: string; session?: SessionSummary } | { error: string };
export type WorkspaceResult = { workspace: WorkspaceSummary } | { error: string };
export type WorkspacesResult = { workspaces: WorkspaceSummary[] } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asWorkspace(value: unknown): WorkspaceSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.root !== 'string') return undefined;
  return {
    id: value.id,
    root: value.root,
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export async function listWorkspaces(): Promise<WorkspacesResult> {
  try {
    const response = await sealedHttpSession.fetch(WORKSPACES_API_ROUTE);
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok && isRecord(body) && Array.isArray(body.workspaces)) {
      return {
        workspaces: body.workspaces.map(asWorkspace).filter((entry): entry is WorkspaceSummary => entry !== undefined),
      };
    }
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}

/** Admits a server-side repository root without starting a session. */
export async function admitWorkspace(root: string): Promise<WorkspaceResult> {
  try {
    const response = await fetchWithStepUp(WORKSPACES_API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const workspace = isRecord(body) ? asWorkspace(body.workspace) : undefined;
    if (response.ok && workspace !== undefined) return { workspace };
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}

export type RemoveWorkspaceResult = { ok: true } | { error: string };

/** Unregisters a workspace from DoomPi without touching its files on disk. */
export async function removeWorkspace(workspaceId: string): Promise<RemoveWorkspaceResult> {
  try {
    const response = await sealedHttpSession.fetch(`${WORKSPACES_API_ROUTE}/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
    if (response.ok) return { ok: true };
    const body: unknown = await response.json().catch(() => undefined);
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}

/** Starts a session in an already admitted workspace. */
export async function createWorkspaceSession(
  workspaceId: string,
  input: { name?: string } = {},
): Promise<CreateSessionResult> {
  let response: Response;
  try {
    response = await fetchWithStepUp(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name }),
    });
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || typeof body.sessionId !== 'string') {
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  }
  const sessionId = body.sessionId;
  try {
    const detail = await sealedHttpSession.fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
    );
    const session: unknown = await detail.json().catch(() => undefined);
    if (detail.ok && isRecord(session) && session.id === sessionId) {
      return { sessionId, session: session as unknown as SessionSummary };
    }
  } catch {
    // The socket can still deliver the summary; this read only closes a missed-event race.
  }
  return { sessionId };
}

/** Compatibility flow for callers that have not admitted a workspace yet. */
export async function createSession(input: { cwd: string; name?: string }): Promise<CreateSessionResult> {
  const admission = await admitWorkspace(input.cwd);
  if ('error' in admission) return admission;
  return createWorkspaceSession(admission.workspace.id, { name: input.name });
}

export type StopSessionResult = { ok: true } | { error: string };

/** Asks the hub to stop a session's server; the rail card leaves once the server withdraws its record. */
export async function stopSession(sessionId: string): Promise<StopSessionResult> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(`${sessionApiPath(sessionId)}`, {
      method: 'DELETE',
    });
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

export type RestartSessionResult = { ok: true } | { error: string };

/**
 * Asks the hub to replace a session's server, keeping its id.
 *
 * A running server reads the composition once. Restart syncs workspace changes
 * before reopening the session, so changed extensions and APIs take effect.
 */
export async function restartSession(sessionId: string): Promise<RestartSessionResult> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(`${sessionApiPath(sessionId)}/restart`, {
      method: 'POST',
    });
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

export type ReviveSessionResult = { ok: true } | { error: string };

/**
 * Asks the hub to reopen a recorded session it has not started yet.
 *
 * Step-up gated like creating one, because it is the same act: an agent begins
 * running in a directory. The card turns live when the resulting upsert lands.
 */
export async function reviveSession(sessionId: string): Promise<ReviveSessionResult> {
  let response: Response;
  try {
    response = await fetchWithStepUp(`${sessionApiPath(sessionId)}/revive`, { method: 'POST' });
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

export async function readDormantTranscriptPage(
  sessionId: string,
  request: TranscriptPageRequest,
  signal?: AbortSignal,
): Promise<TranscriptPage> {
  const params = new URLSearchParams();
  if (request.cursor !== undefined) params.set('cursor', request.cursor);
  if (request.direction !== undefined) params.set('direction', request.direction);
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  const query = params.toString();
  const response = await sealedHttpSession.fetch(
    `${sessionApiPath(sessionId)}/transcript${query === '' ? '' : `?${query}`}`,
    signal === undefined ? {} : { signal },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`;
    throw new Error(message);
  }
  if (!isRecord(body) || !Array.isArray(body.entries)) throw new Error('The saved transcript response was invalid.');
  return body as unknown as TranscriptPage;
}
export type SessionHistoryResult = { sessions: PiSessionHistoryItem[] } | { error: string };

/** Lists the Pi threads saved for a live session's workspace. */
export function listSessionHistory(sessionId: string): Promise<SessionHistoryResult> {
  return listHistoryAt(`${sessionApiPath(sessionId)}/history`);
}

export type ResumeSessionResult = { sessionId: string; session?: SessionSummary } | { error: string };

async function listHistoryAt(path: string): Promise<SessionHistoryResult> {
  try {
    const response = await sealedHttpSession.fetch(path);
    const body = (await response.json()) as unknown;
    if (response.ok && isRecord(body) && Array.isArray(body.sessions)) {
      return {
        sessions: body.sessions.filter(
          (session): session is PiSessionHistoryItem =>
            isRecord(session) &&
            typeof session.id === 'string' &&
            (session.name === undefined || typeof session.name === 'string') &&
            typeof session.firstMessage === 'string' &&
            typeof session.createdAt === 'string' &&
            typeof session.updatedAt === 'string' &&
            typeof session.messageCount === 'number',
        ),
      };
    }
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}

/** Lists saved history without requiring a live session in the workspace. */
export function listWorkspaceHistory(workspaceId: string): Promise<SessionHistoryResult> {
  return listHistoryAt(`/api/workspaces/${encodeURIComponent(workspaceId)}/history`);
}

/** Starts one saved thread without replacing another live session. */
export async function resumeWorkspaceSession(
  workspaceId: string,
  targetSessionId: string,
): Promise<ResumeSessionResult> {
  try {
    const response = await fetchWithStepUp(`/api/workspaces/${encodeURIComponent(workspaceId)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId }),
    });
    const body = (await response.json()) as unknown;
    if (!response.ok || !isRecord(body) || typeof body.sessionId !== 'string') {
      return {
        error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
      };
    }
    const sessionId = body.sessionId;
    try {
      const detail = await sealedHttpSession.fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      const session: unknown = await detail.json().catch(() => undefined);
      if (detail.ok && isRecord(session) && session.id === sessionId) {
        return { sessionId, session: session as unknown as SessionSummary };
      }
    } catch {
      // The socket can still deliver the summary; this read only closes a missed-event race.
    }
    return { sessionId };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}

/** Replaces one live card with a selected Pi thread from the same workspace. */
export async function resumeSession(sessionId: string, targetSessionId: string): Promise<ResumeSessionResult> {
  try {
    const response = await fetchWithStepUp(`${sessionApiPath(sessionId)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId }),
    });
    const body = (await response.json()) as unknown;
    if (response.ok && isRecord(body) && typeof body.sessionId === 'string') return { sessionId: body.sessionId };
    return {
      error: isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`,
    };
  } catch {
    return { error: 'The cockpit hub is unreachable.' };
  }
}
/** File paths under a session's cwd matching the query, for @ completion. */
export async function searchSessionFiles(sessionId: string, query: string): Promise<string[]> {
  try {
    const response = await sealedHttpSession.fetch(
      `${sessionApiPath(sessionId)}/plugins/files/?q=${encodeURIComponent(query)}`,
    );
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
    const response = await sealedHttpSession.fetch(`${DIRECTORIES_API_ROUTE}?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { directories?: unknown };
    return Array.isArray(body.directories)
      ? body.directories.filter((directory): directory is string => typeof directory === 'string')
      : [];
  } catch {
    return []; // Suggestions are a convenience; a failed lookup just shows nothing.
  }
}
