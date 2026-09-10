import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import {
  DOOM_HEADLESS_OWNER,
  requireDoomHeadlessHost,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessSelection,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { HeadlessHost } from '../../../../src/adapters/server/headlessHost.ts';

const candidate: DoomServerBundleEntry = {
  packageName: '@test/tools',
  entry: './src/facet.ts',
  module: './facet.mjs',
  scopes: ['session'],
  owners: [{ majorMode: 'development', layer: 'tools' }],
  required: true,
};
const initial: DoomHeadlessSelection = {
  majorMode: 'development',
  activeLayers: ['tools'],
  domains: [],
  minorModes: [],
};

async function setup(applyTools: (tools: readonly DoomHeadlessTool[]) => void | Promise<void>) {
  const root = new Context();
  let host!: HeadlessHost;
  await root
    .plugin((context: Context) => {
      host = new HeadlessHost(context, {
        candidates: [candidate],
        selection: initial,
        applyTools,
        applyResources: () => undefined,
        context: (selection): DoomHeadlessExecutionContext => ({
          cwd: '/test',
          repoRoot: '/test',
          sessionId: 'test',
          selection,
          shutdown: vi.fn(),
          client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
          session: { entries: () => [], appendCustomEntry: vi.fn(), prompt: vi.fn(), abort: vi.fn(), compact: vi.fn() },
        }),
      });
    })
    .await();
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const stop = vi.fn();
  const start = vi.fn(() => stop);
  await root
    .extend({ [DOOM_HEADLESS_OWNER]: candidate })
    .plugin((context: Context) => {
      const service = requireDoomHeadlessHost(context);
      service.registerTool({ name: 'test_tool', description: 'test', parameters: Type.Object({}), execute });
      service.registerActivity({ name: 'watch', start });
    })
    .await();
  host.setAvailableSources([candidate.packageName]);
  return {
    host,
    execute,
    start,
    stop,
    close: async () => {
      await host.close();
      await root.fiber.dispose();
    },
  };
}

describe('retained headless contributions', () => {
  it('keeps dormant activity stopped and rejects stale disabled tool invocations', async () => {
    let tools: readonly DoomHeadlessTool[] = [];
    const fixture = await setup((next) => {
      tools = next;
    });
    try {
      expect(fixture.start).not.toHaveBeenCalled();
      await fixture.host.select({});
      const active = tools[0]!;
      await active.execute('one', {}, undefined, undefined, fixture.host.context);
      expect(fixture.execute).toHaveBeenCalledTimes(1);
      await fixture.host.select({ activeLayers: [] });
      expect(tools).toEqual([]);
      expect(fixture.stop).toHaveBeenCalledOnce();
      await expect(active.execute('stale', {}, undefined, undefined, fixture.host.context)).rejects.toThrow(
        'no longer active',
      );
      await fixture.host.select({ activeLayers: ['tools'] });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(fixture.host.status.ready).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('blocks dispatch after failed application and retries the same selection', async () => {
    let fail = false;
    const fixture = await setup(() => {
      if (fail) throw new Error('sink unavailable');
    });
    try {
      await fixture.host.select({});
      fail = true;
      await expect(fixture.host.select({ domains: ['docs'] })).rejects.toThrow('sink unavailable');
      expect(fixture.host.status).toMatchObject({ ready: false, appliedRevision: 1, requestedRevision: 2 });
      await expect(fixture.host.dispatchCommand('anything', '')).rejects.toThrow('blocked');
      fail = false;
      await fixture.host.select({ domains: ['docs'] });
      expect(fixture.host.status).toMatchObject({ ready: true, appliedRevision: 3 });
      expect(fixture.host.context.selection.domains).toEqual(['docs']);
    } finally {
      await fixture.close();
    }
  });

  it('rejects an unavailable required owner before advertising readiness', async () => {
    const fixture = await setup(() => undefined);
    try {
      fixture.host.setAvailableSources([]);
      await expect(fixture.host.select({})).rejects.toThrow('Required headless package');
      expect(fixture.host.status.ready).toBe(false);
      expect(fixture.start).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
