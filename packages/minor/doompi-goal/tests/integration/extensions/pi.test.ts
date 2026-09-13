import { createPiTestHost } from '@agimon-ai/doompi-core/testing';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { COMMAND_NAME } from '../../../src/constants/goal';
import { goalExtension as registerGoalExtension } from '../../../src/extensions/pi';
import type { GoalExtensionService } from '../../../src/types/extension';

interface CommandDefinition {
  handler: (
    args: string,
    ctx: { hasUI: boolean; ui: { notify: (message: string, level: string) => void } },
  ) => Promise<void>;
}

function createPiFixture(): {
  commands: Map<string, CommandDefinition>;
  listeners: Map<string, () => void | Promise<void>>;
  pi: ExtensionAPI;
} {
  const commands = new Map<string, CommandDefinition>();
  const listeners = new Map<string, () => void | Promise<void>>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
      on(event: string, handler: (payload: unknown) => void) {
        const handlers = eventHandlers.get(event) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(event, handlers);
        return () => handlers.delete(handler);
      },
    },
    registerTool: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    registerCommand: vi.fn((name: string, definition: CommandDefinition) => commands.set(name, definition)),
  } as unknown as ExtensionAPI;
  return { commands, listeners, pi };
}

describe('doompi-goal Pi extension', () => {
  it('injects its service into the directly activated runtime', async () => {
    const fixture = createPiFixture();
    const service: GoalExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };
    const notify = vi.fn();

    const context = new Context();
    await registerGoalExtension.install(context, fixture.pi, { service });
    await fixture.commands.get(COMMAND_NAME)?.handler('', { hasUI: true, ui: { notify } });

    expect(service.execute).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('ready', 'info');
    await context.fiber.dispose();
  });

  it('is headless-safe and disposes runtime registrations once', async () => {
    const fixture = createPiFixture();
    const service: GoalExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };
    const notify = vi.fn();
    const context = new Context();
    await registerGoalExtension.install(context, fixture.pi, { service });
    const dispose = () => context.fiber.dispose();

    await fixture.commands.get(COMMAND_NAME)?.handler('', { hasUI: false, ui: { notify } });
    await dispose();
    await dispose();

    expect(notify).not.toHaveBeenCalled();
  });

  it('owns awaited shutdown and recreates state when Pi loads the factory again', async () => {
    const first = createPiTestHost();
    const reloaded = createPiTestHost();
    await first.cordis('goal-test-first');
    await reloaded.cordis('goal-test-reloaded');

    try {
      await registerGoalExtension(first.pi);
      await first.emit('session_shutdown', { reason: 'test' });
      await first.emit('session_shutdown', { reason: 'test' });
      await registerGoalExtension(reloaded.pi);

      expect(first.commands.filter((command) => command.name === COMMAND_NAME)).toHaveLength(1);
      expect(reloaded.commands.filter((command) => command.name === COMMAND_NAME)).toHaveLength(1);
    } finally {
      await Promise.all([first.dispose(), reloaded.dispose()]);
    }
  });
});
