import { describe, expect, it } from 'vitest';
import { DefaultSandboxExtensionService } from '../../../src/services/extensionService.ts';

describe('DefaultSandboxExtensionService', () => {
  it('reports a host session and how to contain it', async () => {
    const service = new DefaultSandboxExtensionService({});

    await expect(service.execute()).resolves.toEqual({
      message: 'Host session: relaunch with dpi --sandbox to contain the agent in a container.',
      level: 'info',
    });
  });

  it('reports a sandboxed session from the container marker', async () => {
    const service = new DefaultSandboxExtensionService({ DOOMPI_SANDBOX: '1' });

    await expect(service.execute()).resolves.toEqual({
      message: 'Sandboxed session: the agent, extensions, and tools run inside the container.',
      level: 'info',
    });
  });
});
