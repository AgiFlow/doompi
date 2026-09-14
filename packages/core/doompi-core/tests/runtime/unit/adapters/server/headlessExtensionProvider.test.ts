import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';

const registration = vi.hoisted(() => ({ entry: '' }));

vi.mock('../../../../../src/services/syncRegistration', async (importOriginal: () => Promise<object>) => ({
  ...(await importOriginal()),
  readSyncRegistration: () => (registration.entry === '' ? undefined : { package: { entry: registration.entry } }),
}));

const EXTENSION = `export default async function extension(pi) {
  pi.registerProvider('ext-provider', {
    name: 'Extension provider',
    baseUrl: 'http://localhost',
    apiKey: 'not-a-secret',
    api: 'anthropic-messages',
    models: [
      {
        id: 'ext-model',
        name: 'Ext model',
        provider: 'ext-provider',
        api: 'anthropic-messages',
        baseUrl: 'http://localhost',
        reasoning: false,
        input: ['text'],
        contextWindow: 65536,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
`;

// A provider that only exists once a Pi extension registers it must be in the model runtime
// before the configured default is looked up. When it is not, resolution misses and the session
// silently falls back to whichever model happens to be first in `getAvailable()`.
it('resolves a default model whose provider a Pi extension registers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-extension-provider-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'ext-provider', defaultModel: 'ext-model' }),
  );
  registration.entry = path.join(root, 'extension.js');
  fs.writeFileSync(registration.entry, EXTENSION);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

  let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
  try {
    session = await createHeadlessSessionHost({
      cwd,
      repoRoot: cwd,
      sessionId: 'extension-provider',
      sessionName: 'Extension provider',
      agentArgs: [],
      environment: {},
      candidates: [],
      selection: { majorMode: 'test', activeLayers: [], domains: [], state: {} },
    });
    await expect(session.runtime.readState()).resolves.toMatchObject({
      model: { provider: 'ext-provider', id: 'ext-model' },
    });
  } finally {
    await session?.dispose();
    registration.entry = '';
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
