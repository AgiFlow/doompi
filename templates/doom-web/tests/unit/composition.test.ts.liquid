import { describe, expect, it } from 'vitest';
import { activityGroups, minorModes } from '../../src/web/lib/composition.ts';
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
});

describe('activityGroups', () => {
  it('lists only the groups this composition loaded', () => {
    expect(activityGroups({}, [])).toEqual([]);

    const groups = activityGroups({ 'doom-runner-runners': '', 'doom-team-agents': '2 running' }, []);
    expect(groups.map((group) => group.name)).toEqual(['agents', 'runners']);
    expect(groups[0]).toMatchObject({ summary: '2 running', active: true });
    expect(groups[1]).toMatchObject({ summary: '', active: false });
  });

  it('adds workflows when the widget shows up', () => {
    const groups = activityGroups({}, ['workflow-mcp-follow']);
    expect(groups.map((group) => group.name)).toEqual(['workflows']);
  });
});
