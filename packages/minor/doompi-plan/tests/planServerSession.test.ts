import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHeadlessHostService, DoomHeadlessModelSettings } from '@agimon-ai/doompi-core/headless';
import type { MinorModeOwner } from '@agimon-ai/doompi-minor-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { PLAN_CONTINUE_TEXT, PLAN_EXIT_APPROVED_TEXT } from '../src/services/planMode';
import { PlanPointerService } from '../src/services/planPointer';
import { createPlanServerSession } from '../src/services/planServerSession';
import {
  CONTINUE_PLANNING_CHOICE,
  EXIT_PLAN_MODE_CHOICE,
  parsePlanStatus,
  PLAN_REVIEW_TITLE,
  PLAN_STATUS_KEY,
} from '../src/types/planApi';

/** The last activity-dock line the facet published, read back through the dock's parser. */
function lastPlanStatus(setStatus: ReturnType<typeof vi.fn>): string | undefined {
  const calls = setStatus.mock.calls.filter(([key]) => key === PLAN_STATUS_KEY);
  if (calls.length === 0) throw new Error(`The facet never published ${PLAN_STATUS_KEY}`);
  return calls[calls.length - 1]?.[1] as string | undefined;
}
function fixture() {
  let settings: DoomHeadlessModelSettings = { model: { provider: 'test', id: 'chat' }, thinkingLevel: 'medium' };
  const entries: Record<string, unknown>[] = [];
  const selection = { majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': [] as string[] } };
  const setModelSettings = vi.fn(async (next: Partial<DoomHeadlessModelSettings>) => {
    settings = { ...settings, ...next };
  });
  const request = vi.fn(async (): Promise<unknown> => undefined);
  const setStatus = vi.fn();
  // A real directory: the pointer is written with node:fs, and the restart case
  // is only meaningful if it can be read back.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-plan-server-'));
  homes.push(home);
  const host = {
    context: {
      repoRoot: '/repo',
      cwd: '/repo/subdir',
      environment: { HOME: home },
      sessionId: 'plan-server-session-test',
      selection,
      client: { request, setStatus },
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
  return {
    host,
    plugin,
    entries,
    mount,
    restart,
    request,
    setStatus,
    home,
    settings: () => settings,
    setModelSettings,
    selection,
  };
}

const homes: string[] = [];

beforeEach(() => {
  mocks.config.mockReturnValue({ modes: { planning: { main: { model: 'test/planner', thinking: 'max' } } } });
});

afterEach(() => {
  while (homes.length > 0) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('server planning model settings', () => {
  it('applies scoped settings and restores the original model after a remount', async () => {
    const f = fixture();
    const activate = f.mount();
    await activate('activate', { flavor: 'normal' });
    expect(mocks.config).toHaveBeenCalledWith('/repo', f.home);
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

  it('announces the written plan to the activity dock, and again after a restart', async () => {
    // A cockpit drives this facet and never the Pi runtime, so this is the only
    // code that can put a plan in the dock or leave its panel a pointer to read.
    const f = fixture();
    f.selection.state['minor-mode'] = ['plan'];
    f.entries.push({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '# Approved Plan\n\n1. Verify settings.' },
          { type: 'toolCall', id: 'write', name: 'write_plan', arguments: {} },
        ],
      },
    });
    const tool = f.plugin().tools.find((tool) => tool.name === 'write_plan')!;
    await tool.execute('write', {}, undefined, undefined, f.host.context);

    expect(parsePlanStatus(lastPlanStatus(f.setStatus))).toMatchObject({ title: 'Approved Plan' });
    // The panel answers from the pointer, so a status without one is a group
    // whose tab 404s.
    const pointer = new PlanPointerService({ env: { HOME: f.home } }).read('plan-server-session-test');
    expect(pointer).toMatchObject({ title: 'Approved Plan' });

    f.setStatus.mockClear();
    await f.restart();
    expect(parsePlanStatus(lastPlanStatus(f.setStatus))).toMatchObject({ title: 'Approved Plan' });
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

// The headless client answers with the option's `value`. This facet used to send the label as the
// value too, then compare it to 'exit'/'continue', so every review the reader answered failed.
describe('server plan review', () => {
  const review = async (f: ReturnType<typeof fixture>) => {
    await f.mount()('activate', { flavor: 'normal' });
    const tool = f.plugin().tools.find((tool) => tool.name === 'complete_plan')!;
    return tool.execute('review', {}, undefined, undefined, f.host.context);
  };

  it('asks with the decision on each option, not just the label the reader reads', async () => {
    const f = fixture();
    await review(f);
    expect(f.request).toHaveBeenCalledWith(
      {
        kind: 'select',
        title: PLAN_REVIEW_TITLE,
        options: [
          { label: EXIT_PLAN_MODE_CHOICE, value: 'exit' },
          { label: CONTINUE_PLANNING_CHOICE, value: 'continue' },
        ],
      },
      undefined,
    );
  });

  it('exits plan mode when the reader picks the exit option', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce('exit');
    const result = await review(f);
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ exited: true });
    expect(result.content).toEqual([{ type: 'text', text: PLAN_EXIT_APPROVED_TEXT }]);
    expect(f.entries.find((entry) => entry.customType === 'plan-review')?.data).toEqual({ decision: 'exit' });
    expect(f.selection.state['minor-mode']).toEqual([]);
  });

  it('stays in plan mode when the reader keeps planning', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce('continue');
    const result = await review(f);
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ exited: false });
    expect(result.content).toEqual([{ type: 'text', text: PLAN_CONTINUE_TEXT }]);
    expect(f.entries.find((entry) => entry.customType === 'plan-review')?.data).toEqual({ decision: 'continue' });
    expect(f.selection.state['minor-mode']).toEqual(['plan']);
  });

  it('treats a dismissed prompt as staying in plan mode rather than as approval', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(undefined);
    const result = await review(f);
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ exited: false });
    expect(f.selection.state['minor-mode']).toEqual(['plan']);
  });

  it('offers no decision parameter, so the agent cannot approve its own plan', () => {
    const tool = fixture()
      .plugin()
      .tools.find((tool) => tool.name === 'complete_plan')!;
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});
/** Activate a flavor, then rebuild the plugin through the restore path a real session uses. */
async function activated(f: ReturnType<typeof fixture>, flavor: string) {
  await f.mount()('activate', { flavor });
  const plugin = createPlanServerSession(f.host);
  await plugin.hooks?.find((hook) => hook.event === 'session_start')?.handle({}, f.host.context);
  return plugin;
}

async function promptFor(f: ReturnType<typeof fixture>, plugin: ReturnType<typeof createPlanServerSession>) {
  const hook = (plugin.hooks ?? []).find((hook) => hook.event === 'before_agent_start')!;
  const result = (await hook.handle({ systemPrompt: 'BASE' }, f.host.context)) as { systemPrompt: string };
  return result.systemPrompt;
}

// The server facet used to append a single sentence while the Pi extension appended the full
// delegation brief, so the same mode instructed the cockpit and the terminal differently.
describe('server planning system prompt', () => {
  it('appends the same plan mode brief the Pi extension does', async () => {
    const f = fixture();
    const plugin = await activated(f, 'normal');

    const prompt = await promptFor(f, plugin);

    expect(prompt).toContain('BASE');
    expect(prompt).toContain('[PLAN MODE ACTIVE]');
    expect(prompt).toContain('first call subagent with action "agents"');
    expect(prompt).toContain('[PLAN MODE ACTIVE: NORMAL]');
  });

  it('names the directory write_plan actually writes to', async () => {
    mocks.config.mockReturnValue({ modes: { planning: { plansDirectory: '/repo/.doom/plans' } } });
    const f = fixture();
    const plugin = await activated(f, 'normal');

    expect(await promptFor(f, plugin)).toContain('/repo/.doom/plans');
  });

  it('switches to the debug brief and carries recorded evidence into it', async () => {
    const f = fixture();
    const plugin = await activated(f, 'debug');
    const record = plugin.tools.find((tool) => tool.name === 'record_debug_evidence')!;
    await record.execute(
      'evidence',
      { issue: 'Tools leak when the mode is off' },
      undefined,
      undefined,
      f.host.context,
    );

    const systemPrompt = await promptFor(f, plugin);

    expect(systemPrompt).toContain('[PLAN MODE ACTIVE: DEBUG]');
    expect(systemPrompt).toContain('issue: Tools leak when the mode is off');
  });

  it('reports Fable as unavailable rather than idle, because this host has no broker', async () => {
    const f = fixture();
    const plugin = await activated(f, 'fable');

    const prompt = await promptFor(f, plugin);

    expect(prompt).toContain('[PLAN MODE ACTIVE: FABLE]');
    // This host declares no Fable broker, so the brief says so outright instead of describing a
    // run_fable_plan handoff the stub tool would refuse.
    expect(prompt).toContain('Fable planning is unavailable in this host');
    expect(prompt).not.toContain('call run_fable_plan');
  });

  it('keeps the flavor across a restart instead of silently planning as normal', async () => {
    const f = fixture();
    await f.mount()('activate', { flavor: 'debug' });

    f.selection.state['minor-mode'] = [];
    const restored = createPlanServerSession(f.host);
    await restored.hooks?.find((hook) => hook.event === 'session_start')?.handle({}, f.host.context);
    f.selection.state['minor-mode'] = ['plan'];
    const systemPrompt = await promptFor(f, restored);

    expect(systemPrompt).toContain('[PLAN MODE ACTIVE: DEBUG]');
  });

  it('carries a saved plan into the prompt so a cockpit edit is what gets implemented', async () => {
    const f = fixture();
    const plugin = await activated(f, 'normal');
    await f.host.context.session.appendCustomEntry('plan-document', {
      path: '/repo/.doom/plans/missing.md',
      content: '# Stored Plan\n\n1. Ship it.',
    });

    const prompt = await promptFor(f, plugin);

    expect(prompt).toContain('[CURRENT PLAN]');
    expect(prompt).toContain('Source: /repo/.doom/plans/missing.md');
    // The file is absent here, so the remembered text is the fallback rather than a hard failure.
    expect(prompt).toContain('# Stored Plan');
  });
});
