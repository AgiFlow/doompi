import { readFile } from 'node:fs/promises';

import {
  DOOM_HEADLESS_OWNER as TEST_OWNER,
  DOOM_HEADLESS_HOST_SERVICE as TEST_AGENT,
} from '@agimon-ai/doompi-core/headless';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE as TEST_SERVER, type DoomServerFacet } from '@agimon-ai/doompi-core/server-facet';
import { DOOM_MINOR_MODE_CATALOG_SERVICE as TEST_CATALOG } from '@agimon-ai/doompi-minor-mode';
import type { DoomHeadlessMinorMode } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
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
    const registerOwner = vi.fn((registered: DoomHeadlessMinorMode) => {
      mode = registered;
      return { dispose, publish };
    });
    const host = {
      context: { selection: { state: { 'minor-mode': minorModes } } },
      changeSelection: vi.fn(async ({ values: selected }: { values?: string[] }) => {
        minorModes.splice(0, minorModes.length, ...(selected ?? []));
      }),
      assertActive: vi.fn(),
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return { dispose };
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const close = await mountFacet(
      helpServerFacet,
      {
        effect() {},
        get: (name: string) =>
          name === 'doom/server-host' ? { scope: 'session', context: {}, registerApi: () => ({ dispose() {} }) } : host,
      } as unknown as Context,
      host,
      registerOwner,
    );
    if (!command || !mode) throw new Error('Help contributions were not registered');
    const execution = {
      client: { notify: vi.fn() },
    } as unknown as DoomHeadlessExecutionContext;

    const help = resources.find(({ name }) => name === 'doompi-help');
    const skill = resources.find(({ name }) => name === 'doompi-use-help');
    if (!help || !skill) throw new Error('Help resources were not registered');
    expect(mode.initialState.activation).toBe('inactive');
    expect(help.when).toEqual({ state: { 'minor-mode': 'help' }, attribution: { kind: 'minor', mode: 'help' } });
    expect(skill.when).toEqual({ state: { 'minor-mode': 'help' }, attribution: { kind: 'minor', mode: 'help' } });
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
