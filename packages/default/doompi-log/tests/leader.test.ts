import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLogMetricsLeaderBinding } from '../src/adapters/pi/extension.ts';

const registerLeaderContribution = vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() }));

function uiHub(): DoomUiHubService {
  return {
    registerLeader: registerLeaderContribution,
    registerLeaderActions: vi.fn(),
    registerFooter: vi.fn(),
    registerConfig: vi.fn(),
  } as unknown as DoomUiHubService;
}

describe('doom-log leader contribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the ordered h/l binding for the active session', () => {
    registerLogMetricsLeaderBinding(uiHub());
    expect(registerLeaderContribution).toHaveBeenCalledWith({
      source: '@agimon-ai/doompi-log',
      bindings: [
        {
          id: 'log.metrics',
          path: [
            { key: 'h', label: 'help', detail: 'package docs and logs', order: 70 },
            { key: 'l', label: 'logs', detail: 'telemetry' },
          ],
          command: { name: 'log-metrics' },
        },
      ],
    });
  });

  it('supports a custom leader ownership source', () => {
    registerLogMetricsLeaderBinding(uiHub(), { source: '@custom/owner' });

    expect(registerLeaderContribution).toHaveBeenCalledWith(expect.objectContaining({ source: '@custom/owner' }));
  });

  it('returns the typed registration disposer', () => {
    const unregister = vi.fn();
    registerLeaderContribution.mockReturnValueOnce({ update: vi.fn(), dispose: unregister });
    const dispose = registerLogMetricsLeaderBinding(uiHub());
    dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });
});
