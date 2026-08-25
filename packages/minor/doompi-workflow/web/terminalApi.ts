import {
  WORKFLOW_SCREEN_EVENT,
  workflowRunPath,
  type WorkflowArtifactContentResponse,
  type WorkflowArtifactsResponse,
  type WorkflowControlResponse,
  type WorkflowScreenEvent,
} from '../src/types/webWorkflowTerminal.ts';

/**
 * The page's half of this package's hub API: one run's terminal and the files
 * its run directory holds. The only place the cockpit talks HTTP for a
 * workflow, so if the transport changes, it changes here alone.
 */

const UNREACHABLE = 'The cockpit hub is unreachable.';
const JSON_HEADERS = { 'content-type': 'application/json' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error a route reported, or a generic one; never an empty message. */
function errorOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
  } catch {
    return { status: 0, body: undefined };
  }
}

/**
 * Follows one run's screen until the run settles or the caller stops.
 *
 * Returns the stop function. The stream is server-sent events, so a hub that
 * restarts reconnects on its own and the page keeps painting.
 */
export function followScreen(
  workspace: string,
  runKey: string,
  onEvent: (event: WorkflowScreenEvent) => void,
): () => void {
  const source = new EventSource(`${workflowRunPath(workspace, runKey)}/screen/stream`);
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
export async function takeControl(workspace: string, runKey: string, token?: string): Promise<WorkflowControlResponse> {
  const { status, body } = await post(`${workflowRunPath(workspace, runKey)}/control`, { token });
  if (status === 0) return { held: false, reason: UNREACHABLE };
  if (isRecord(body) && typeof body.held === 'boolean') return body as unknown as WorkflowControlResponse;
  return { held: false, reason: errorOf(body, 'The run refused the keyboard.') };
}

export async function releaseControl(workspace: string, runKey: string, token: string): Promise<void> {
  await post(`${workflowRunPath(workspace, runKey)}/control`, { token, release: true });
}

/** Sends literal keystrokes; the reason comes back when the lease has moved on. */
export async function sendKeys(
  workspace: string,
  runKey: string,
  token: string,
  data: string,
): Promise<{ error?: string }> {
  const { status, body } = await post(`${workflowRunPath(workspace, runKey)}/keys`, { token, data });
  if (status === 0) return { error: UNREACHABLE };
  if (status === 204) return {};
  return { error: errorOf(body, 'The run would not take those keys.') };
}

/** Matches the run's terminal to the viewport of whoever holds the keyboard. */
export async function resizeRun(
  workspace: string,
  runKey: string,
  token: string,
  columns: number,
  rows: number,
): Promise<void> {
  await post(`${workflowRunPath(workspace, runKey)}/resize`, { token, columns, rows });
}

export type ArtifactsResult = { artifacts: WorkflowArtifactsResponse } | { error: string };

export async function fetchArtifacts(workspace: string, runKey: string): Promise<ArtifactsResult> {
  try {
    const response = await fetch(`${workflowRunPath(workspace, runKey)}/artifacts`);
    const body = (await response.json()) as unknown;
    if (!response.ok) return { error: errorOf(body, 'This run has no directory to read.') };
    return { artifacts: body as WorkflowArtifactsResponse };
  } catch {
    return { error: UNREACHABLE };
  }
}

export type ArtifactResult = { artifact: WorkflowArtifactContentResponse } | { error: string };

export async function fetchArtifact(workspace: string, runKey: string, path: string): Promise<ArtifactResult> {
  try {
    const response = await fetch(
      `${workflowRunPath(workspace, runKey)}/artifacts/${path.split('/').map(encodeURIComponent).join('/')}`,
    );
    const body = (await response.json()) as unknown;
    if (!response.ok) return { error: errorOf(body, 'That file has not been written.') };
    return { artifact: body as WorkflowArtifactContentResponse };
  } catch {
    return { error: UNREACHABLE };
  }
}
