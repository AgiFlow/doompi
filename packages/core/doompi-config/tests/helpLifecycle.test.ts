import { createPiTestHost } from '@agimon-ai/doompi-extension-contracts/testing';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { describe, expect, it } from 'vitest';
import { registerConfigExtension } from '../src/extensions/pi';
import { CONFIG_HELP_SKILL, PACKAGE_SOURCE } from '../src/constants/config';

describe('Config Help lifecycle', () => {
  it('declares Help, follows provider replacement, and removes contributions on shutdown', async () => {
    const host = createPiTestHost();
    const connection = await host.cordis();
    await registerConfigExtension(host.pi);
    const first = createDoomHelpService('first');
    const provider = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, first));
    await provider;
    expect(first.listContributions()).toEqual([
      { source: PACKAGE_SOURCE, moduleUrl: expect.stringMatching(/extensions\/pi\.ts$/u), skills: [CONFIG_HELP_SKILL] },
    ]);
    await provider.dispose();
    expect(first.listContributions()).toEqual([]);
    const second = createDoomHelpService('second');
    const replacement = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, second));
    await replacement;
    expect(second.listContributions()).toHaveLength(1);
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.emit('session_shutdown', { reason: 'quit' });
    expect(second.listContributions()).toEqual([]);
    await replacement.dispose();
    await host.dispose();
    first.dispose();
    second.dispose();
  });
});
