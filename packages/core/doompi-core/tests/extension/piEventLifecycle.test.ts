import { describe, expect, it, vi } from 'vitest';

import { definePiExtension } from '../../src/extensions/piExtension';
import { createPiTestHost } from '../../src/testing/pi/testHost';

describe('Pi event subscription lifecycle', () => {
  it('releases contributed handlers on disposal and does not duplicate them on remount', async () => {
    const host = createPiTestHost();
    const { root } = await host.cordis();
    const handler = vi.fn();
    const extension = definePiExtension({ name: 'event-lifecycle', events: { agent_start: handler } });

    try {
      for (let generation = 1; generation <= 2; generation += 1) {
        const fiber = root.plugin(async (context) => {
          await extension.install(context, host.pi);
        });
        await fiber;
        expect(host.handlers('agent_start')).toHaveLength(1);
        await host.emit('agent_start');
        expect(handler).toHaveBeenCalledTimes(generation);

        await fiber.dispose();
        await fiber.dispose();
        expect(host.handlers('agent_start')).toEqual([]);
        await host.emit('agent_start');
        expect(handler).toHaveBeenCalledTimes(generation);
      }
    } finally {
      await host.dispose();
    }
  });

  it('preserves native event results and cleans up subscriptions after failed startup', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const patch = { systemPrompt: 'Updated instructions' };
    const handler = vi.fn(() => patch);
    const shutdownHandlers = host.handlers('session_shutdown');
    const extension = definePiExtension({
      name: 'failed-event-startup',
      events: { before_agent_start: handler },
      async onStart() {
        const results = await host.emit('before_agent_start', {
          prompt: 'Hello',
          systemPrompt: 'Original instructions',
        });
        expect(results).toEqual([patch]);
        expect(results[0]).toBe(patch);
        throw new Error('startup failed');
      },
    });

    try {
      await expect(extension(host.pi)).rejects.toThrow('startup failed');
      expect(host.handlers('before_agent_start')).toEqual([]);
      expect(host.handlers('session_shutdown')).toEqual(shutdownHandlers);
      await host.emit('before_agent_start');
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await host.dispose();
    }
  });

  it('keeps the current dispatch snapshot while removing handlers from later dispatches', async () => {
    const host = createPiTestHost();
    const { root } = await host.cordis();
    const handler = vi.fn();
    const extension = definePiExtension({ name: 'dispatch-snapshot', events: { agent_start: handler } });
    let disposePlugin: () => Promise<void> = async () => undefined;
    const unsubscribeFirst = host.pi.on('agent_start', async () => {
      await disposePlugin();
    });

    try {
      const fiber = root.plugin(async (context) => {
        await extension.install(context, host.pi);
      });
      await fiber;
      disposePlugin = async () => {
        await fiber.dispose();
      };

      await host.emit('agent_start');
      expect(handler).toHaveBeenCalledOnce();
      await host.emit('agent_start');
      expect(handler).toHaveBeenCalledOnce();
      expect(host.handlers('agent_start')).toHaveLength(1);
    } finally {
      unsubscribeFirst();
      await host.dispose();
    }
  });

  it('releases the activation shutdown subscription without skipping contributed shutdown handlers', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const shutdownHandlers = host.handlers('session_shutdown');
    const onShutdown = vi.fn();
    const onAgentStart = vi.fn();
    const extension = definePiExtension({
      name: 'shutdown-event-lifecycle',
      events: { agent_start: onAgentStart, session_shutdown: onShutdown },
    });

    try {
      await extension(host.pi);
      expect(host.handlers('session_shutdown')).toHaveLength(shutdownHandlers.length + 2);
      await host.emit('session_shutdown', { reason: 'quit' });
      expect(onShutdown).toHaveBeenCalledOnce();
      expect(host.handlers('agent_start')).toEqual([]);
      expect(host.handlers('session_shutdown')).toEqual(shutdownHandlers);
      await host.emit('agent_start');
      expect(onAgentStart).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
    }
  });
});
