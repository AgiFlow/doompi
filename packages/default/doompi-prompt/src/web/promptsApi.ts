import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import {
  isPromptErrorResponse,
  promptsUrl,
  promptUrl,
  type SavedPromptListResponse,
  type SavedPromptView,
} from '../types/webPrompts.ts';

/**
 * The browser half of the prompt library API.
 *
 * DESIGN PATTERNS:
 * - Every call goes through the sealed transport, like every other cockpit
 *   plugin, so a remote listener gets the same protection the host expects.
 * - Failures come back as values, never thrown: the panel shows one message
 *   next to the thing that failed instead of losing the page to an error.
 * - URLs are built by src/types, never assembled here.
 *
 * AVOID:
 * - Caching answers in this module. The panel owns state.
 */

const UNREACHABLE = 'The hub did not answer.';
const ABORT_ERROR = 'AbortError';

interface Failure {
  error: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === ABORT_ERROR;
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isPromptErrorResponse(body)) return body.error;
  } catch {
    // A body that is not JSON tells the reader nothing useful; the status does.
  }
  return `The hub answered ${String(response.status)}.`;
}

export async function fetchSavedPrompts(
  signal?: AbortSignal,
): Promise<{ prompts: readonly SavedPromptView[] } | Failure> {
  let response: Response;
  try {
    response = await sealedTransport.fetch(promptsUrl(), signal ? { signal } : {});
  } catch (error) {
    // An aborted request is the caller replacing it, not a failure to report.
    if (isAbort(error)) return { error: '' };
    return { error: UNREACHABLE };
  }

  if (!response.ok) return { error: await readError(response) };
  try {
    const body = (await response.json()) as SavedPromptListResponse;
    return { prompts: body.prompts ?? [] };
  } catch {
    return { error: 'The hub sent a malformed prompt list.' };
  }
}

export async function saveSavedPrompt(name: string, text: string): Promise<Failure | undefined> {
  let response: Response;
  try {
    response = await sealedTransport.fetch(promptUrl(name), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    return { error: UNREACHABLE };
  }
  return response.ok ? undefined : { error: await readError(response) };
}

export async function deleteSavedPrompt(name: string): Promise<Failure | undefined> {
  let response: Response;
  try {
    response = await sealedTransport.fetch(promptUrl(name), { method: 'DELETE' });
  } catch {
    return { error: UNREACHABLE };
  }
  return response.ok ? undefined : { error: await readError(response) };
}
