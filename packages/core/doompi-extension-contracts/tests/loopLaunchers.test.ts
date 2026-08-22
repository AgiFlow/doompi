import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  type DoomLoopLaunchersService,
  readDoomLoopLaunchers,
  requireDoomLoopLaunchers,
} from '../src/exports/loopLaunchers.ts';

function service(): DoomLoopLaunchersService {
  return {
    generation: 'loop-launchers-test',
    register: vi.fn(),
    listLaunchers: vi.fn(() => []),
    listInstances: vi.fn(() => []),
    subscribe: vi.fn(() => vi.fn()),
    launch: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('doom/loop-launchers Cordis contract', () => {
  it('reads the provider-owned service from its canonical key', async () => {
    const context = new Context();
    const launchers = service();
    context.provide(DOOM_LOOP_LAUNCHERS_SERVICE, launchers);

    expect(readDoomLoopLaunchers(context)).toBe(launchers);
    expect(requireDoomLoopLaunchers(context)).toBe(launchers);
    await context.fiber.dispose();
  });

  it('fails explicitly when Loop is not installed', async () => {
    const context = new Context();

    expect(readDoomLoopLaunchers(context)).toBeUndefined();
    expect(() => requireDoomLoopLaunchers(context)).toThrow('Load @agimon-ai/doompi-loop');
    await context.fiber.dispose();
  });
});
