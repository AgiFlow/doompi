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

import { planServerFacet } from '../../src/extensions/server';

async function fixture() {
  let selection: DoomHeadlessSelection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    state: { 'minor-mode': ['retained'] },
  };
  let mode!: DoomHeadlessMinorMode;
  const resources: DoomHeadlessResource[] = [];
  const hooks: DoomHeadlessHook<'before_agent_start'>[] = [];
  const tools: DoomHeadlessTool[] = [];
  const publish = vi.fn();
  const dispose = vi.fn();
  const registration = () => ({ dispose });
  const execution = {
    get selection() {
      return selection;
    },
  } as DoomHeadlessExecutionContext;
  const registerOwner = vi.fn((value: DoomHeadlessMinorMode) => {
    mode = value;
    return { publish, dispose };
  });
  const host = {
    context: execution,
    changeSelection: async (change: { axis: 'state'; key: string; values: string[] }) => {
      selection = { ...selection, state: { ...selection.state, [change.key]: change.values } };
    },
    assertActive: vi.fn(),
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
  );
  const action = (id: string, args: Record<string, string> = {}, signal = new AbortController().signal) =>
    mode.handleAction(id, args, { signal, context: execution } as Parameters<DoomHeadlessMinorMode['handleAction']>[2]);
  return { mode, action, execution, resources, hooks, tools, publish, dispose, close };
}

describe('headless planning resources and selection', () => {
  it('reads the shipped skill and registers only minor-gated tools and hooks', async () => {
    const test = await fixture();
    expect(await test.resources[0]!.read(test.execution)).toBe(
      await readFile(new URL('../../src/prompts/doompi-use-plan/SKILL.md', import.meta.url), 'utf8'),
    );
    for (const contribution of [...test.resources, ...test.tools, ...test.hooks]) {
      expect(contribution.when).toEqual({
        state: { 'minor-mode': 'plan' },
        attribution: { kind: 'minor', mode: 'plan' },
      });
    }
    await test.close?.();
    expect(test.dispose).toHaveBeenCalledTimes(8);
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
});

async function mountFacet(
  facet: DoomServerFacet,
  existing: Context,
  host: DoomHeadlessHostService,
  registerOwner: ReturnType<typeof vi.fn>,
) {
  const root = new Context();
  root.provide(TEST_SERVER, existing.get(TEST_SERVER));
  root.provide(TEST_AGENT, host);
  root.provide(TEST_CATALOG, { registerOwner } as never);
  const owner = root.extend({ [TEST_OWNER]: { packageName: '@fixture/mode' } });
  const release = await facet.apply(owner);
  await vi.waitFor(() => expect(registerOwner).toHaveBeenCalled());
  return async () => {
    await release?.();
    await root.fiber.dispose();
  };
}
