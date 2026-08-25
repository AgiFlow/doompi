import { describe, expect, it } from 'vitest';
import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { activityGroups, minorModes, selectionAxes } from '../../src/web/lib/composition.ts';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry.ts';
import { ansiSegments, emptySelection, parseSelection, stripAnsi } from '../../src/web/lib/statusLine.ts';

// Captured from a live `doompi --mode rpc` session, so the parser is tested
// against what DoomPi really publishes rather than a guess at the format.
const LIVE_STATUS =
  '\u001B[38;2;81;175;239m[copilot]\u001B[39m\u001B[38;2;91;98;104m:\u001B[39m\u001B[38;2;156;160;164mdevelopment,testing\u001B[39m';
const PENDING_STATUS = '\u001B[38;2;236;190;123m[minimal]\u001B[39m\u001B[38;2;156;160;164mdevelopment\u001B[39m';
const WITH_PROFILE =
  '\u001B[38;2;152;190;101m*reviewer*\u001B[39m:\u001B[38;2;81;175;239m[copilot]\u001B[39m:\u001B[38;2;156;160;164mplatform\u001B[39m';

describe('ansi helpers', () => {
  it('splits runs and keeps the colour in force', () => {
    const segments = ansiSegments(LIVE_STATUS);
    expect(segments[0]).toEqual({ text: '[copilot]', rgb: [81, 175, 239] });
    expect(segments.at(-1)?.text).toBe('development,testing');
  });

  it('strips the escapes for display', () => {
    expect(stripAnsi(LIVE_STATUS)).toBe('[copilot]:development,testing');
  });

  it('survives text with no escapes at all', () => {
    expect(ansiSegments('plain')).toEqual([{ text: 'plain', rgb: null }]);
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('parseSelection', () => {
  it('reads a real status line', () => {
    expect(parseSelection(LIVE_STATUS)).toEqual({
      profile: '',
      majorMode: 'copilot',
      domains: ['development', 'testing'],
      pending: false,
    });
  });

  it('reads a profile when the session has one', () => {
    expect(parseSelection(WITH_PROFILE)).toMatchObject({
      profile: 'reviewer',
      majorMode: 'copilot',
      domains: ['platform'],
    });
  });

  it('reports a pending switch from the warning colour', () => {
    expect(parseSelection(PENDING_STATUS).pending).toBe(true);
    expect(parseSelection(LIVE_STATUS).pending).toBe(false);
  });

  it('returns nothing for an empty or cleared status', () => {
    expect(parseSelection('')).toEqual(emptySelection);
    expect(parseSelection('   ')).toEqual(emptySelection);
  });

  it('handles a mode with no domains', () => {
    expect(parseSelection('[minimal]')).toMatchObject({ majorMode: 'minimal', domains: [] });
  });
});

describe('minorModes', () => {
  it('prefers the journaled catalog over status inference when the runtime reports one', () => {
    const modes = minorModes({ 'plan-mode': '' }, [], {
      version: 1,
      revision: 3,
      modes: [
        {
          id: 'help',
          label: 'Help',
          description: '',
          order: 10,
          activation: 'active',
          condition: 'ready',
          actions: [],
        },
        {
          id: 'loop.active',
          label: 'Loop',
          description: '',
          order: 30,
          activation: 'activating',
          condition: 'ready',
          actions: [],
        },
        {
          id: 'plan',
          label: 'Plan',
          description: '',
          order: 20,
          activation: 'inactive',
          condition: 'ready',
          actions: [],
        },
      ],
    });
    const byName = Object.fromEntries(modes.map((mode) => [mode.name, mode]));

    // Help publishes no status yet reads on, straight from the catalog.
    expect(byName.help).toMatchObject({ id: 'help', availability: 'on', keys: 'h e' });
    expect(byName.plan).toMatchObject({ id: 'plan', availability: 'off' });
    // The id stem links the catalog record to the declared row and its keys.
    expect(byName.loop).toMatchObject({ id: 'loop.active', availability: 'off', detail: 'activating', keys: 'l l' });
    // Declared modes the catalog lacks stay listed as unavailable.
    expect(byName.goal.availability).toBe('unavailable');
    expect(byName.workflow.availability).toBe('unavailable');
  });

  it('drives the mode its key drives, which is not always the one it is named after', () => {
    // SPC v e toggles autonomous capture, which the runtime registers as
    // 'voice-auto'; 'voice' is the one-shot dictation command on v v. A row
    // that sent its own label would reach the wrong mode.
    const modes = minorModes({ 'doom-voice': 'listening' }, []);
    const voice = modes.find((mode) => mode.name === 'voice');

    expect(voice?.id).toBe('voice-auto');
    expect(voice?.availability).toBe('on');
  });

  it('sends a mode whose id matches its name unchanged', () => {
    const modes = minorModes({ goal: 'ship the gate' }, []);

    expect(modes.find((mode) => mode.name === 'goal')?.id).toBe('goal');
  });

  it('separates a mode that is absent from one that is merely off', () => {
    const modes = minorModes({ 'plan-mode': '', goal: 'ship the gate' }, []);
    const byName = Object.fromEntries(modes.map((mode) => [mode.name, mode]));

    expect(byName.plan.availability).toBe('off');
    expect(byName.goal.availability).toBe('on');
    expect(byName.goal.detail).toBe('ship the gate');
    expect(byName.loop.availability).toBe('unavailable');
    expect(byName.help.availability).toBe('unavailable');
  });

  it('reads workflow from its widget, the only signal it gives', () => {
    const modes = minorModes({}, ['workflow-mcp-progress']);
    expect(modes.find((mode) => mode.name === 'workflow')?.availability).toBe('off');
  });

  it('strips colour out of the detail it shows', () => {
    const modes = minorModes({ goal: '\u001B[38;2;236;190;123mheld\u001B[39m' }, []);
    expect(modes.find((mode) => mode.name === 'goal')?.detail).toBe('held');
  });

  it('always reports every mode DoomPi ships', () => {
    expect(minorModes({}, []).map((mode) => mode.name)).toEqual(['help', 'plan', 'loop', 'goal', 'workflow', 'voice']);
  });

  it('prefers plugin-declared modes over the packaged fallback, in declared order', () => {
    resetWebPlugins();
    installWebPlugins([
      defineWebPlugin({
        id: 'demo',
        minorModes: [
          { name: 'zeta', keys: 'z e', statusKey: 'zeta-mode', order: 20 },
          { name: 'alpha', keys: 'a e', order: 10 },
        ],
      }),
    ]);
    try {
      const modes = minorModes({ 'zeta-mode': 'running' }, []);
      expect(modes.map((mode) => mode.name)).toEqual(['alpha', 'zeta']);
      expect(modes[1]).toMatchObject({ availability: 'on', detail: 'running' });
      // No signal declared means unavailable, same as the fallback semantics.
      expect(modes[0]?.availability).toBe('unavailable');
    } finally {
      resetWebPlugins();
    }
  });
});

describe('selectionAxes', () => {
  it('keeps an unpublished axis off the bar and reads the published one', () => {
    expect(selectionAxes({})).toEqual([]);
    expect(selectionAxes({ 'doom-profile': '' })).toEqual([
      { name: 'profile', command: 'profile', values: [], emptyLabel: 'no profile', multi: false },
    ]);
  });

  it('strips colour out of the selection it shows', () => {
    const axes = selectionAxes({ 'doom-profile': '\u001B[38;2;152;190;101mreviewer\u001B[39m' });
    expect(axes[0]?.values).toEqual(['reviewer']);
  });

  it('splits a multi axis on commas, since several domains compose at once', () => {
    expect(selectionAxes({ 'doom-domain': 'development, testing,' })).toEqual([
      {
        name: 'domains',
        command: 'domains',
        values: ['development', 'testing'],
        emptyLabel: 'no domains',
        multi: true,
      },
    ]);
    expect(selectionAxes({ 'doom-domain': '' })[0]?.values).toEqual([]);
  });

  it('lists the axes in their declared order', () => {
    expect(selectionAxes({ 'doom-domain': 'default', 'doom-profile': 'reviewer' }).map((axis) => axis.name)).toEqual([
      'profile',
      'domains',
    ]);
  });

  it('prefers plugin-declared axes over the packaged fallback, in declared order', () => {
    resetWebPlugins();
    installWebPlugins([
      defineWebPlugin({
        id: 'demo',
        selectionAxes: [
          { name: 'zeta', command: 'zeta', statusKey: 'zeta-axis', emptyLabel: 'no zeta', order: 20 },
          { name: 'alpha', command: 'alpha', statusKey: 'alpha-axis', emptyLabel: 'no alpha', order: 10 },
        ],
      }),
    ]);
    try {
      expect(selectionAxes({ 'zeta-axis': 'z', 'alpha-axis': '', 'doom-profile': 'not declared any more' })).toEqual([
        { name: 'alpha', command: 'alpha', values: [], emptyLabel: 'no alpha', multi: false },
        { name: 'zeta', command: 'zeta', values: ['z'], emptyLabel: 'no zeta', multi: false },
      ]);
    } finally {
      resetWebPlugins();
    }
  });
});

describe('activityGroups', () => {
  const installOwners = (): void =>
    installWebPlugins([
      defineWebPlugin({
        id: 'subagents',
        activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'doom-team-agents', tab: 'subagents', order: 10 }],
      }),
      defineWebPlugin({
        id: 'runner',
        activityGroups: [{ name: 'runners', keys: 'r l', statusKey: 'doom-runner-runners', order: 20 }],
      }),
      defineWebPlugin({
        id: 'workflows',
        activityGroups: [
          {
            name: 'workflows',
            keys: 'w r',
            widgetKeys: ['workflow-mcp-progress', 'workflow-mcp-follow'],
            tab: 'workflows',
            order: 30,
          },
        ],
      }),
    ]);

  it('has no host-side table: a session signal with no owning package shows nothing', () => {
    expect(
      activityGroups({ 'doom-team-agents': '2 running', 'doom-runner-runners': '' }, ['workflow-mcp-follow']),
    ).toEqual([]);
  });

  it('lists only the declared groups the session signals, with their tabs', () => {
    installOwners();
    try {
      expect(activityGroups({}, [])).toEqual([]);

      const groups = activityGroups({ 'doom-runner-runners': '', 'doom-team-agents': '2 running' }, []);
      expect(groups.map((group) => group.name)).toEqual(['agents', 'runners']);
      expect(groups[0]).toEqual({ name: 'agents', keys: 'a r', summary: '2 running', active: true, tab: 'subagents' });
      expect(groups[1]).toEqual({ name: 'runners', keys: 'r l', summary: '', active: false });
    } finally {
      resetWebPlugins();
    }
  });

  it('adds workflows when the widget shows up', () => {
    installOwners();
    try {
      const groups = activityGroups({}, ['workflow-mcp-follow']);
      expect(groups.map((group) => group.name)).toEqual(['workflows']);
      expect(groups[0]?.tab).toBe('workflows');
    } finally {
      resetWebPlugins();
    }
  });
});

describe('a catalog mode that cannot run here', () => {
  const catalog = (actions: { id: string; enabled: boolean; disabledReason?: string }[]) => ({
    version: 1 as const,
    revision: 1,
    modes: [
      {
        id: 'voice-auto',
        label: 'Voice',
        description: 'autonomous capture',
        order: 30,
        activation: 'inactive' as const,
        condition: 'ready',
        actions: actions.map((action) => ({
          label: action.id,
          description: '',
          needsInput: false,
          ...action,
        })),
      },
    ],
  });

  it('is unavailable, and carries the mode own words for why', () => {
    const [voice] = minorModes(
      {},
      [],
      catalog([
        { id: 'activate', enabled: false, disabledReason: 'Autonomous voice requires an interactive session.' },
        { id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice requires an interactive session.' },
      ]),
    );

    expect(voice.availability).toBe('unavailable');
    expect(voice.unavailableReason).toBe('Autonomous voice requires an interactive session.');
  });

  it('is off, not unavailable, while one action can still run', () => {
    const [voice] = minorModes(
      {},
      [],
      catalog([
        { id: 'activate', enabled: true },
        { id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice is disabled.' },
      ]),
    );

    expect(voice.availability).toBe('off');
    expect(voice.unavailableReason).toBe('');
  });

  it('stays on while it is running, whatever its actions report', () => {
    const projection = catalog([{ id: 'activate', enabled: false, disabledReason: 'already enabled' }]);
    const running = { ...projection, modes: [{ ...projection.modes[0], activation: 'active' as const }] };

    // An active mode with every action disabled is still active, and saying
    // otherwise would hide a mode that is doing something right now.
    expect(minorModes({}, [], running)[0].availability).toBe('on');
  });
});
