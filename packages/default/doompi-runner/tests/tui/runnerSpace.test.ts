import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { PtyRun } from '../../src/types/ptyHost';
import type { RunnerRecord } from '../../src/types/runnerRegistry';
import { formatWidgetHeading, formatWidgetLine, toRunnerRows } from '../../src/tui/format.ts';
import { RunnerSpaceComponent } from '../../src/tui/runnerSpace.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

/** Themes only decorate, so an identity theme keeps assertions about text. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  inverse: (text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function record(overrides: Partial<RunnerRecord> = {}): RunnerRecord {
  return {
    id: 'api-id',
    name: 'api',
    pid: 42,
    command: 'nx dev-start api',
    cwd: '/repo',
    logPath: '/logs/api.log',
    interactive: false,
    sessionId: 'session-a',
    startedAt: '2026-08-01T11:55:00.000Z',
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 1,
    ...overrides,
  };
}

describe('widget formatting', () => {
  it('puts name, uptime and command on one line', () => {
    expect(formatWidgetLine(record(), NOW)).toBe('api · 5m · nx dev-start api');
  });

  it('marks a runner that has a terminal', () => {
    expect(formatWidgetLine(record({ interactive: true }), NOW)).toContain('· tty ·');
  });

  it('counts runners in the heading', () => {
    expect(formatWidgetHeading(3)).toBe('Runners (3)');
  });
});

describe('toRunnerRows', () => {
  it('renders pid, uptime and command as the detail', () => {
    expect(toRunnerRows([record()], NOW)).toEqual([
      { name: 'api', detail: 'pid 42 · up 5m · nx dev-start api', interactive: false },
    ]);
  });
});

interface Harness {
  component: RunnerSpaceComponent;
  rendered: () => string;
  stopped: string[];
  closed: () => boolean;
  renders: () => number;
  setRows: (rows: number) => void;
}

function harness(
  records: RunnerRecord[],
  ptyRuns: Record<string, PtyRun> = {},
  logs: Record<string, string> = {},
  renderTheme: Theme = theme,
  stopError?: Error,
): Harness {
  const stopped: string[] = [];
  let live = [...records];
  let done = false;
  let renders = 0;
  const terminal = { rows: 24 };
  const tui = {
    terminal,
    requestRender: () => {
      renders += 1;
    },
  };

  const component = new RunnerSpaceComponent(
    tui,
    renderTheme,
    {
      getRunners: () => live,
      getPtyRun: (name) => ptyRuns[name],
      readLog: (logPath) => logs[logPath] ?? '',
      stopRunner: async (id) => {
        if (stopError) throw stopError;
        stopped.push(id);
        live = live.filter((entry) => entry.id !== id);
      },
    },
    () => {
      done = true;
    },
  );

  return {
    component,
    rendered: () => component.render(120).join('\n'),
    stopped,
    closed: () => done,
    renders: () => renders,
    setRows: (rows) => {
      terminal.rows = rows;
    },
  };
}

function fakePtyRun(name: string, screen: string): PtyRun {
  return {
    id: `${name}-id`,
    name,
    pid: 42,
    logPath: `/logs/${name}.log`,
    backend: 'native',
    output: () => '',
    completion: () => new Promise(() => undefined),
    detach: () => undefined,
    stop: async () => true,
    write: vi.fn(),
    screen: () => screen,
    onData: () => () => undefined,
    resize: () => undefined,
  };
}

describe('RunnerSpace list mode', () => {
  it('says what to do when nothing is running', () => {
    const { rendered } = harness([]);
    expect(rendered()).toContain('No background runners');
  });

  it('uses the canonical list legend in full and compact chrome', () => {
    const view = harness([record()]);
    const full = view.rendered();
    view.setRows(5);
    const compact = view.rendered();

    for (const rendered of [full, compact]) {
      expect(rendered).toContain('↑↓');
      expect(rendered).not.toContain('↑↓/jk');
    }
  });

  it('marks the selected runner and moves with j and k', () => {
    const { component, rendered } = harness([record(), record({ name: 'web' })]);

    expect(
      rendered()
        .split('\n')
        .find((line) => line.includes('│ › ')),
    ).toContain('api');
    component.handleInput('j');
    expect(
      rendered()
        .split('\n')
        .find((line) => line.includes('│ › ')),
    ).toContain('web');
    component.handleInput('k');
    expect(
      rendered()
        .split('\n')
        .find((line) => line.includes('│ › ')),
    ).toContain('api');
  });

  it('does not move past either end of the list', () => {
    const { component, rendered } = harness([record()]);
    component.handleInput('k');
    component.handleInput('j');
    expect(
      rendered()
        .split('\n')
        .filter((line) => line.includes('│ › ')),
    ).toHaveLength(1);
  });

  it('stops the selected runner and reports it', async () => {
    const { component, rendered, stopped } = harness([record()]);

    component.handleInput('s');
    await Promise.resolve();
    await Promise.resolve();

    expect(stopped).toEqual(['api-id']);
    expect(rendered()).toContain('Stopped api');
  });

  it('colors successful and failed stop notices semantically', async () => {
    const markingTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const success = harness([record()], {}, {}, markingTheme);
    success.component.handleInput('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(success.rendered()).toContain('<success>Stopped api</success>');

    const failure = harness([record()], {}, {}, markingTheme, new Error('stop denied'));
    failure.component.handleInput('s');
    await Promise.resolve();
    await Promise.resolve();
    expect(failure.rendered()).toContain('<error>stop denied</error>');
  });

  it('closes on escape', () => {
    const { component, closed } = harness([record()]);
    component.handleInput('\x1b');
    expect(closed()).toBe(true);
  });

  it('opens captured stdout and stderr for a runner with no terminal', () => {
    const runner = record();
    const { component, rendered } = harness([runner], {}, { [runner.logPath]: 'building…\ncompiled successfully' });

    component.handleInput('\r');

    expect(rendered()).toContain('building…');
    expect(rendered()).toContain('compiled successfully');
    expect(rendered()).toContain('live stdout/stderr');
  });

  it('shows a waiting state until a runner writes output', () => {
    const { component, rendered } = harness([record()]);
    component.handleInput('\r');
    expect(rendered()).toContain('Waiting for output…');
  });

  it('returns from log output to the runner list on escape', () => {
    const { component, rendered } = harness([record()]);
    component.handleInput('\r');
    component.handleInput('\x1b');
    expect(rendered()).toMatch(/enter\s+open/);
  });

  it('shows the tty marker for interactive runners', () => {
    const { rendered } = harness([record({ interactive: true })]);
    expect(rendered()).toContain('[tty]');
  });
});

describe('RunnerSpace attach mode', () => {
  function attached(): Harness {
    const runner = record({ name: 'deploy', interactive: true });
    const result = harness([runner], { deploy: fakePtyRun('deploy', 'Continue? [y/N]') });
    result.component.handleInput('\r');
    return result;
  }

  it('renders the live screen and the detach hint', () => {
    const { rendered } = attached();
    expect(rendered()).toContain('Continue? [y/N]');
    expect(rendered()).toContain('esc back');
  });

  it('forwards every keystroke to the runner', () => {
    const runner = record({ name: 'deploy', interactive: true });
    const run = fakePtyRun('deploy', 'prompt');
    const { component } = harness([runner], { deploy: run });

    component.handleInput('\r');
    component.handleInput('y');
    component.handleInput('\r');

    expect(run.write).toHaveBeenCalledWith('y');
    expect(run.write).toHaveBeenCalledWith('\r');
  });

  it('returns to the list on escape without closing the overlay', () => {
    const { component, rendered, closed } = attached();

    component.handleInput('\x1b');

    expect(rendered()).toMatch(/enter\s+open/);
    expect(closed()).toBe(false);
  });
});
