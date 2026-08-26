import type {
  MinorModeActionRequest,
  MinorModeCatalogService,
  MinorModeRecord,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { actionsFor, matchMinorMode, registerMinorModeCommand } from '../../src/extensions/entries/minorModeCommand.ts';

function record(overrides: {
  id: string;
  label: string;
  activation?: MinorModeRecord['state']['activation'];
  actions?: MinorModeRecord['descriptor']['actions'];
  availability?: MinorModeRecord['state']['actions'];
}): MinorModeRecord {
  return {
    descriptor: {
      source: '@agimon-ai/test',
      id: overrides.id,
      label: overrides.label,
      description: `${overrides.label} mode.`,
      order: 10,
      actions: overrides.actions ?? [
        { id: 'toggle', label: 'Toggle', description: 'Flip it.', contexts: ['tui', 'headless'], parameters: [] },
      ],
    },
    state: {
      activation: overrides.activation ?? 'inactive',
      condition: 'ready',
      actions: overrides.availability ?? [],
    },
    ownerGeneration: 'gen-1',
    registrationId: 'reg-1',
    stateRevision: 1,
  };
}

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function harness(records: MinorModeRecord[], selectAnswers: Array<string | undefined> = []) {
  let registered: RegisteredCommand | undefined;
  const pi = {
    registerCommand: (_name: string, command: RegisteredCommand) => {
      registered = command;
    },
  } as unknown as ExtensionAPI;
  const invoke = vi.fn(async (request: MinorModeActionRequest) => ({
    operationId: request.operationId,
    catalogRevision: 2,
    mode: records[0],
    message: undefined,
  }));
  const catalog = { list: () => records, invoke } as unknown as MinorModeCatalogService;
  registerMinorModeCommand(pi, () => catalog);
  const notify = vi.fn();
  const select = vi.fn(async () => selectAnswers.shift());
  const input = vi.fn(async () => 'typed');
  const ctx = {
    mode: 'rpc',
    hasUI: false,
    ui: { notify, select, input, confirm: vi.fn() },
  } as unknown as ExtensionContext;
  return { command: registered as RegisteredCommand, ctx, notify, select, input, invoke };
}

describe('the /minor command', () => {
  it('matches modes by id, label, and id stem', () => {
    const records = [record({ id: 'loop.active', label: 'Loop' }), record({ id: 'plan', label: 'Plan' })];
    expect(matchMinorMode(records, 'plan')?.descriptor.id).toBe('plan');
    expect(matchMinorMode(records, 'Loop')?.descriptor.id).toBe('loop.active');
    expect(matchMinorMode(records, 'loop')?.descriptor.id).toBe('loop.active');
    expect(matchMinorMode(records, 'nope')).toBeUndefined();
  });

  it('filters actions by session kind and availability', () => {
    const entry = record({
      id: 'plan',
      label: 'Plan',
      actions: [
        { id: 'enter', label: 'Enter', description: 'On.', contexts: ['headless', 'tui'], parameters: [] },
        { id: 'tui-only', label: 'Menu', description: 'TUI.', contexts: ['tui'], parameters: [] },
        { id: 'blocked', label: 'Blocked', description: 'Off.', contexts: ['headless'], parameters: [] },
      ],
      availability: [{ id: 'blocked', enabled: false, disabledReason: 'busy' }],
    });
    expect(actionsFor(entry, 'headless').map((action) => action.id)).toEqual(['enter']);
    expect(actionsFor(entry, 'tui').map((action) => action.id)).toEqual(['enter', 'tui-only']);
  });

  it('invokes the single action of a named mode outright', async () => {
    const { command, ctx, invoke, notify } = harness([record({ id: 'plan', label: 'Plan' })]);
    await command.handler('plan', ctx);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ actionId: 'toggle', mode: { id: 'plan' } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Plan is'), 'info');
  });

  it('asks which opt-in to use when a mode has several', async () => {
    const entry = record({
      id: 'plan',
      label: 'Plan',
      actions: [
        { id: 'enter', label: 'Enter', description: 'Read-only planning.', contexts: ['headless'], parameters: [] },
        {
          id: 'debug',
          label: 'Debug',
          description: 'Adaptive debug planning.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    });
    const { command, ctx, invoke, select } = harness([entry], ['Debug: Adaptive debug planning.']);
    await command.handler('plan', ctx);
    expect(select).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ actionId: 'debug' });
  });

  it('lists the catalog for a bare /minor and honors a cancel', async () => {
    const records = [
      record({ id: 'plan', label: 'Plan', activation: 'active' }),
      record({ id: 'goal', label: 'Goal' }),
    ];
    const { command, ctx, invoke, select } = harness(records, [undefined]);
    await command.handler('', ctx);
    expect(select).toHaveBeenCalledWith('Minor modes (1 on)', ['[x] Plan: Plan mode.', '[ ] Goal: Goal mode.']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('gathers required parameters before invoking', async () => {
    const entry = record({
      id: 'loop.active',
      label: 'Loop',
      actions: [
        {
          id: 'start',
          label: 'Start',
          description: 'Start a loop.',
          contexts: ['headless'],
          parameters: [
            { name: 'launcherId', label: 'Launcher', kind: 'string', required: true },
            { name: 'note', label: 'Note', kind: 'string', required: false },
          ],
        },
      ],
    });
    const { command, ctx, invoke, input } = harness([entry]);
    await command.handler('loop start', ctx);
    expect(input).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ actionId: 'start', arguments: { launcherId: 'typed' } });
  });

  it('says why a mode has nothing to run, in the mode own words', async () => {
    const voice = record({
      id: 'voice-auto',
      label: 'Voice',
      actions: [
        { id: 'activate', label: 'Activate', description: 'On.', contexts: ['tui', 'headless'], parameters: [] },
        { id: 'deactivate', label: 'Deactivate', description: 'Off.', contexts: ['tui', 'headless'], parameters: [] },
      ],
      availability: [
        { id: 'activate', enabled: false, disabledReason: 'Autonomous voice requires an interactive session.' },
        { id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice requires an interactive session.' },
      ],
    });
    const { command, ctx, notify, invoke } = harness([voice]);

    await command.handler('voice-auto', ctx);

    // A bare "no actions available" leaves a cockpit user guessing; the reason
    // the mode published is what tells them to reach for the TUI instead.
    expect(notify).toHaveBeenCalledWith(
      'Voice has no actions available in this session. Autonomous voice requires an interactive session.',
      'warning',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('still names the mode when it published no reason', async () => {
    const quiet = record({
      id: 'quiet',
      label: 'Quiet',
      actions: [{ id: 'go', label: 'Go', description: 'On.', contexts: ['tui'], parameters: [] }],
    });
    const { command, ctx, notify } = harness([quiet]);

    await command.handler('quiet', ctx);

    expect(notify).toHaveBeenCalledWith('Quiet has no actions available in this session.', 'warning');
  });

  it('reports an unknown mode with what exists', async () => {
    const { command, ctx, invoke, notify } = harness([record({ id: 'plan', label: 'Plan' })]);
    await command.handler('warp', ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No minor mode matches "warp"'), 'warning');
  });
});
