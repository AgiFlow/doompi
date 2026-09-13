import type { Context, Fiber } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { createTeamCollaborationMount, type TeamCollaborationPluginConfig } from '../../src/services/teamCollaboration';

function fixture() {
  const fibers: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const plugin = vi.fn(() => {
    const fiber = { dispose: vi.fn(async () => undefined) };
    fibers.push(fiber);
    return fiber as unknown as Fiber;
  });
  let inject: ((context: Context) => () => Promise<void>) | undefined;
  let stop: (() => Promise<void>) | undefined;
  const owner = {
    plugin,
    inject(_names: string[], callback: typeof inject) {
      inject = callback;
    },
    effect(callback: () => typeof stop) {
      stop = callback();
    },
  } as unknown as Context;
  const mount = createTeamCollaborationMount();
  mount.plugin(owner);
  return { mount, plugin, fibers, inject: (context: Context) => inject!(context), stop: () => stop!() };
}
const config = {} as TeamCollaborationPluginConfig;

describe('Team collaboration mount ownership', () => {
  it('retires the previous standalone fiber before mounting its replacement and owns final disposal', async () => {
    const host = fixture();
    const manager = {};
    await host.mount.mount(config, manager);
    await host.mount.mount(config, manager);
    expect(host.fibers[0]!.dispose).toHaveBeenCalledOnce();
    expect(host.plugin).toHaveBeenCalledTimes(2);
    await host.stop();
    expect(host.fibers[1]!.dispose).toHaveBeenCalledOnce();
    await expect(host.mount.mount(config, manager)).rejects.toThrow('not mounted');
  });

  it('mounts in the matching injected session and retires it when that dependency leaves', async () => {
    const host = fixture();
    const manager = {};
    const dispose = vi.fn(async () => undefined);
    const plugin = vi.fn(() => ({ dispose }));
    const session = { get: () => ({ context: { sessionManager: manager } }), plugin } as unknown as Context;
    const leave = host.inject(session);
    await host.mount.mount(config, manager);
    expect(plugin).toHaveBeenCalledOnce();
    expect(host.plugin).not.toHaveBeenCalled();
    await leave();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps the standalone fallback alive when an unrelated session leaves', async () => {
    const host = fixture();
    const session = { get: () => ({ context: { sessionManager: {} } }) } as unknown as Context;
    const leave = host.inject(session);
    await host.mount.mount(config, {});
    await leave();
    expect(host.fibers[0]!.dispose).not.toHaveBeenCalled();
    await host.mount.dispose();
    expect(host.fibers[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a superseded mount before registering another fiber', async () => {
    const host = fixture();
    const first = host.mount.mount(config, {});
    const second = host.mount.mount(config, {});
    await expect(first).rejects.toThrow('superseded');
    await second;
    expect(host.plugin).toHaveBeenCalledOnce();
  });
});
