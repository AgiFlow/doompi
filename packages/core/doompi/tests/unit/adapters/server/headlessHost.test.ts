import {
  DOOM_HEADLESS_OWNER,
  requireDoomHeadlessHost,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessSelection,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { HeadlessHost } from '@agimon-ai/doompi-core/main';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

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
  state: {},
};

async function setup(
  applyTools: (tools: readonly DoomHeadlessTool[]) => void | Promise<void>,
  options: {
    required?: boolean;
    owners?: DoomServerBundleEntry['owners'];
    failActivity?: boolean;
    gatedTool?: boolean;
    allowedTools?: (selection: DoomHeadlessSelection) => readonly string[];
    resolveSelection?: (selection: DoomHeadlessSelection) => Promise<DoomHeadlessSelection>;
  } = {},
) {
  const selectedCandidate = {
    ...candidate,
    required: options.required ?? candidate.required,
    owners: options.owners ?? candidate.owners,
  };
  const onError = vi.fn();
  const root = new Context();
  let host!: HeadlessHost;
  await root
    .plugin((context: Context) => {
      host = new HeadlessHost(context, {
        candidates: [selectedCandidate],
        selection: initial,
        applyTools,
        resolveSelection: options.resolveSelection,
        ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
        applyResources: () => undefined,
        onError,
        context: (selection): DoomHeadlessExecutionContext => ({
          cwd: '/test',
          repoRoot: '/test',
          sessionId: 'test',
          environment: {},
          selection,
          shutdown: vi.fn(),
          client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
          session: {
            entries: () => [],
            appendCustomEntry: vi.fn(),
            prompt: vi.fn(),
            abort: vi.fn(),
            compact: vi.fn(),
            activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
          },
        }),
      });
    })
    .await();
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const stop = vi.fn();
  const start = vi.fn(() => {
    if (options.failActivity) throw new Error('optional activity unavailable');
    return stop;
  });
  await root
    .extend({ [DOOM_HEADLESS_OWNER]: selectedCandidate })
    .plugin((context: Context) => {
      const service = requireDoomHeadlessHost(context);
      service.registerTool({ name: 'test_tool', description: 'test', parameters: Type.Object({}), execute });
      if (options.gatedTool) {
        service.registerTool({
          name: 'gated_tool',
          description: 'gated',
          parameters: Type.Object({}),
          when: { state: { 'minor-mode': 'restricted' }, attribution: { kind: 'minor', mode: 'restricted' } },
          execute,
        });
      }
      service.registerToolRestriction({
        when: { state: { 'minor-mode': 'restricted' } },
        allowedTools: ['other_tool'],
      });
      service.registerActivity({ name: 'watch', start });
    })
    .await();
  host.setAvailableSources([selectedCandidate.packageName]);
  return {
    host,
    execute,
    start,
    stop,
    onError,
    close: async () => {
      await host.close();
      await root.fiber.dispose();
    },
  };
}

describe('retained headless contributions', () => {
  it('inherits changed defaults while preserving explicit session axes', async () => {
    const fixture = await setup(() => undefined);
    try {
      await fixture.host.select({});
      await fixture.host.inheritSelection({ profile: 'inherited', domains: ['default'] });
      expect(fixture.host.context.selection).toMatchObject({ profile: 'inherited', domains: ['default'] });
      await fixture.host.changeSelection({ axis: 'profile', profile: 'explicit' });
      await fixture.host.inheritSelection({ profile: 'new-default', domains: ['updated'] });
      expect(fixture.host.context.selection).toMatchObject({ profile: 'explicit', domains: ['updated'] });
      await fixture.host.changeSelection({ axis: 'domains', domains: [] });
      await fixture.host.inheritSelection({ profile: undefined, domains: ['another-default'] });
      expect(fixture.host.context.selection).toMatchObject({ profile: 'explicit', domains: [] });
    } finally {
      await fixture.close();
    }
  });

  it('resolves queued mode layers before activation and fails closed on invalid selections', async () => {
    let tools: readonly DoomHeadlessTool[] = [];
    const resolveSelection = vi.fn(async (selection: DoomHeadlessSelection) => {
      if (selection.majorMode === 'unknown') throw new Error('Unknown major mode');
      return { ...selection, activeLayers: selection.majorMode === 'development' ? ['tools'] : [] };
    });
    const fixture = await setup(
      (next) => {
        tools = next;
      },
      {
        owners: [
          { majorMode: 'development', layer: 'tools' },
          { majorMode: 'review', layer: 'tools' },
        ],
        resolveSelection,
      },
    );
    try {
      await fixture.host.select({});
      expect(tools).toHaveLength(1);
      const mode = fixture.host.select({ majorMode: 'review' });
      const profile = fixture.host.select({ profile: 'reviewer', domains: ['quality'] });
      expect(fixture.host.status.ready).toBe(false);
      await Promise.all([mode, profile]);
      expect(tools).toEqual([]);
      expect(fixture.host.context.selection).toMatchObject({
        majorMode: 'review',
        activeLayers: [],
        profile: 'reviewer',
        domains: ['quality'],
      });
      expect(fixture.host.status.ready).toBe(true);
      await expect(fixture.host.select({ majorMode: 'unknown' })).rejects.toThrow('Unknown major mode');
      expect(fixture.host.status.ready).toBe(false);
      expect(() => fixture.host.listCommands()).toThrow('blocked');
      await fixture.host.select({ majorMode: 'development' });
      expect(tools).toHaveLength(1);
      expect(fixture.host.context.selection).toMatchObject({ activeLayers: ['tools'], profile: 'reviewer' });
      expect(fixture.host.status.ready).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('retains default capabilities without named layers while enforcing mode ownership', async () => {
    let tools: readonly DoomHeadlessTool[] = [];
    const fixture = await setup(
      (next) => {
        tools = next;
      },
      {
        owners: [{ majorMode: 'development', layer: 'default' }],
      },
    );
    try {
      await fixture.host.select({});
      expect(tools.map((tool) => tool.name)).toEqual(['test_tool']);
      await fixture.host.select({ activeLayers: [] });
      expect(tools.map((tool) => tool.name)).toEqual(['test_tool']);
      expect(fixture.start).toHaveBeenCalledTimes(1);
      expect(fixture.stop).not.toHaveBeenCalled();
      await fixture.host.select({ majorMode: 'review' });
      expect(tools).toEqual([]);
      expect(fixture.host.getContextInventory().sources).toEqual([]);
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      await fixture.host.select({ majorMode: 'development' });
      expect(tools.map((tool) => tool.name)).toEqual(['test_tool']);
      expect(fixture.start).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  });

  it('attributes contribution-level gates to the minor mode that controls them', async () => {
    const fixture = await setup(() => undefined, { gatedTool: true });
    try {
      const gated = fixture.host
        .getContextInventory()
        .sources.flatMap((source) => source.tools)
        .find((tool) => tool.name === 'gated_tool');
      expect(gated).toMatchObject({
        active: false,
        contextAttribution: { kind: 'minor', mode: 'restricted' },
      });
    } finally {
      await fixture.close();
    }
  });

  it('applies one profile axis change without rebuilding tools or activities', async () => {
    const applyTools = vi.fn();
    const fixture = await setup(applyTools);
    try {
      await fixture.host.select({});
      const toolApplications = applyTools.mock.calls.length;
      const activityStarts = fixture.start.mock.calls.length;
      await fixture.host.changeSelection({ axis: 'profile', profile: 'reviewer' });
      expect(fixture.host.context.selection.profile).toBe('reviewer');
      expect(applyTools).toHaveBeenCalledTimes(toolApplications);
      expect(fixture.start).toHaveBeenCalledTimes(activityStarts);
    } finally {
      await fixture.close();
    }
  });

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
  it('filters retained tools by host policy and minor-mode restrictions', async () => {
    let tools: readonly DoomHeadlessTool[] = [];
    const fixture = await setup(
      (next) => {
        tools = next;
      },
      { allowedTools: () => ['test_tool'] },
    );
    try {
      await fixture.host.select({});
      expect(tools.map((tool) => tool.name)).toEqual(['test_tool']);
      await fixture.host.select({ state: { 'minor-mode': ['restricted'] } });
      expect(tools).toEqual([]);
    } finally {
      await fixture.close();
    }

    let policyTools: readonly DoomHeadlessTool[] = [];
    const policyFixture = await setup(
      (next) => {
        policyTools = next;
      },
      { allowedTools: () => [] },
    );
    try {
      await policyFixture.host.select({});
      expect(policyTools).toEqual([]);
    } finally {
      await policyFixture.close();
    }
  });

  it('keeps optional activity ownership recoverable after a failed start', async () => {
    const options = { required: false, failActivity: true };
    const fixture = await setup(() => undefined, options);
    try {
      await fixture.host.select({});
      expect(fixture.host.status.ready).toBe(true);
      expect(fixture.start.mock.calls.length).toBeGreaterThan(0);
      expect(fixture.onError).toHaveBeenCalledWith(expect.any(Error));
      const failedStartCount = fixture.start.mock.calls.length;
      options.failActivity = false;
      await fixture.host.select({ domains: ['docs'] });
      expect(fixture.host.status.ready).toBe(true);
      expect(fixture.start.mock.calls.length).toBeGreaterThan(failedStartCount);
    } finally {
      await fixture.close();
    }
  });
});
