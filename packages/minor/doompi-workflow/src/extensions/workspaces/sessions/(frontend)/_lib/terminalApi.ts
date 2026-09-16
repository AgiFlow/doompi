import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import { api } from '../../../../../../generated/client';
import { ARTIFACT_DOWNLOAD_PARAM, ARTIFACT_NAME_PARAM, ARTIFACT_RAW_PARAM } from '../../../../../types/apiRoutes';
import {
  WORKFLOW_SCREEN_EVENT,
  type WorkflowArtifactContentResponse,
  type WorkflowArtifactsResponse,
  type WorkflowControlResponse,
  type WorkflowDeleteResponse,
  type WorkflowScreenEvent,
} from '../../../../../types/webWorkflowTerminal';

/**
 * The page's half of this package's hub API: one run's terminal and the files
 * its run directory holds.
 *
 * These are adapters now, not a transport. The generated client owns the URL
 * and the sealed transport with it, so nothing here spells a mount. What stays
 * is this package's own vocabulary: which refusals the reader is shown, and the
 * shapes the terminal expects back.
 *
 * A run belongs to its multiplexer rather than to a session, so the same API
 * answers at the hub and inside a session's own server. Passing a session id
 * addresses that session's copy and passing none addresses the hub. The deleted
 * builder made that branch the other way round: it always built the hub's
 * absolute URL, then rewrote the plugin prefix into the session's with
 * String.replace, so a session's URL was a hub URL with its head swapped.
 */

const UNREACHABLE = 'The cockpit hub is unreachable.';

/** One of the scopes this API mounts at; every route is the same on all of them. */
type WorkflowScope = typeof api.global;

/** The hub, or one session's own copy of it; a null session id is the hub. */
function scoped(sessionId?: string | null): WorkflowScope {
  return sessionId == null ? api.global : api.session(sessionId);
}

/** The run every route addresses, as the route table's two path parameters. */
function runParams(workspace: string, runKey: string): { workspace: string; runKey: string } {
  return { workspace, runKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The message a reader is shown: the route's own words, or why there were none.
 *
 * `error` is optional because an answered call that simply carried the wrong
 * shape reaches here too, and that result has no error field at all.
 */
function messageOf(result: { status: number; error?: string }, fallback: string): string {
  if (result.status === 0) return UNREACHABLE;
  return result.error === undefined || result.error === '' ? fallback : result.error;
}

/**
 * One artifact's URL, with its path filled in.
 *
 * An artifact is named by its path inside the run directory, which Hono matches
 * as the one multi-segment parameter `:name{.+}`. The client's own `params`
 * substitution fills a single segment and percent-encodes the separating slash
 * with it, which would move every nested artifact's URL, so that one segment is
 * substituted here instead: each segment encoded, the slashes between them
 * kept. Everything left of it still comes from the client.
 */
function artifactUrl(
  scope: WorkflowScope,
  workspace: string,
  runKey: string,
  artifactPath: string,
  query?: Record<string, number>,
): string {
  return scope.artifact
    .url({ params: runParams(workspace, runKey), ...(query === undefined ? {} : { query }) })
    .replace(ARTIFACT_NAME_PARAM, artifactPath.split('/').map(encodeURIComponent).join('/'));
}

/**
 * Follows one run's screen until the run settles or the caller stops.
 *
 * Returns the stop function. The stream is server-sent events, so a hub that
 * restarts reconnects on its own and the page keeps painting. The route is
 * declared `stream: true`, which is why the client hands out its address and no
 * call: an `EventSource` opens it directly, and a relayed call would buffer a
 * response that never ends.
 */
export function followScreen(
  workspace: string,
  runKey: string,
  onEvent: (event: WorkflowScreenEvent) => void,
  sessionId?: string | null,
): () => void {
  const source = new EventSource(scoped(sessionId).screen.url({ params: runParams(workspace, runKey) }));
  const handler = (message: MessageEvent<string>): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return; // A torn frame; the next one repaints the whole screen anyway.
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.lines)) return;
    onEvent(parsed as unknown as WorkflowScreenEvent);
  };
  source.addEventListener(WORKFLOW_SCREEN_EVENT, handler as EventListener);
  return () => {
    source.removeEventListener(WORKFLOW_SCREEN_EVENT, handler as EventListener);
    source.close();
  };
}

/** Takes the keyboard for one run, renewing when this page already holds it. */
export async function takeControl(
  workspace: string,
  runKey: string,
  token?: string,
  sessionId?: string | null,
): Promise<WorkflowControlResponse> {
  const result = await scoped(sessionId).control({ params: runParams(workspace, runKey), body: { token } });
  if (result.status === 0) return { held: false, reason: UNREACHABLE };
  // A refusal carries the same shape as a grant, so the body is read before the
  // status: a 409 says who holds the keyboard and why, which is the answer.
  if (isRecord(result.data) && typeof result.data.held === 'boolean') {
    return result.data as unknown as WorkflowControlResponse;
  }
  return { held: false, reason: messageOf(result, 'The run refused the keyboard.') };
}

export async function releaseControl(
  workspace: string,
  runKey: string,
  token: string,
  sessionId?: string | null,
): Promise<void> {
  await scoped(sessionId).control({ params: runParams(workspace, runKey), body: { token, release: true } });
}

/** Sends literal keystrokes; the reason comes back when the lease has moved on. */
export async function sendKeys(
  workspace: string,
  runKey: string,
  token: string,
  data: string,
  sessionId?: string | null,
): Promise<{ error?: string }> {
  const result = await scoped(sessionId).keys({ params: runParams(workspace, runKey), body: { token, data } });
  if (result.ok) return {};
  return { error: messageOf(result, 'The run would not take those keys.') };
}

/** Matches the run's terminal to the viewport of whoever holds the keyboard. */
export async function resizeRun(
  workspace: string,
  runKey: string,
  token: string,
  columns: number,
  rows: number,
  sessionId?: string | null,
): Promise<void> {
  await scoped(sessionId).resize({ params: runParams(workspace, runKey), body: { token, columns, rows } });
}

export type DeleteWorkflowResult = { result: WorkflowDeleteResponse } | { error: string };

/** Permanently removes one settled run and its run directory. */
export async function deleteWorkflowRun(
  workspace: string,
  runKey: string,
  sessionId?: string | null,
): Promise<DeleteWorkflowResult> {
  const result = await scoped(sessionId).remove({ params: runParams(workspace, runKey) });
  if (!result.ok) return { error: messageOf(result, 'The workflow could not be deleted.') };
  if (result.data.deleted === true) return { result: { deleted: true } };
  return { error: 'The workflow hub returned an invalid deletion response.' };
}

export type ArtifactsResult = { artifacts: WorkflowArtifactsResponse } | { error: string };

export async function fetchArtifacts(
  workspace: string,
  runKey: string,
  sessionId?: string | null,
): Promise<ArtifactsResult> {
  const result = await scoped(sessionId).artifacts({ params: runParams(workspace, runKey) });
  if (!result.ok) return { error: messageOf(result, 'This run has no directory to read.') };
  return { artifacts: result.data };
}

export type ArtifactResult = { artifact: WorkflowArtifactContentResponse } | { error: string };

/** Trusted same-origin URL for browser-native media previews and downloads. */
export function artifactContentUrl(
  workspace: string,
  runKey: string,
  path: string,
  download = false,
  sessionId?: string | null,
): string {
  return artifactUrl(scoped(sessionId), workspace, runKey, path, {
    [ARTIFACT_RAW_PARAM]: 1,
    ...(download ? { [ARTIFACT_DOWNLOAD_PARAM]: 1 } : {}),
  });
}

/**
 * One artifact's metadata and text.
 *
 * The only route here that addresses itself rather than being called: its path
 * parameter spans segments, so the URL comes from `artifactUrl` and the request
 * goes over the same sealed transport the client is built on.
 */
export async function fetchArtifact(
  workspace: string,
  runKey: string,
  path: string,
  sessionId?: string | null,
): Promise<ArtifactResult> {
  try {
    const response = await sealedTransport.fetch(artifactUrl(scoped(sessionId), workspace, runKey, path));
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const error = isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : '';
      return { error: error === '' ? 'That file has not been written.' : error };
    }
    return { artifact: body as WorkflowArtifactContentResponse };
  } catch {
    return { error: UNREACHABLE };
  }
}
