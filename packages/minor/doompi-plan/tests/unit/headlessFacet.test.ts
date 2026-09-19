import { readFile } from 'node:fs/promises';

import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessHook,
  DoomHeadlessResource,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet as planServerFacet } from '../../generated/server';
import {
  DOOM_SUBAGENT_POLICY_SERVICE,
  type DoomSubagentPolicyService,
  type SubagentPolicy,
} from '../../src/services/optionalTeamServices';

interface FixtureOptions {
  minorModes?: string[];
  policy?: DoomSubagentPolicyService;
}

async function fixture(options: FixtureOptions = {}) {
  let selection: DoomHeadlessSelection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    state: { 'minor-mode': options.minorModes ?? ['retained'] },
  };
  let mode!: DoomHeadlessMinorMode;
  const resources: DoomHeadlessResource[] = [];
  const hooks: DoomHeadlessHook<'before_agent_start'>[] = [];
  const tools: DoomHeadlessTool[] = [];
  const publish = vi.fn();
  const dispose = vi.fn();
  const selectionListeners = new Set<(next: DoomHeadlessSelection) => void | Promise<void>>();
  const notifySelection = async (): Promise<void> => {
    for (const listener of selectionListeners) await listener(selection);
  };
  const registration = () => ({ dispose });
  const execution = {
    repoRoot: '/fixture-repository',
    environment: { HOME: '/fixture-home' },
    session: { entries: async () => [], appendCustomEntry: async () => undefined },
    get selection() {
      return selection;
    },
  } as unknown as DoomHeadlessExecutionContext;
  const registerOwner = vi.fn((value: DoomHeadlessMinorMode) => {
    mode = value;
    return { publish, dispose };
  });
  const host = {
    context: execution,
    changeSelection: async (change: { axis: 'state'; key: string; values: string[] }) => {
      selection = { ...selection, state: { ...selection.state, [change.key]: change.values } };
      await notifySelection();
    },
    assertActive: vi.fn(),
    subscribeSelection: vi.fn((listener: (next: DoomHeadlessSelection) => void | Promise<void>) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    }),
    registerToolRestriction: registration,
    registerResource: (value: DoomHeadlessResource) => {
      resources.push(value);
      return registration();
    },
    registerTool: (value: DoomHeadlessTool) => {
      tools.push(value);
      return registration();
    },
    registerHook: (value: DoomHeadlessHook) => {
      hooks.push(value as DoomHeadlessHook<'before_agent_start'>);
      return registration();
    },
  } as unknown as DoomHeadlessHostService;
  const close = await mountFacet(
    planServerFacet,
    {
      effect() {},
      get: (name: string) =>
        name === 'doom/server-host' ? { scope: 'session', context: {}, registerApi: () => ({ dispose() {} }) } : host,
    } as unknown as Context,
    host,
    registerOwner,
    options.policy,
  );
  const action = (id: string, args: Record<string, string> = {}, signal = new AbortController().signal) =>
    mode.handleAction(id, args, { signal, context: execution } as Parameters<DoomHeadlessMinorMode['handleAction']>[2]);
  const setMinorModes = async (minorModes: string[]): Promise<void> => {
    selection = { ...selection, state: { ...selection.state, 'minor-mode': minorModes } };
    await notifySelection();
  };
  return { mode, action, setMinorModes, execution, resources, hooks, tools, publish, dispose, close };
}

describe('headless planning resources and selection', () => {
  it('reads the shipped skill and registers only minor-gated tools and hooks', async () => {
    const test = await fixture();
    expect(await test.resources[0]!.read(test.execution)).toBe(
      await readFile(new URL('../../src/prompts/doompi-use-plan/SKILL.md', import.meta.url), 'utf8'),
    );
    for (const contribution of [
      ...test.resources,
      ...test.tools,
      ...test.hooks.filter((hook) => hook.event === 'before_agent_start'),
    ]) {
      expect(contribution.when).toEqual({
        state: { 'minor-mode': 'plan' },
        attribution: { kind: 'minor', mode: 'plan' },
      });
    }
    await test.close?.();
    expect(test.dispose).toHaveBeenCalledTimes(9);
  });

  it.each(['normal', 'debug', 'fable'])(
    'publishes %s activation and restores other minor modes on exit',
    async (flavor) => {
      const test = await fixture();
      expect(test.mode.initialState).toMatchObject({ activation: 'inactive' });
      await test.action('activate', { flavor });
      expect(test.execution.selection.state?.['minor-mode']).toEqual(['retained', 'plan']);
      expect(test.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ activation: 'active', modelContextVariant: flavor }),
      );
      await test.action('deactivate');
      expect(test.execution.selection.state?.['minor-mode']).toEqual(['retained']);
      expect(test.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));
    },
  );

  it('rejects invalid flavors, unknown actions and aborted activation without changing selection', async () => {
    const test = await fixture();
    await expect(test.action('activate', { flavor: 'invalid' })).rejects.toThrow('valid plan flavor');
    await expect(test.action('unknown')).rejects.toThrow('Unknown plan mode action');
    await expect(test.action('activate', { flavor: 'normal' }, AbortSignal.abort())).rejects.toThrow();
    expect(test.execution.selection.state?.['minor-mode']).toEqual(['retained']);
    expect(test.publish).not.toHaveBeenCalled();
  });

  it('preserves a supplied system prompt and handles missing prompt text', async () => {
    const test = await fixture();
    expect(await test.hooks[0]!.handle({ systemPrompt: 'Original' }, test.execution)).toMatchObject({
      systemPrompt: expect.stringContaining('Original\n\n[PLAN MODE ACTIVE]'),
    });
    expect(await test.hooks[0]!.handle({}, test.execution)).toMatchObject({
      systemPrompt: expect.stringMatching(/^\[PLAN MODE ACTIVE\]/),
    });
  });

  it('restricts new and restored Plan subagents to exploration tools', async () => {
    const handles: Array<{ update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
    const policy: DoomSubagentPolicyService = {
      register: vi.fn((_value: SubagentPolicy) => {
        const handle = { update: vi.fn(), dispose: vi.fn() };
        handles.push(handle);
        return handle;
      }),
    };
    const test = await fixture({ policy });
    expect(policy.register).not.toHaveBeenCalled();

    await test.action('activate', { flavor: 'normal' });
    expect(policy.register).toHaveBeenCalledWith({
      owner: '@agimon-ai/doompi-plan',
      allowedTools: ['read', 'bash', 'grep', 'find', 'ls', 'mcp'],
      requiredTools: ['bash'],
      allowMcpTools: true,
      allowedExternalProfiles: [],
      denyExtensions: false,
    });
    await test.action('deactivate');
    expect(handles[0]!.dispose).toHaveBeenCalledOnce();

    await test.setMinorModes(['retained', 'plan']);
    expect(policy.register).toHaveBeenCalledTimes(2);
    await test.setMinorModes(['retained']);
    expect(handles[1]!.dispose).toHaveBeenCalledOnce();

    await test.close?.();
  });

  it('registers the child ceiling for an initially restored Plan selection', async () => {
    const policy: DoomSubagentPolicyService = { register: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })) };
    const test = await fixture({ minorModes: ['retained', 'plan'], policy });
    await vi.waitFor(() => expect(policy.register).toHaveBeenCalledOnce());
    await test.close?.();
  });
});

async function mountFacet(
  facet: DoomServerFacet,
  existing: Context,
  host: DoomHeadlessHostService,
  registerOwner: ReturnType<typeof vi.fn>,
  policy?: DoomSubagentPolicyService,
) {
  const root = new Context();
  root.provide(TEST_SERVER, existing.get(TEST_SERVER));
  root.provide(TEST_AGENT, host);
  root.provide(TEST_CATALOG, { registerOwner } as never);
  if (policy) root.provide(DOOM_SUBAGENT_POLICY_SERVICE as never, policy as never);
  const owner = root.extend({ [TEST_OWNER]: { packageName: '@fixture/mode' } });
  const release = await facet.apply(owner);
  await vi.waitFor(() => expect(registerOwner).toHaveBeenCalled());
  return async () => {
    await release?.();
    await root.fiber.dispose();
  };
}
