/**
 * Where an enabled mode shows up, at both levels of detail.
 *
 * The editor's badge row answers "which modes are on" mid-typing; the leader
 * panel answers "and in what state" when it is opened deliberately. Both read
 * the same `DoomUiState`, so these tests also pin that the two cannot disagree.
 */

import type { KeybindingsManager as CodingKeybindingsManager } from '@earendil-works/pi-coding-agent';
import { type EditorTheme, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoomEditor } from '../../src/exports/components/doomEditor.ts';
import { LeaderHints } from '../../src/exports/components/leaderHints.ts';
import { DoomUiState, type UiMinorModeStatus } from '../../src/exports/uiState.ts';
import { createPlanLeaderRegistry } from '../helpers/leader.ts';

const PLAN: UiMinorModeStatus = {
  source: '@agimon-ai/doompi-plan',
  id: 'plan',
  label: 'PLAN',
  detail: 'normal - read only',
  color: 'warning',
  order: 40,
};
const WORKFLOW: UiMinorModeStatus = {
  source: '@agimon-ai/doompi-workflow',
  id: 'workflow',
  label: 'WORKFLOW',
  color: 'accent',
  order: 20,
};

function createEditor(
  uiState: DoomUiState,
  chromeTheme?: ConstructorParameters<typeof DoomEditor>[6],
): { editor: DoomEditor; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
  const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
  const editor = new DoomEditor(tui, theme, keybindings, uiState, () => undefined, undefined, chromeTheme, {
    registry: createPlanLeaderRegistry(),
  });
  return { editor, requestRender };
}

describe('mode names in the editor badge row', () => {
  it('prints nothing while no mode is on', () => {
    const uiState = new DoomUiState();
    const { editor } = createEditor(uiState);

    // An ordinary session pays no columns for a feature it is not using.
    expect(editor.render(80).join('\n')).not.toContain('plan');
  });

  it('prints every enabled mode by name, without its detail', () => {
    const uiState = new DoomUiState();
    const { editor } = createEditor(uiState);
    uiState.setModes([WORKFLOW, PLAN]);

    const rendered = editor.render(80).join('\n');

    expect(rendered).toContain('workflow · plan');
    // The detail belongs in the leader panel, where there is room to read it.
    expect(rendered).not.toContain('read only');
  });

  it('uses the major badge accent for every compact minor-mode label', () => {
    const uiState = new DoomUiState();
    const fg = vi.fn((_color: string, text: string) => text);
    const chromeTheme = {
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      fg,
      inverse: (text: string) => text,
    } as never;
    const { editor } = createEditor(uiState, chromeTheme);
    uiState.setModes([WORKFLOW, PLAN]);

    editor.render(80);

    expect(fg).toHaveBeenCalledWith('accent', ' COPILOT ');
    expect(fg).toHaveBeenCalledWith('accent', 'workflow');
    expect(fg).toHaveBeenCalledWith('accent', 'plan');
  });

  it('repaints when a mode toggles, without waiting for a keystroke', () => {
    const uiState = new DoomUiState();
    const { requestRender } = createEditor(uiState);
    requestRender.mockClear();

    uiState.setModes([PLAN]);

    expect(requestRender).toHaveBeenCalled();
  });

  it('drops the names again once the modes are cleared', () => {
    const uiState = new DoomUiState();
    const { editor } = createEditor(uiState);
    uiState.setModes([PLAN]);
    expect(editor.render(80).join('\n')).toContain('plan');

    uiState.reset();

    expect(editor.render(80).join('\n')).not.toContain('plan');
  });
});

describe('domain names in the editor badge row', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders configured domains after every enabled minor mode', () => {
    vi.stubEnv('DOOMPI_DOMAINS', ' development, qa ');
    const uiState = new DoomUiState();
    const { editor } = createEditor(uiState);
    uiState.setModes([WORKFLOW, PLAN]);

    const rendered = editor.render(120).join('\n');

    expect(rendered).toContain('workflow · plan  development, qa');
  });

  it('renders configured domains when no minor mode is enabled', () => {
    vi.stubEnv('DOOMPI_DOMAINS', 'development');
    const uiState = new DoomUiState();
    const { editor } = createEditor(uiState);

    const rendered = editor.render(100).join('\n');

    expect(rendered.indexOf('development')).toBeGreaterThan(rendered.indexOf('COPILOT'));
  });

  it('keeps multiple domains in metadata order and styles them as dim', () => {
    vi.stubEnv('DOOMPI_DOMAINS', 'development, qa, release');
    const uiState = new DoomUiState();
    const fg = vi.fn((_color: string, text: string) => text);
    const chromeTheme = {
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      fg,
      inverse: (text: string) => text,
    } as never;
    const { editor } = createEditor(uiState, chromeTheme);
    uiState.setModes([PLAN]);

    editor.render(120);

    expect(fg).toHaveBeenCalledWith('accent', 'plan');
    expect(fg).toHaveBeenCalledWith('dim', '  development, qa, release');
  });

  it('omits an empty domain segment without removing modes or status text', () => {
    vi.stubEnv('DOOMPI_DOMAINS', ' ,  ');
    const uiState = new DoomUiState();
    const fg = vi.fn((_color: string, text: string) => text);
    const chromeTheme = {
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      fg,
      inverse: (text: string) => text,
    } as never;
    const { editor } = createEditor(uiState, chromeTheme);
    uiState.setModes([PLAN]);

    const rendered = editor.render(100).join('\n');

    expect(rendered).toContain('plan');
    expect(rendered).toContain('draft 0');
    expect(fg).not.toHaveBeenCalledWith('dim', '  ');
  });
});

describe('mode detail in the leader panel', () => {
  const snapshot = { active: true, prefix: ['SPC'], label: 'leader', options: [{ key: 'p', label: 'plan' }] };
  const theme = {
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    inverse: (text: string) => text,
  } as never;

  it('shows each mode with its detail', () => {
    const hints = new LeaderHints(theme, snapshot, undefined, undefined, [WORKFLOW, PLAN]);

    const rendered = hints.render(100).join('\n');

    expect(rendered).toContain('MODES');
    expect(rendered).toContain('workflow');
    expect(rendered).toContain('plan (normal - read only)');
  });

  it('omits the row entirely when no mode is on', () => {
    const hints = new LeaderHints(theme, snapshot, undefined, undefined, []);

    expect(hints.render(100).join('\n')).not.toContain('MODES');
  });

  // The regression MODES caused when it arrived: diagnostics get whatever the
  // option grid leaves, and at a full grid that is one row per label. An extra
  // row here does not shrink the spacing, it drops EXTENSIONS off the end.
  it('does not evict SESSION or EXTENSIONS at a full option grid', () => {
    const fullGrid = {
      active: true,
      prefix: ['SPC'],
      label: 'leader',
      options: [
        { key: 'm', label: 'models' },
        { key: 'a', label: 'agents', detail: 'subagent runs' },
        { key: 'o', label: 'toggles' },
        { key: 's', label: 'sessions' },
        { key: 'y', label: 'copy' },
        { key: 'e', label: 'editor' },
        { key: 'w', label: 'workflows' },
        { key: 'l', label: 'loops' },
        { key: 'p', label: 'plan' },
        { key: 't', label: 'tasks' },
        { key: 'r', label: 'runners' },
        { key: 'v', label: 'voice' },
        { key: 'h', label: 'help' },
        { key: 'c', label: 'commands' },
        { key: 'q', label: 'quit' },
      ],
    };
    const context = {
      getContextUsage: () => ({ tokens: 0, contextWindow: 272000, percent: 0 }),
      sessionManager: { getBranch: () => [] },
    } as never;
    const footerData = {
      getGitBranch: () => 'main',
      getExtensionStatuses: () => new Map([['openai', 'OpenAI cache 548/553']]),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => () => undefined,
    } as never;

    const rendered = new LeaderHints(theme, fullGrid, context, footerData, [WORKFLOW, PLAN]).render(120).join('\n');

    expect(rendered).toContain('MODES');
    expect(rendered).toContain('SESSION');
    expect(rendered).toContain('EXTENSIONS');
  });
});
