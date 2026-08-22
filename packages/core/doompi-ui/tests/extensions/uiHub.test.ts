import type { DoomExtensionContext } from '@agimon-ai/doompi-extension-contracts/config';
import { describe, expect, it, vi } from 'vitest';
import { createDoomUiHub } from '../../src/services/hub/uiHub.ts';
import { DoomLeaderRegistry } from '../../src/services/leader/leaderRegistry.ts';

function createHub() {
  const diagnostics = vi.fn();
  const leaderRegistry = new DoomLeaderRegistry();
  return { diagnostics, leaderRegistry, hub: createDoomUiHub({ leaderRegistry, reportDiagnostics: diagnostics }) };
}

describe('doom/ui-hub', () => {
  it('owns leader registrations and removes them through their disposer', () => {
    const { hub, leaderRegistry } = createHub();
    const handle = hub.registerLeader({
      source: '@agimon-ai/example',
      bindings: [
        {
          id: 'example.open',
          path: [{ key: 'x', label: 'example' }],
          command: { name: 'example' },
        },
      ],
    });

    expect(leaderRegistry.getGroup([])?.options.some(({ key }) => key === 'x')).toBe(true);
    handle.dispose();
    expect(leaderRegistry.getGroup([])?.options.some(({ key }) => key === 'x')).toBe(false);
  });

  it('routes leader actions only while both the provider context and handler are live', async () => {
    const { hub } = createHub();
    const handler = vi.fn();
    const context = { sessionManager: { getSessionId: () => 'session-1' } } satisfies DoomExtensionContext;
    const dispose = hub.registerLeaderActions({
      source: '@agimon-ai/example',
      handlers: { run: handler },
      onError: vi.fn(),
    });

    hub.invokeLeaderAction('@agimon-ai/example', 'run');
    expect(handler).not.toHaveBeenCalled();
    hub.setContext(context);
    hub.invokeLeaderAction('@agimon-ai/example', 'run');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(context));
    dispose();
    hub.invokeLeaderAction('@agimon-ai/example', 'run');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('aggregates footer and config contributions without an EventBus', async () => {
    const { hub } = createHub();
    const context = { sessionManager: { getSessionId: () => 'session-1' } } satisfies DoomExtensionContext;
    hub.setContext(context);
    const footer = hub.registerFooter({ source: '@agimon-ai/example', id: 'status', order: 10 });
    footer.update({ fullText: 'ready', compactText: 'ok' });
    expect(hub.footer.getStatuses()).toMatchObject([{ source: '@agimon-ai/example', fullText: 'ready' }]);

    const invoked = vi.fn();
    const config = hub.registerConfig({
      source: '@agimon-ai/example',
      listSections: () => [{ id: 'example', title: 'Example', order: 10, fields: [] }],
      handlers: { set: invoked },
      onError: vi.fn(),
    });
    expect(hub.config.getSections()).toMatchObject([{ source: '@agimon-ai/example', id: 'example' }]);
    hub.config.invoke({ source: '@agimon-ai/example', sectionId: 'example', fieldId: 'value', action: 'set' });
    await vi.waitFor(() => expect(invoked).toHaveBeenCalled());

    config.dispose();
    footer.dispose();
    expect(hub.config.getSections()).toEqual([]);
    expect(hub.footer.getStatuses()).toEqual([]);
  });
});
