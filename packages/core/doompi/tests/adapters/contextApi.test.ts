import { describe, expect, it } from 'vitest';
import { createContextApi } from '../../src/adapters/contextApi.ts';
import type { ContextDetailFile } from '../../src/types/contextApi.ts';

const FILE: ContextDetailFile = {
  version: 1,
  revision: 4,
  items: [
    {
      itemKind: 'tool',
      name: 'read',
      owner: '@agimon-ai/doompi-read',
      source: 'extension',
      active: true,
      tokens: { schemaTokens: 90, promptTokens: 63, totalTokens: 153 },
      description: 'Reads a file',
      parameters: { type: 'object' },
    },
  ],
};

function handler(overrides: { file?: ContextDetailFile; sessionId?: string } = {}) {
  const sessionId = 'sessionId' in overrides ? overrides.sessionId : 's1';
  const file = 'file' in overrides ? overrides.file : FILE;
  return createContextApi({
    ...(sessionId === undefined ? {} : { sessionId }),
    readDetail: () => file,
  });
}

// The host strips the mount prefix, so routes are asked for as they are declared.
const url = (query: string): string => `http://session/item?${query}`;

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: string };
  return body.error ?? '';
}

describe('the context session API', () => {
  it('answers one row with the detail the projection left out', async () => {
    const response = await handler().fetch(new Request(url('kind=tool&name=read')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 4, item: FILE.items[0] });
  });

  it('refuses a kind it does not serve', async () => {
    const response = await handler().fetch(new Request(url('kind=widget&name=read')));

    expect(response.status).toBe(400);
  });

  it('reports an item this composition does not carry', async () => {
    const response = await handler().fetch(new Request(url('kind=tool&name=absent')));

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toContain('absent');
  });

  // The first half-second of a session's life, before the deferred boot publish.
  it('says the session has not reported yet rather than looking broken', async () => {
    const response = await handler({ file: undefined }).fetch(new Request(url('kind=tool&name=read')));

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toContain('not reported');
  });

  it('serves nothing when the host has no session', async () => {
    const response = await handler({ sessionId: undefined }).fetch(new Request(url('kind=tool&name=read')));

    expect(response.status).toBe(404);
  });

  it('turns away a route it does not own', async () => {
    const response = await handler().fetch(new Request('http://session/everything'));

    expect(response.status).toBe(404);
  });
});
