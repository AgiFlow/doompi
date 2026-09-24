import { DOOM_API_CALLER_LOCALITY_HEADER, DOOM_API_CALLER_STEP_UP_HEADER } from '@agimon-ai/doompi-core/packageApi';
import { describe, expect, it, vi } from 'vitest';

import { createComputerUseApi } from '../../../src/services/computerUseApi';
import { COMPUTER_USE_ROUTES } from '../../../src/types/computerUseApi';

describe('computer-use activation without a Desktop host', () => {
  it('rejects caller stamps and forged Desktop markers before creating an activation', async () => {
    const publish = vi.fn();
    const broker = createComputerUseApi({
      sessionId: 'session',
      hubToken: 'hub',
      directEvents: { publish, subscribe: () => () => undefined, close: () => undefined },
    });
    try {
      for (const headers of [
        { [DOOM_API_CALLER_LOCALITY_HEADER]: 'local', [DOOM_API_CALLER_STEP_UP_HEADER]: 'not-required' },
        { 'x-doompi-desktop': 'forged', [DOOM_API_CALLER_LOCALITY_HEADER]: 'local' },
      ]) {
        const response = await broker.fetch(
          new Request(`http://host${COMPUTER_USE_ROUTES.activate}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ target: { windowId: 'window', bundleId: 'fixture.app' }, durationMs: 60_000 }),
          }),
        );
        expect(response.status).toBe(404);
        expect(broker.state()).toMatchObject({ phase: 'inactive', revision: 0 });
      }
      expect(publish).not.toHaveBeenCalled();
      await expect(broker.sessionClient().observe()).rejects.toThrow(/Desktop computer use is unavailable/u);
    } finally {
      broker.close();
    }
  });
});
