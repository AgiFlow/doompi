import type { DoomHeadlessHostService, DoomHeadlessModelSettings } from '@agimon-ai/doompi-core/headless';
import type { MinorModeOwner } from '@agimon-ai/doompi-minor-mode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ config: vi.fn(), owners: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));
vi.mock('../src/schemas/plan/config', async (original) => ({
  ...(await original<typeof import('../src/schemas/plan/config')>()),
  loadDoomConfig: mocks.config,
}));
vi.mock('@agimon-ai/doompi-minor-mode', async (original) => ({
  ...(await original<typeof import('@agimon-ai/doompi-minor-mode')>()),
  serverMinorModes: (owners: MinorModeOwner[]) => {
    mocks.owners(owners);
    return () => undefined;
  },
}));

import { createPlanServerSession } from '../src/controllers/planServerSession';

function fixture() {
  let settings: DoomHeadlessModelSettings = { model: { provider: 'test', id: 'chat' }, thinkingLevel: 'medium' };
  const entries: Record<string, unknown>[] = [];
  const selection = { majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': [] as string[] } };
  const setModelSettings = vi.fn(async (next: Partial<DoomHeadlessModelSettings>) => {
    settings = { ...settings, ...next };
  });
  const host = {
    context: {
      repoRoot: '/repo',
      cwd: '/repo/subdir',
      environment: { HOME: '/test-home' },
      selection,
      session: {
        readModelSettings: async () => settings,
        setModelSettings,
        appendCustomEntry: async (customType: string, data: unknown) => {
          entries.unshift({ customType, data });
        },
        entries: async (query?: { customType?: string }) =>
          query?.customType
            ? entries.filter((entry) => entry.customType === query.customType).slice(0, 1)
            : [...entries].reverse(),
      },
    },
    changeSelection: async ({ values }: { values: string[] }) => {
      selection.state['minor-mode'] = values;
    },
  } as unknown as DoomHeadlessHostService;
  const plugin = () => createPlanServerSession(host);
  const mount = () => {
    createPlanServerSession(host);
    const owner = mocks.owners.mock.calls.at(-1)![0][0] as MinorModeOwner;
    return (id: string, args: Record<string, string | number | boolean> = {}) =>
      owner.definition.handleAction(id, args, {
        signal: new AbortController().signal,
      } as Parameters<typeof owner.definition.handleAction>[2]);
  };
  const restart = async () => {
    selection.state['minor-mode'] = [];
    const plugin = createPlanServerSession(host);
    const hook = plugin.hooks?.find((hook) => hook.event === 'session_start');
    await hook?.handle({}, host.context);
  };
  return { host, plugin, entries, mount, restart, settings: () => settings, setModelSettings, selection };
}

beforeEach(() => {
  mocks.config.mockReturnValue({ modes: { planning: { main: { model: 'test/planner', thinking: 'max' } } } });
});

describe('server planning model settings', () => {
  it('applies scoped settings and restores the original model after a remount', async () => {
    const f = fixture();
    const activate = f.mount();
    await activate('activate', { flavor: 'normal' });
    expect(mocks.config).toHaveBeenCalledWith('/repo', '/test-home');
    expect(f.settings()).toEqual({ model: { provider: 'test', id: 'planner' }, thinkingLevel: 'max' });
    await activate('activate', { flavor: 'debug' });
    expect(f.setModelSettings).toHaveBeenCalledTimes(1);
    await f.mount()('deactivate');
    expect(f.settings()).toEqual({ model: { provider: 'test', id: 'chat' }, thinkingLevel: 'medium' });
    expect(f.selection.state['minor-mode']).toEqual([]);
  });

  it('restores settings and leaves the mode off when applying the model fails', async () => {
    const f = fixture();
    f.setModelSettings.mockRejectedValueOnce(new Error('Model not found'));
    await expect(f.mount()('activate', { flavor: 'normal' })).rejects.toThrow('Model not found');
    expect(f.settings()).toEqual({ model: { provider: 'test', id: 'chat' }, thinkingLevel: 'medium' });
    expect(f.selection.state['minor-mode']).toEqual([]);
  });

  it('ends the model override when restart clears the active minor mode', async () => {
    const f = fixture();
    await f.mount()('activate', { flavor: 'normal' });
    await f.restart();
    expect(f.settings()).toEqual({ model: { provider: 'test', id: 'chat' }, thinkingLevel: 'medium' });
    expect(f.selection.state['minor-mode']).toEqual([]);
  });
});

describe('server planning evidence', () => {
  it('saves assistant Markdown from journal text blocks without reading user instructions as a plan', async () => {
    const f = fixture();
    f.selection.state['minor-mode'] = ['plan'];
    f.entries.push(
      { type: 'message', message: { role: 'user', content: '# Not the plan' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: '# Approved Plan\n\n1. Verify settings.' },
            { type: 'toolCall', id: 'write', name: 'write_plan', arguments: {} },
          ],
        },
      },
    );
    const tool = f.plugin().tools.find((tool) => tool.name === 'write_plan')!;
    const result = await tool.execute('write', {}, undefined, undefined, f.host.context);
    expect(result.isError).not.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('approved-plan-'),
      '# Approved Plan\n\n1. Verify settings.\n',
      expect.objectContaining({ flag: 'wx' }),
    );
  });
  it('saves a plan that opens with prose before its first heading', async () => {
    const f = fixture();
    f.selection.state['minor-mode'] = ['plan'];
    f.entries.push({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the plan.\n\n## Steps\n\n1. Verify settings.' },
          { type: 'toolCall', id: 'write', name: 'write_plan', arguments: {} },
        ],
      },
    });
    const tool = f.plugin().tools.find((tool) => tool.name === 'write_plan')!;
    const result = await tool.execute('write', {}, undefined, undefined, f.host.context);
    expect(result.isError).not.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      'Here is the plan.\n\n## Steps\n\n1. Verify settings.\n',
      expect.objectContaining({ flag: 'wx' }),
    );
  });
  it('saves only the text introducing this tool call, not trailing text or another call', async () => {
    const f = fixture();
    f.selection.state['minor-mode'] = ['plan'];
    f.entries.push(
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '# Older Plan' },
            { type: 'toolCall', id: 'older', name: 'write_plan', arguments: {} },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '# Current Plan' },
            { type: 'toolCall', id: 'write', name: 'write_plan', arguments: {} },
            { type: 'text', text: 'Trailing commentary.' },
          ],
        },
      },
    );
    const tool = f.plugin().tools.find((tool) => tool.name === 'write_plan')!;
    const result = await tool.execute('write', {}, undefined, undefined, f.host.context);
    expect(result.isError).not.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      '# Current Plan\n',
      expect.objectContaining({ flag: 'wx' }),
    );
  });
  it('accepts every advertised evidence field through the actual parser', async () => {
    const f = fixture();
    const tool = f.plugin().tools.find((tool) => tool.name === 'record_debug_evidence')!;
    const schema = tool.parameters as { properties: Record<string, { type: string }> };
    const packet = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        value.type === 'array' ? ['Observed evidence'] : 'Observed behavior',
      ]),
    );
    const result = await tool.execute('evidence', packet, undefined, undefined, f.host.context);
    expect(result.isError).not.toBe(true);
    expect(f.entries[0]?.data).toMatchObject({
      reproductionAttempt: 'Observed behavior',
      browserConsoleEvidence: ['Observed evidence'],
    });
  });
});
