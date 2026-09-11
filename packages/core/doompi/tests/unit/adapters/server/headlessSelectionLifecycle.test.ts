import { Context } from '@deepseek-ai/cordis';
import {
  DOOM_HEADLESS_OWNER,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessMinorMode,
  type DoomHeadlessSelection,
  type DoomHeadlessTool,
  requireDoomHeadlessHost,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { HeadlessHost } from '../../../../src/adapters/server/headlessHost.ts';
import type { HeadlessHostOptions, ResolvedHeadlessResource } from '../../../../src/types/server/headlessHost.ts';

const baseCandidate: DoomServerBundleEntry = {
  packageName: '@test/base-facet',
  entry: './base.ts',
  module: './base.mjs',
  scopes: ['session'],
  owners: [
    { majorMode: 'development', layer: 'default' },
    { majorMode: 'review', layer: 'default' },
  ],
  required: true,
};

const featureCandidate: DoomServerBundleEntry = {
  packageName: '@test/feature-facet',
  entry: './feature.ts',
  module: './feature.mjs',
  scopes: ['session'],
  owners: [{ majorMode: 'development', layer: 'feature' }],
  required: true,
};

const initialSelection: DoomHeadlessSelection = {
  majorMode: 'development',
  activeLayers: ['feature'],
  domains: ['ops'],
  profile: 'reviewer',
  minorModes: ['trace'],
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FixtureOptions {
  applyTools?: (tools: readonly DoomHeadlessTool[]) => void | Promise<void>;
  applyResources?: (resources: readonly ResolvedHeadlessResource[]) => void | Promise<void>;
  featureHookGate?: { entered: () => void; release: Promise<void> };
  featureHookEvent?: 'before_agent_start' | 'context' | 'tool_call';
  featureToolGate?: { entered: () => void; release: Promise<void> };
}

interface Fixture {
  readonly root: Context;
  readonly host: HeadlessHost;
  readonly tools: { current: readonly DoomHeadlessTool[] };
  readonly resources: { current: readonly ResolvedHeadlessResource[] };
  readonly command: ReturnType<typeof vi.fn>;
  readonly featureCommand: ReturnType<typeof vi.fn>;
  readonly hook: ReturnType<typeof vi.fn>;
  readonly featureHook: ReturnType<typeof vi.fn>;
  readonly resourceRead: ReturnType<typeof vi.fn>;
  readonly featureResourceRead: ReturnType<typeof vi.fn>;
  readonly activityStart: ReturnType<typeof vi.fn>;
  readonly activityStop: ReturnType<typeof vi.fn>;
  readonly modeAction: ReturnType<typeof vi.fn>;
  readonly onError: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = new Context();
  let host!: HeadlessHost;
  const tools = { current: [] as readonly DoomHeadlessTool[] };
  const resources = { current: [] as readonly ResolvedHeadlessResource[] };
  const command = vi.fn();
  const featureCommand = vi.fn();
  const hook = vi.fn((event: Readonly<Record<string, unknown>>) => ({
    systemPrompt: `${String(event.systemPrompt)}\nbase`,
  }));
  const featureHook = vi.fn(async (event: Readonly<Record<string, unknown>>) => {
    if (options.featureHookGate) {
      options.featureHookGate.entered();
      await options.featureHookGate.release;
    }
    return { systemPrompt: `${String(event.systemPrompt)}\nfeature` };
  });
  const resourceRead = vi.fn((context: DoomHeadlessExecutionContext) => `base:${context.selection.profile}`);
  const featureResourceRead = vi.fn(
    (context: DoomHeadlessExecutionContext) =>
      `feature:${context.selection.domains.join(',')}:${context.selection.minorModes.join(',')}`,
  );
  const activityStop = vi.fn();
  const activityStart = vi.fn(() => activityStop);
  const modeAction = vi.fn(
    (actionId: string, _args: Record<string, unknown>, execution: { context: DoomHeadlessExecutionContext }) => ({
      message: `${actionId}:${execution.context.selection.profile}`,
    }),
  );
  const onError = vi.fn();
  const context = (selection: DoomHeadlessSelection): DoomHeadlessExecutionContext => ({
    cwd: '/test',
    repoRoot: '/test',
    sessionId: 'headless-selection-lifecycle',
    environment: {},
    selection,
    client: { notify: vi.fn(), request: vi.fn(async () => undefined), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(async () => undefined),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    shutdown: vi.fn(),
  });
  const defaultApplyTools = (next: readonly DoomHeadlessTool[]): void => {
    tools.current = next;
  };
  const defaultApplyResources = (next: readonly ResolvedHeadlessResource[]): void => {
    resources.current = next;
  };
  const hostOptions: HeadlessHostOptions = {
    candidates: [baseCandidate, featureCandidate],
    selection: initialSelection,
    context,
    applyTools: options.applyTools ?? defaultApplyTools,
    applyResources: options.applyResources ?? defaultApplyResources,
    onError,
  };
  await root
    .plugin((pluginContext: Context) => {
      host = new HeadlessHost(pluginContext, hostOptions);
    })
    .await();

  await root
    .extend({ [DOOM_HEADLESS_OWNER]: baseCandidate })
    .plugin((facetContext: Context) => {
      const service = requireDoomHeadlessHost(facetContext);
      service.registerTool({
        name: 'base_tool',
        description: 'Always available',
        parameters: Type.Object({}),
        execute: async (_id, _parameters, _signal, _onUpdate, executionContext) => ({
          content: [{ type: 'text', text: `base:${executionContext.selection.profile}` }],
        }),
      });
      service.registerResource({ name: 'base_resource', kind: 'context', read: resourceRead });
      service.registerCommand({ name: 'base_command', description: 'Base command', execute: command });
      service.registerHook({ event: 'before_agent_start', handle: hook });
    })
    .await();

  const featureMode: DoomHeadlessMinorMode = {
    descriptor: {
      source: featureCandidate.packageName,
      id: 'trace',
      label: 'Trace',
      description: 'Trace mode',
      order: 1,
      actions: [
        {
          id: 'inspect',
          label: 'Inspect',
          description: 'Inspect trace mode',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    initialState: {
      activation: 'active',
      condition: 'ready',
      actions: [{ id: 'inspect', enabled: true }],
    },
    handleAction: modeAction,
  };
  await root
    .extend({ [DOOM_HEADLESS_OWNER]: featureCandidate })
    .plugin((facetContext: Context) => {
      const service = requireDoomHeadlessHost(facetContext);
      service.registerMinorMode(featureMode);
      service.registerTool({
        when: { domain: 'ops', minorMode: 'trace' },
        name: 'feature_tool',
        description: 'Feature tool',
        parameters: Type.Object({}),
        execute: async (_id, _parameters, _signal, _onUpdate, executionContext) => {
          if (options.featureToolGate) {
            options.featureToolGate.entered();
            await options.featureToolGate.release;
          }
          return { content: [{ type: 'text', text: `feature:${executionContext.selection.profile}` }] };
        },
      });
      service.registerResource({
        when: { domain: 'ops', minorMode: 'trace' },
        name: 'feature_resource',
        kind: 'skill',
        read: featureResourceRead,
      });
      service.registerCommand({
        when: { domain: 'ops', minorMode: 'trace' },
        name: 'feature_command',
        description: 'Feature command',
        execute: featureCommand,
      });
      service.registerHook({
        when: { domain: 'ops', minorMode: 'trace' },
        event: options.featureHookEvent ?? 'before_agent_start',
        handle: featureHook,
      } as Parameters<typeof service.registerHook>[0]);
      const activity: DoomHeadlessActivity = {
        when: { domain: 'ops', minorMode: 'trace' },
        name: 'feature_activity',
        start: activityStart,
      };
      service.registerActivity(activity);
    })
    .await();

  host.setAvailableSources([baseCandidate.packageName, featureCandidate.packageName]);
  return {
    root,
    host,
    tools,
    resources,
    command,
    featureCommand,
    hook,
    featureHook,
    resourceRead,
    featureResourceRead,
    activityStart,
    activityStop,
    modeAction,
    onError,
    close: async () => {
      await host.close();
      await root.fiber.dispose();
    },
  };
}

describe('HeadlessHost selection lifecycle (host-unit evidence)', () => {
  it('retains Cordis facets while applying combined major, domain, profile, and minor selection', async () => {
    const fixture = await createFixture();
    try {
      await fixture.host.select({});
      expect(fixture.host.status).toMatchObject({ ready: true, requestedRevision: 1, appliedRevision: 1 });
      expect(fixture.tools.current.map((tool) => tool.name)).toEqual(['base_tool', 'feature_tool']);
      expect(fixture.resources.current.map((resource) => resource.name)).toEqual(['base_resource', 'feature_resource']);
      const inventory = fixture.host.getContextInventory();
      expect(inventory.attribution[featureCandidate.packageName]).toEqual({
        kind: 'major',
        mode: 'development',
        layer: 'feature',
      });
      expect(inventory.sources.find((source) => source.packageName === featureCandidate.packageName)?.tools).toEqual([
        expect.objectContaining({ name: 'feature_tool', active: true }),
      ]);
      expect(fixture.host.listCommands().map((entry) => entry.name)).toEqual(['base_command', 'feature_command']);

      const toolResult = await fixture.tools.current[1]!.execute(
        'feature-1',
        {},
        undefined,
        undefined,
        fixture.host.context,
      );
      expect(toolResult.content).toEqual([{ type: 'text', text: 'feature:reviewer' }]);
      await fixture.host.dispatchCommand('feature_command', 'run');
      expect(fixture.featureCommand).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({ selection: initialSelection }),
      );
      expect(await fixture.host.readResources()).toEqual([
        { source: baseCandidate.packageName, name: 'base_resource', kind: 'context', text: 'base:reviewer' },
        { source: featureCandidate.packageName, name: 'feature_resource', kind: 'skill', text: 'feature:ops:trace' },
      ]);
      expect(fixture.resourceRead).toHaveBeenCalledWith(expect.objectContaining({ selection: initialSelection }));
      expect(fixture.featureResourceRead).toHaveBeenCalledWith(
        expect.objectContaining({ selection: initialSelection }),
      );
      await expect(fixture.host.dispatchHook('before_agent_start', { systemPrompt: 'start' })).resolves.toEqual([
        { systemPrompt: 'start\nbase' },
        { systemPrompt: 'start\nbase\nfeature' },
      ]);

      const mode = fixture.host.catalog.list()[0]!;
      await expect(
        fixture.host.catalog.invoke(
          {
            operationId: 'inspect-1',
            mode: {
              source: mode.descriptor.source,
              id: mode.descriptor.id,
              ownerGeneration: mode.ownerGeneration,
              registrationId: mode.registrationId,
            },
            actionId: 'inspect',
            arguments: {},
          },
          'test-client',
        ),
      ).resolves.toMatchObject({ message: 'inspect:reviewer' });
      expect(fixture.modeAction).toHaveBeenCalledWith(
        'inspect',
        {},
        expect.objectContaining({
          context: expect.objectContaining({ selection: initialSelection }),
          sessionKind: 'headless',
        }),
      );

      await fixture.host.select({ domains: [], minorModes: [], profile: 'operator' });
      expect(await fixture.host.readResources()).toEqual([
        { source: baseCandidate.packageName, name: 'base_resource', kind: 'context', text: 'base:operator' },
      ]);
      expect(fixture.tools.current.map((tool) => tool.name)).toEqual(['base_tool']);
      expect(fixture.resources.current.map((resource) => resource.name)).toEqual(['base_resource']);
      expect(
        fixture.host
          .getContextInventory()
          .sources.find((source) => source.packageName === featureCandidate.packageName)
          ?.tools.find((tool) => tool.name === 'feature_tool'),
      ).toMatchObject({ active: false });
      expect(fixture.host.listCommands().map((entry) => entry.name)).toEqual(['base_command']);
      await expect(fixture.host.dispatchHook('before_agent_start', { systemPrompt: 'disabled' })).resolves.toEqual([
        { systemPrompt: 'disabled\nbase' },
      ]);
      expect(fixture.activityStop).toHaveBeenCalledOnce();
      expect(fixture.host.catalog.list()).toHaveLength(1);

      await fixture.host.select({ majorMode: 'review', activeLayers: [], domains: [], minorModes: [] });
      expect(fixture.tools.current.map((tool) => tool.name)).toEqual(['base_tool']);
      expect(fixture.host.catalog.list()).toHaveLength(1);
      await expect(
        fixture.host.catalog.invoke(
          {
            operationId: 'inspect-inactive',
            mode: {
              source: mode.descriptor.source,
              id: mode.descriptor.id,
              ownerGeneration: mode.ownerGeneration,
              registrationId: mode.registrationId,
            },
            actionId: 'inspect',
            arguments: {},
          },
          'test-client',
        ),
      ).rejects.toThrow("Minor-mode owner '@test/feature-facet' is inactive");

      await fixture.host.select({
        majorMode: 'development',
        activeLayers: ['feature'],
        domains: ['ops'],
        minorModes: ['trace'],
        profile: 'reviewer',
      });
      expect(fixture.host.context.selection).toEqual(initialSelection);
      expect(fixture.tools.current.map((tool) => tool.name)).toEqual(['base_tool', 'feature_tool']);
      expect(fixture.resources.current.map((resource) => resource.name)).toEqual(['base_resource', 'feature_resource']);
      expect(fixture.activityStart).toHaveBeenCalledTimes(2);
      expect(fixture.host.catalog.list()[0]).toMatchObject({
        registrationId: mode.registrationId,
        ownerGeneration: mode.ownerGeneration,
      });
      await fixture.host.dispatchCommand('feature_command', 'retained');
      expect(fixture.featureCommand).toHaveBeenLastCalledWith(
        'retained',
        expect.objectContaining({ selection: initialSelection }),
      );
    } finally {
      await fixture.close();
    }
  });

  it('blocks dispatch while a selection is in flight and rejects stale tools after acknowledgment', async () => {
    const selectionGate = deferred();
    let blockSelection = false;
    let appliedTools: readonly DoomHeadlessTool[] = [];
    const fixture = await createFixture({
      applyTools: async (tools) => {
        appliedTools = tools;
        if (blockSelection) await selectionGate.promise;
      },
    });
    try {
      await fixture.host.select({});
      const oldTool = appliedTools.find((tool) => tool.name === 'feature_tool')!;
      blockSelection = true;
      const selecting = fixture.host.select({ domains: [], minorModes: [] });
      expect(fixture.host.status.ready).toBe(false);
      expect(() => fixture.host.listCommands()).toThrow('blocked');
      await expect(oldTool.execute('in-flight', {}, undefined, undefined, fixture.host.context)).rejects.toThrow(
        'blocked',
      );
      selectionGate.resolve();
      await selecting;
      expect(fixture.host.status.ready).toBe(true);
      expect(appliedTools.map((tool) => tool.name)).toEqual(['base_tool']);
      await expect(oldTool.execute('stale', {}, undefined, undefined, fixture.host.context)).rejects.toThrow(
        "Tool 'feature_tool' is no longer active",
      );
      await expect(fixture.host.dispatchCommand('feature_command', '')).rejects.toThrow('inactive or unknown');
    } finally {
      selectionGate.resolve();
      await fixture.close();
    }
  });

  it('lets an already-started tool finish with its original context but rejects later stale calls', async () => {
    const entered = deferred();
    const release = deferred();
    const fixture = await createFixture({ featureToolGate: { entered: entered.resolve, release: release.promise } });
    try {
      await fixture.host.select({});
      const tool = fixture.tools.current.find(({ name }) => name === 'feature_tool')!;
      const running = tool.execute('started-before-selection', {}, undefined, undefined, fixture.host.context);
      await entered.promise;
      await fixture.host.select({
        majorMode: 'review',
        activeLayers: [],
        domains: [],
        minorModes: [],
        profile: 'operator',
      });
      expect(fixture.host.status.ready).toBe(true);
      release.resolve();
      await expect(running).resolves.toMatchObject({ content: [{ type: 'text', text: 'feature:reviewer' }] });
      await expect(tool.execute('after-selection', {}, undefined, undefined, fixture.host.context)).rejects.toThrow(
        'no longer active',
      );
    } finally {
      release.resolve();
      await fixture.close();
    }
  });

  it.each(['before_agent_start', 'context', 'tool_call'] as const)(
    'rejects %s dispatch that completes after selection acknowledgment',
    async (event) => {
      const entered = deferred();
      const release = deferred();
      const fixture = await createFixture({
        featureHookEvent: event,
        featureHookGate: { entered: entered.resolve, release: release.promise },
      });
      try {
        await fixture.host.select({});
        const dispatch = fixture.host.dispatchHook(event, { systemPrompt: 'start', args: {} });
        await entered.promise;
        await fixture.host.select({ domains: [], minorModes: [] });
        expect(fixture.host.status.ready).toBe(true);
        release.resolve();
        await expect(dispatch).rejects.toThrow('Selection changed while');
      } finally {
        release.resolve();
        await fixture.close();
      }
    },
  );

  it('recovers readiness after an application failure without losing retained state', async () => {
    let fail = false;
    const applyTools = vi.fn((_tools: readonly DoomHeadlessTool[]) => {
      if (fail) throw new Error('tool sink unavailable');
      return undefined;
    });
    const fixture = await createFixture({ applyTools });
    try {
      await fixture.host.select({});
      const previousContext = fixture.host.context;
      fail = true;
      await expect(fixture.host.select({ profile: 'failed' })).rejects.toThrow('tool sink unavailable');
      expect(fixture.host.status).toMatchObject({
        ready: false,
        appliedRevision: 1,
        requestedRevision: 2,
        error: 'Kernel slots failed to apply: tools: tool sink unavailable',
      });
      expect(() => fixture.host.listCommands()).toThrow('blocked');
      expect(fixture.host.context.selection).toEqual(previousContext.selection);

      fail = false;
      await fixture.host.select({ profile: 'recovered' });
      expect(fixture.host.status).toMatchObject({ ready: true, appliedRevision: 3, requestedRevision: 3 });
      expect(fixture.host.context.selection.profile).toBe('recovered');
      await fixture.host.dispatchCommand('feature_command', 'recovered');
      expect(fixture.featureCommand).toHaveBeenCalledWith(
        'recovered',
        expect.objectContaining({ selection: expect.objectContaining({ profile: 'recovered' }) }),
      );
    } finally {
      await fixture.close();
    }
  });

  it('disposes retained activities and catalog ownership during Cordis shutdown', async () => {
    const fixture = await createFixture();
    await fixture.host.select({});
    expect(fixture.activityStart).toHaveBeenCalledOnce();
    await fixture.root.fiber.dispose();
    expect(fixture.activityStop).toHaveBeenCalledOnce();
    expect(fixture.host.status.ready).toBe(false);
    expect(fixture.host.catalog.list()).toEqual([]);
    await fixture.host.close();
    expect(fixture.activityStop).toHaveBeenCalledOnce();
  });
});
