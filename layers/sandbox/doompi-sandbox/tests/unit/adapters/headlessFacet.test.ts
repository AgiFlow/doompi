import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sandboxHeadlessFacet } from '../../../src/adapters/headless/facet.ts';

function fixture() {
  const client = {
    notify: vi.fn(),
    request: vi.fn(),
    setStatus: vi.fn(),
  };
  const execution = {
    cwd: process.cwd(),
    sessionId: 'sandbox-headless-test',
    client,
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
    },
    selection: { majorMode: 'test', activeLayers: ['sandbox'], domains: [], minorModes: [] },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  const resources: DoomHeadlessResource[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const commands: DoomHeadlessCommand[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const host = {
    context: execution,
    select: vi.fn(),
    registerResource(resource: DoomHeadlessResource) {
      resources.push(resource);
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    },
    registerActivity(activity: DoomHeadlessActivity) {
      activities.push(activity);
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    },
    registerCommand(command: DoomHeadlessCommand) {
      commands.push(command);
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
  };
  const context = {
    get: (key: string) => (key === DOOM_HEADLESS_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { activities, client, commands, context, disposers, execution, resources };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sandbox headless facet', () => {
  it('defers the optional broker and registers the live status command and resources', async () => {
    vi.stubEnv('DOOMPI_SANDBOX_BROKER', '0');
    const test = fixture();
    const dispose = sandboxHeadlessFacet.apply(test.context);

    expect(test.resources.map((resource) => resource.name)).toEqual([
      'doompi-sandbox',
      'doompi-use-sandbox',
      'doompi-sandbox-readme',
    ]);
    expect(test.activities).toHaveLength(1);
    expect(test.commands.map((command) => command.name)).toEqual(['doom-sandbox']);
    expect(test.client.setStatus).not.toHaveBeenCalled();

    await test.activities[0]!.start(test.execution);
    expect(test.client.setStatus).not.toHaveBeenCalled();
    await test.commands[0]!.execute('', test.execution);
    expect(test.client.notify).toHaveBeenCalledOnce();

    dispose?.();
    expect(test.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
