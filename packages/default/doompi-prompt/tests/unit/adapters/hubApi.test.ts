import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { api, createPromptHubApi } from '../../../src/adapters/hubApi.ts';
import type { SavedPrompt, SavedPromptStore } from '../../../src/types/prompt.ts';
import { promptsUrl, promptUrl } from '../../../src/types/webPrompts.ts';

/** The hub mounts the app under /api/plugin/prompts and strips that prefix. */
function mounted(path: string): string {
  return `http://hub${path.replace('/api/plugin/prompts', '')}`;
}

function memoryStore(initial: SavedPrompt[] = []): SavedPromptStore & { entries: SavedPrompt[] } {
  const entries = [...initial];
  return {
    entries,
    list: async () => [...entries].sort((left, right) => left.name.localeCompare(right.name)),
    has: async (name) => entries.some((prompt) => prompt.name === name),
    save: async (prompt) => {
      const index = entries.findIndex((candidate) => candidate.name === prompt.name);
      if (index === -1) entries.push(prompt);
      else entries[index] = prompt;
      return { name: prompt.name, path: `/memory/${prompt.name}.md` };
    },
    remove: async (name) => {
      const index = entries.findIndex((candidate) => candidate.name === name);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    },
  };
}

function putRequest(name: string, body: unknown): Request {
  return new Request(mounted(promptUrl(name)), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('the prompt hub API', () => {
  it('lists saved prompts', async () => {
    const app = createPromptHubApi({ store: memoryStore([{ name: 'review', description: 'Review', text: 'Review' }]) });

    const response = await app.fetch(new Request(mounted(promptsUrl())));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      prompts: [{ name: 'review', description: 'Review', text: 'Review' }],
    });
  });

  it('reports a store it cannot read', async () => {
    const store = memoryStore();
    store.list = async () => {
      throw new Error('permission denied');
    };

    const response = await createPromptHubApi({ store }).fetch(new Request(mounted(promptsUrl())));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'permission denied' });
  });

  it('creates a prompt and derives its description', async () => {
    const store = memoryStore();

    const response = await createPromptHubApi({ store }).fetch(putRequest('review', { text: 'Review the diff\nnow' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      prompt: { name: 'review', description: 'Review the diff', text: 'Review the diff\nnow' },
      replaced: false,
    });
    expect(store.entries).toHaveLength(1);
  });

  it('reports a replacement as one', async () => {
    const store = memoryStore([{ name: 'review', description: 'old', text: 'old' }]);

    const response = await createPromptHubApi({ store }).fetch(putRequest('review', { text: 'new' }));

    await expect(response.json()).resolves.toMatchObject({ replaced: true });
    expect(store.entries).toEqual([{ name: 'review', description: 'new', text: 'new' }]);
  });

  it('refuses a name that would not work as a file or a command', async () => {
    const store = memoryStore();

    const response = await createPromptHubApi({ store }).fetch(putRequest('Bad Name', { text: 'body' }));

    expect(response.status).toBe(400);
    expect(store.entries).toEqual([]);
  });

  it('refuses an empty or non-JSON body', async () => {
    const app = createPromptHubApi({ store: memoryStore() });

    expect((await app.fetch(putRequest('review', { text: '   ' }))).status).toBe(400);
    expect((await app.fetch(putRequest('review', 'not json'))).status).toBe(400);
  });

  it('refuses a prompt beyond the size limit', async () => {
    const response = await createPromptHubApi({ store: memoryStore() }).fetch(
      putRequest('review', { text: 'x'.repeat(64 * 1024 + 1) }),
    );

    expect(response.status).toBe(413);
  });

  it('reports a failed write', async () => {
    const store = memoryStore();
    store.save = async () => {
      throw new Error('disk full');
    };

    const response = await createPromptHubApi({ store }).fetch(putRequest('review', { text: 'body' }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'disk full' });
  });

  it('deletes a prompt', async () => {
    const store = memoryStore([{ name: 'review', description: 'r', text: 'r' }]);

    const response = await createPromptHubApi({ store }).fetch(
      new Request(mounted(promptUrl('review')), { method: 'DELETE' }),
    );

    expect(response.status).toBe(200);
    expect(store.entries).toEqual([]);
  });

  it('answers 404 for a prompt that is not there', async () => {
    const response = await createPromptHubApi({ store: memoryStore() }).fetch(
      new Request(mounted(promptUrl('missing')), { method: 'DELETE' }),
    );

    expect(response.status).toBe(404);
  });

  it('refuses to delete an invalid name', async () => {
    const response = await createPromptHubApi({ store: memoryStore() }).fetch(
      new Request(mounted(promptUrl('../escape')), { method: 'DELETE' }),
    );

    expect(response.status).toBe(400);
  });

  it('reports a failed delete', async () => {
    const store = memoryStore([{ name: 'review', description: 'r', text: 'r' }]);
    store.remove = async () => {
      throw new Error('read-only filesystem');
    };

    const response = await createPromptHubApi({ store }).fetch(
      new Request(mounted(promptUrl('review')), { method: 'DELETE' }),
    );

    expect(response.status).toBe(500);
  });
});

describe('the exported hub contract', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const roots: string[] = [];

  afterEach(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('mounts under this package and answers from the agent directory', async () => {
    // Pointed at a temp agent directory, so the test never reads the developer's
    // own saved prompts and never writes into them.
    const root = await mkdtemp(path.join(tmpdir(), 'doompi-prompt-hub-'));
    roots.push(root);
    process.env.PI_CODING_AGENT_DIR = root;

    expect(api.basePath).toBe('prompts');
    const handler = api.start({} as never);
    const response = await handler.fetch(new Request(mounted(promptsUrl())));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ prompts: [] });
    expect(handler.close()).toBeUndefined();
  });
});
