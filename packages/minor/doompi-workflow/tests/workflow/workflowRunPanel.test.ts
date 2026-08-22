import type { Theme } from '@earendil-works/pi-coding-agent';
import type { DoomOverlayTui } from '@agimon-ai/doompi-ui/components/doomOverlay';
import { describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  runPanelUiOptions,
  WorkflowRunPanelComponent,
  type WorkflowRunPanelOptions,
} from '../../src/tui/workflow/workflowRunPanel';

const WIDTH = 80;
const KEY_ESC = '\x1b';
const UNFOLLOW = 'ctrl+alt+w';
const CLOSE = 'ctrl+alt+q';
const HINTS = [
  ['Esc Esc', 'close'],
  ['Ctrl+Alt+W', 'switch typing'],
  ['Ctrl+Alt+Q', 'close'],
] as const;

/** Pass-through theme so assertions read plain text, not colour codes. */
function createTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_colour: string, text: string) => text,
    bg: (_colour: string, text: string) => text,
    inverse: identity,
    bold: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

function createPanel(overrides: Partial<WorkflowRunPanelOptions> = {}, rows = 24) {
  const sent: string[] = [];
  const events: string[] = [];
  const tui: DoomOverlayTui = { terminal: { rows, columns: WIDTH }, requestRender: vi.fn() };
  const options: WorkflowRunPanelOptions = {
    runKey: 'auth-run',
    label: '▸ Deploy · agiflow/auth-run',
    breadcrumb: 'SPC › w / workflows › run',
    interactive: true,
    footer: 'Esc Esc closes this view · Ctrl+Alt+W switches typing · Ctrl+Alt+Q closes',
    hints: HINTS,
    snapshot: () => ({ progress: ['▸ verify', '    ▸ Claim the job'], output: ['line one', 'line two'] }),
    onUnfollow: () => events.push('unfollow'),
    onClose: () => events.push('close'),
    sendInput: (data) => sent.push(data),
    flushInput: () => events.push('flush'),
    unfollowShortcut: UNFOLLOW,
    closeShortcut: CLOSE,
    onDispose: () => events.push('dispose'),
    ...overrides,
  };
  const component = new WorkflowRunPanelComponent(tui, createTheme(), options);
  const render = (width = WIDTH): string[] => component.render(width);
  return { component, render, text: (width = WIDTH) => render(width).join('\n'), sent, events };
}

describe('WorkflowRunPanelComponent rendering', () => {
  // Rendered wide: the doom frame drops a right-hand cluster whole rather than
  // clipping it to a stub, so the narrow case says nothing about the content.
  it('frames the run with its label, breadcrumb and key legend', () => {
    const panel = createPanel();

    expect(panel.render()[0]).toContain('╭');
    expect(panel.text(160)).toContain('WORKFLOW RUN');
    expect(panel.text(160)).toContain('SPC › w / workflows › run');
    expect(panel.text(160)).toContain('Deploy · agiflow/auth-run');
    expect(panel.text(160)).toContain('typing goes to the run');
  });

  it('shows the job tree above the terminal tail', () => {
    const panel = createPanel();
    const text = panel.text();

    expect(text).toContain('▸ verify');
    expect(text).toContain('Claim the job');
    expect(text).toContain('OUTPUT · newest last');
    expect(text).toContain('line two');
  });

  it('says a view-only run is not typeable', () => {
    const panel = createPanel({ interactive: false, hints: [['Ctrl+Alt+Q', 'close']] });

    expect(panel.text(160)).toContain('view only');
    expect(panel.text(160)).toContain('typing stays here');
  });

  it('waits for output rather than drawing an empty tail', () => {
    const panel = createPanel({ snapshot: () => ({ progress: ['▸ verify'], output: [] }) });

    expect(panel.text()).toContain('Waiting for output…');
  });

  // The tree is what tells you which job is running; the tail is what is spare.
  it('gives the tree its rows first when the terminal is short', () => {
    const progress = Array.from({ length: 30 }, (_, index) => `job-${index}`);
    const panel = createPanel({ snapshot: () => ({ progress, output: ['tail'] }) }, 12);
    const text = panel.text();

    expect(text).toContain('job-0');
    expect(text).not.toContain('OUTPUT · newest last');
  });

  it('draws within the terminal at every size, keeping the legend on screen', () => {
    for (const rows of [8, 12, 24, 60]) {
      const panel = createPanel({}, rows);
      const lines = panel.render();

      expect(lines.length).toBeLessThanOrEqual(rows);
      // The frame's bottom border is last, so the legend sits above it.
      expect(lines.at(-2)).toContain('Esc Esc');
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('reports the output pane geometry so a launcher can size the run to it', () => {
    const viewports: Array<[number, number]> = [];
    const panel = createPanel({ onViewport: (columns, rows) => viewports.push([columns, rows]) }, 24);

    panel.render(100);

    const [columns, rows] = viewports.at(-1) ?? [];
    // Columns are the body width inside the frame, rows what is left after the
    // job tree and the output heading.
    expect(columns).toBeGreaterThan(0);
    expect(columns).toBeLessThan(100);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(24);
  });

  it('keeps a captured colour inside its own line', () => {
    const panel = createPanel({
      snapshot: () => ({ progress: ['▸ verify'], output: ['\x1b[38;2;255;0;0mbuild failed\x1b[0m'] }),
    });

    const row = panel.render(100).find((line) => line.includes('build failed')) ?? '';

    expect(row).toContain('\x1b[0m');
    expect(row.lastIndexOf('\x1b[0m')).toBeGreaterThan(row.indexOf('build failed'));
  });
});

describe('WorkflowRunPanelComponent input', () => {
  it('forwards ordinary keystrokes to the run', () => {
    const panel = createPanel();
    panel.component.handleInput('ls\r');

    expect(panel.sent).toEqual(['ls\r']);
    expect(panel.events).toEqual([]);
  });

  it('hands typing back on the unfollow chord without closing', () => {
    const panel = createPanel();
    panel.component.handleInput('\x1b[119;7u');

    expect(panel.events).toEqual(['unfollow']);
    expect(panel.sent).toEqual([]);
  });

  // The first Escape still reaches the run, so interrupting a step stays as fast
  // as it ever was; only the second one inside the window is consumed.
  it('closes on a quick double escape, flushing the first one to the run', () => {
    const panel = createPanel();
    panel.component.handleInput(KEY_ESC);
    expect(panel.sent).toEqual([KEY_ESC]);
    expect(panel.events).toEqual([]);

    panel.component.handleInput(KEY_ESC);
    expect(panel.events).toEqual(['flush', 'close']);
    expect(panel.sent).toEqual([KEY_ESC]);
  });

  it('tears down through the caller on dispose', () => {
    const panel = createPanel();
    panel.component.dispose();

    expect(panel.events).toEqual(['dispose']);
  });
});

describe('runPanelUiOptions', () => {
  // A panel whose keys cannot reach anything must never take them.
  it('leaves a view-only panel non-capturing and a typeable one focused', () => {
    const view = runPanelUiOptions(false).overlayOptions as Record<string, unknown>;
    const typeable = runPanelUiOptions(true).overlayOptions as Record<string, unknown>;

    expect(view.nonCapturing).toBe(true);
    expect(typeable.nonCapturing).toBeUndefined();
    expect(typeable.width).toBe('100%');
  });
});
