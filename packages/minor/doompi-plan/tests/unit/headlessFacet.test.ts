import { readFile } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessHook,
  DoomHeadlessMinorMode,
  DoomHeadlessResource,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { planServerFacet } from '../../src/extensions/server';

async function fixture() {
  let selection: DoomHeadlessSelection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    minorModes: ['retained'],
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
  const host = {
    context: execution,
    changeSelection: async (patch: Partial<DoomHeadlessSelection>) => {
      selection = { ...selection, ...patch };
    },
    registerMinorMode: (value: DoomHeadlessMinorMode) => {
      mode = value;
      return { publish, dispose };
    },
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
  const close = await planServerFacet.apply({
    effect() {},
    get: (name: string) =>
      name === 'doom/server-host' ? { scope: 'session', context: {}, registerApi: () => ({ dispose() {} }) } : host,
  } as unknown as Context);
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
      expect(contribution.when).toEqual({ minorMode: 'plan' });
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
      expect(test.execution.selection.minorModes).toEqual(['retained', 'plan']);
      expect(test.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ activation: 'active', modelContextVariant: flavor }),
      );
      await test.action('deactivate');
      expect(test.execution.selection.minorModes).toEqual(['retained']);
      expect(test.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));
    },
  );

  it('rejects invalid flavors, unknown actions and aborted activation without changing selection', async () => {
    const test = await fixture();
    await expect(test.action('activate', { flavor: 'invalid' })).rejects.toThrow('valid plan flavor');
    await expect(test.action('unknown')).rejects.toThrow('Unknown plan mode action');
    await expect(test.action('activate', { flavor: 'normal' }, AbortSignal.abort())).rejects.toThrow();
    expect(test.execution.selection.minorModes).toEqual(['retained']);
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
