import { readFile } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessMinorMode,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { helpServerFacet } from '../../src/extensions/server';

describe('help headless facet', () => {
  it('registers activation-gated resources and sends them through the help command', async () => {
    const resources: DoomHeadlessResource[] = [];
    let command: DoomHeadlessCommand | undefined;
    let mode: DoomHeadlessMinorMode | undefined;
    const minorModes: string[] = [];
    const dispose = vi.fn();
    const publish = vi.fn();
    const host = {
      context: { selection: { minorModes } },
      changeSelection: vi.fn(async ({ minorModes: selected }: { minorModes?: readonly string[] }) => {
        minorModes.splice(0, minorModes.length, ...(selected ?? []));
      }),
      registerMinorMode: (registered: DoomHeadlessMinorMode) => {
        mode = registered;
        return { dispose, publish };
      },
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return { dispose };
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const close = await helpServerFacet.apply({
      effect() {},
      get: (name: string) =>
        name === 'doom/server-host' ? { scope: 'session', context: {}, registerApi: () => ({ dispose() {} }) } : host,
    } as unknown as Context);
    if (!command || !mode) throw new Error('Help contributions were not registered');
    const execution = {
      client: { notify: vi.fn() },
    } as unknown as DoomHeadlessExecutionContext;

    const help = resources.find(({ name }) => name === 'doompi-help');
    const skill = resources.find(({ name }) => name === 'doompi-use-help');
    if (!help || !skill) throw new Error('Help resources were not registered');
    expect(mode.initialState.activation).toBe('inactive');
    expect(help.when).toEqual({ minorMode: 'help' });
    expect(skill.when).toEqual({ minorMode: 'help' });
    expect(await help.read(execution)).toBe(await readFile(new URL('../../llms.txt', import.meta.url), 'utf8'));
    expect(await skill.read(execution)).toContain('help');

    await command.execute('', execution);
    expect(execution.client.notify).toHaveBeenCalledWith({
      title: 'DoomPi help',
      body: await help.read(execution),
      level: 'info',
    });

    const actionExecution = {
      context: execution,
      operationId: 'help-test',
      sessionKind: 'headless' as const,
      signal: new AbortController().signal,
    };
    await mode.handleAction('activate', {}, actionExecution);
    expect(minorModes).toEqual(['help']);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'active' }));
    await mode.handleAction('deactivate', {}, actionExecution);
    expect(minorModes).toEqual([]);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));

    await close?.();
    expect(dispose).toHaveBeenCalledTimes(4);
  });
});
