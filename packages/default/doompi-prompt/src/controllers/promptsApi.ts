import { NAME_PARAM, MAX_PROMPT_BYTES, STATUS } from '../constants/promptsApi';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';
import { Hono } from 'hono';
import { PROMPT_NAME_RULE } from '../constants/savedPromptDocument';
import { describePrompt, isValidPromptName } from '../services/savedPromptDocument';
import type { SavedPrompt, SavedPromptStore } from '../types/prompt';
import { API_BASE_PATH, PROMPTS_PATH } from '../constants/webPrompts';
import { type SavedPromptListResponse, type SavedPromptView, type SavedPromptWriteResponse } from '../types/webPrompts';
import { createNodeSavedPromptStore } from '../services/promptStore';

/**
 * This package's HTTP surface, served by the cockpit hub.
 *
 * DESIGN PATTERNS:
 * - Hub scope, not session scope: saved prompts live in the agent directory and
 *   belong to the machine, so no route names a session.
 * - The store is injected. The same port the Pi commands write through answers
 *   the browser, so the two surfaces cannot disagree about the format on disk.
 * - Routes are declared relative to the mount the host strips.
 *
 * AVOID:
 * - Validating names here by hand. The rule lives in src/services with the
 *   document format it protects.
 */

export interface HubApiOptions {
  store?: SavedPromptStore;
}

function toView(prompt: SavedPrompt): SavedPromptView {
  return { name: prompt.name, description: prompt.description, text: prompt.text };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The prompt library could not complete that request.';
}

/** Reads `{ text }` out of a request body, or the reason it is unusable. */
async function readText(request: Request): Promise<{ text: string } | { error: string }> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // A body that is not JSON is a client mistake, reported as one.
    return { error: 'The request body must be JSON.' };
  }
  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) return { error: 'A non-empty text is required.' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) return { error: 'That prompt is too large to save.' };
  return { text };
}

export function createPromptHubApi(options: HubApiOptions = {}): Hono {
  const store = options.store ?? createNodeSavedPromptStore();
  const app = new Hono();

  app.get(PROMPTS_PATH, async (context) => {
    try {
      const prompts = await store.list();
      return context.json<SavedPromptListResponse>({ prompts: prompts.map(toView) });
    } catch (error) {
      return context.json({ error: failureMessage(error) }, STATUS.failed);
    }
  });

  app.put(`${PROMPTS_PATH}/:${NAME_PARAM}`, async (context) => {
    const name = context.req.param(NAME_PARAM);
    if (!isValidPromptName(name)) {
      return context.json(
        { error: `"${name}" is not a usable prompt name. Use ${PROMPT_NAME_RULE}.` },
        STATUS.badRequest,
      );
    }

    const body = await readText(context.req.raw);
    if ('error' in body) {
      const status = body.error.includes('too large') ? STATUS.tooLarge : STATUS.badRequest;
      return context.json({ error: body.error }, status);
    }

    try {
      const replaced = await store.has(name);
      const prompt: SavedPrompt = { name, description: describePrompt(body.text), text: body.text };
      await store.save(prompt);
      return context.json<SavedPromptWriteResponse>({ prompt: toView(prompt), replaced });
    } catch (error) {
      return context.json({ error: failureMessage(error) }, STATUS.failed);
    }
  });

  app.delete(`${PROMPTS_PATH}/:${NAME_PARAM}`, async (context) => {
    const name = context.req.param(NAME_PARAM);
    if (!isValidPromptName(name)) {
      return context.json({ error: `"${name}" is not a usable prompt name.` }, STATUS.badRequest);
    }

    try {
      const removed = await store.remove(name);
      if (!removed) return context.json({ error: `No saved prompt is named "${name}".` }, STATUS.notFound);
      return context.json({ name });
    } catch (error) {
      return context.json({ error: failureMessage(error) }, STATUS.failed);
    }
  });

  return app;
}

/** The named export a host imports from this package's built entry. */
export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(_context: DoomApiContext): DoomApiHandler {
    const app = createPromptHubApi();
    return {
      fetch: (request) => app.fetch(request),
      // Nothing outlives a request here; the store holds no handles.
      close: () => undefined,
    };
  },
};
