import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { voiceReadinessApi } from '../src/services/voiceReadinessApi';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('serves readiness at global scope and knows nothing about client microphones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-readiness-api-'));
  roots.push(home);
  const context = { homeDirectory: home, environment: {} } as Parameters<typeof voiceReadinessApi.start>[0];
  const api = voiceReadinessApi.start(context);
  const send = (path: string, method: string) => api.fetch(new Request(`http://voice${path}`, { method }));
  try {
    expect((await send('/readiness', 'GET')).status).toBe(200);
    // The browser owns its input now; these routes went with the preference store.
    expect((await send('/clients/browser', 'GET')).status).toBe(404);
    expect((await send('/clients/browser/inputs', 'PUT')).status).toBe(404);
    expect((await send('/missing', 'GET')).status).toBe(404);
  } finally {
    api.close();
  }
});
