import { describe, expect, it, vi } from 'vitest';

const { missingUiMessage } = vi.hoisted(() => ({
  missingUiMessage: 'doom-pi-ui is not installed in this headless host',
}));

vi.mock('@agimon-ai/doompi-ui/leader', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/skills', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/components/doomOverlay', () => {
  throw new Error(missingUiMessage);
});
vi.mock('@agimon-ai/doompi-ui/footer', () => {
  throw new Error(missingUiMessage);
});

import { createPiTestHost } from '@agimon-ai/doompi-extension-contracts/testing';

describe('doom-workflow headless entry', () => {
  it('loads the sole standard Pi entry without the optional UI provider', async () => {
    vi.resetModules();
    const standard = await import('../src/exports/extensions/pi.ts');
    // A host with no terminal is also a host with no doompi-ui on its module
    // path, and the entry has to survive both at once.
    const host = createPiTestHost({ hasUI: false, mode: 'rpc' });

    await expect(standard.default(host.pi)).resolves.toBeUndefined();

    expect(host.tools.length).toBeGreaterThan(0);
    await host.dispose();
  });
});
