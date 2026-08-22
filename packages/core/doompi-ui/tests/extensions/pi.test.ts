import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import { requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type {
  KeybindingsManager as CodingKeybindingsManager,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {
  type EditorComponent,
  type EditorTheme,
  KeybindingsManager,
  type TUI,
  TUI_KEYBINDINGS,
} from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import doomPiUiExtension from '../../src/exports/extensions/pi.ts';
import type { UiTelemetry } from '../../src/exports/logSinkTelemetry.ts';

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

const DOOM_PI_THEME = 'doom-pi-dark';
const DOOM_PI_TITLE = 'doom-pi · agirepo · pi/coding';
const DOOM_PI_LEADER_WIDGET = 'doom-pi-leader';
const HEADLESS_MODES = ['print', 'json', 'rpc'] as const;

function createTelemetry(): UiTelemetry {
  return {
    recordError: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

class TestBus {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    const dispose = vi.fn(() => listeners.delete(listener));
    return dispose;
  }
}

function addHandler(handlers: Map<string, EventHandler>, event: string, handler: EventHandler): void {
  const previous = handlers.get(event);
  handlers.set(
    event,
    previous ? (payload, context) => Promise.all([previous(payload, context), handler(payload, context)]) : handler,
  );
}

async function registerExtension(
  telemetry: UiTelemetry = createTelemetry(),
  capturePi?: (pi: ExtensionAPI) => void,
): Promise<Map<string, EventHandler>> {
  const handlers = new Map<string, EventHandler>();
  const events = new TestBus();
  const pi = {
    events,
    getCommands: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      addHandler(handlers, event, handler);
    }),
  } as unknown as ExtensionAPI;
  capturePi?.(pi);
  await doomPiUiExtension(pi, telemetry);
  return handlers;
}

function createUi(themeResult: { success: boolean; error?: string } = { success: true }) {
  return {
    setTheme: vi.fn(() => themeResult),
    notify: vi.fn(),
    setTitle: vi.fn(),
    setHeader: vi.fn(),
    setFooter: vi.fn(),
    setEditorComponent: vi.fn(),
    setWidget: vi.fn(),
  };
}

describe('doomPiUiExtension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(HEADLESS_MODES)('does not access TUI primitives in %s mode', async (mode) => {
    const handlers = await registerExtension();
    const ui = createUi();
    const context = {
      mode,
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);
    await handlers.get('session_shutdown')?.({}, context);

    expect(ui.setTheme).not.toHaveBeenCalled();
    expect(ui.setHeader).not.toHaveBeenCalled();
    expect(ui.setFooter).not.toHaveBeenCalled();
    expect(ui.setEditorComponent).not.toHaveBeenCalled();
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
    expect(ui.setTitle).not.toHaveBeenCalled();
  });

  it('installs the theme, shell components, and transient leader widget', async () => {
    const handlers = await registerExtension();
    const ui = createUi();
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: ui as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);

    expect(ui.setTheme).toHaveBeenCalledWith(DOOM_PI_THEME);
    expect(ui.setTitle).toHaveBeenCalledWith(DOOM_PI_TITLE);
    expect(ui.setHeader).toHaveBeenCalledOnce();
    expect(ui.setFooter).toHaveBeenCalledOnce();
    expect(ui.setEditorComponent).toHaveBeenCalledOnce();

    const factory = ui.setEditorComponent.mock.calls[0]?.[0] as (
      tui: TUI,
      theme: EditorTheme,
      keybindings: CodingKeybindingsManager,
    ) => EditorComponent;
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
    const editorTheme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
    const editor = factory(tui, editorTheme, keybindings);

    editor.handleInput(' ');
    expect(ui.setWidget).toHaveBeenLastCalledWith(DOOM_PI_LEADER_WIDGET, expect.any(Function), {
      placement: 'belowEditor',
    });

    editor.handleInput('\x1b');
    expect(ui.setWidget).toHaveBeenLastCalledWith(DOOM_PI_LEADER_WIDGET, undefined, { placement: 'belowEditor' });

    // Not `LastCalledWith`: shutdown clears the mode line too, and which of the
    // two below-editor widgets is torn down last is not a promise worth making.
    await handlers.get('session_shutdown')?.({}, context);
    expect(ui.setWidget).toHaveBeenCalledWith(DOOM_PI_LEADER_WIDGET, undefined, {
      placement: 'belowEditor',
    });
  });

  it('accepts, updates, replaces, and rejects direct leader contributions', async () => {
    const telemetry = createTelemetry();
    let pi: ExtensionAPI | undefined;
    const handlers = await registerExtension(telemetry, (value) => {
      pi = value;
    });
    if (!pi) throw new Error('test Pi API was not captured');
    const connection = await connectDoomCordisHost(pi, '@example/ui-test');
    const hub = requireDoomUiHub(connection.root);
    const binding = (key: string, action: string): LeaderBinding => ({
      id: action,
      path: [{ key, label: action }],
      action: { name: action },
    });

    const first = hub.registerLeader({
      source: '@example/bootstrap',
      bindings: [binding('x', 'bootstrap.first')],
    });
    const replacement = hub.registerLeader({
      source: '@example/bootstrap',
      bindings: [binding('y', 'bootstrap.second')],
    });
    first.update([binding('z', 'bootstrap.stale')]);
    first.dispose();
    replacement.update([binding('w', 'bootstrap.updated')]);

    const invalid = hub.registerLeader({
      source: '@example/invalid',
      bindings: [binding('too-long', 'bootstrap.invalid')],
    });
    invalid.dispose();

    const context = {
      mode: 'print',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: createUi(),
    } as unknown as ExtensionContext;
    await handlers.get('session_start')?.({}, context);
    replacement.dispose();
    await handlers.get('session_shutdown')?.({}, context);
    await connection.dispose();

    expect(telemetry.recordWarning).toHaveBeenCalledWith(
      'doom_pi_ui.leader_contribution_rejected',
      expect.any(String),
      expect.objectContaining({ 'leader.source': '@example/invalid' }),
    );
  });

  it('sets the shell title from the first interactive user message only', async () => {
    const handlers = await registerExtension();
    const ui = createUi();
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: ui as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);
    await handlers.get('input')?.({ text: '  Fix the login\n  redirect behavior  ', source: 'interactive' }, context);
    await handlers.get('input')?.({ text: 'This must not replace the title', source: 'interactive' }, context);

    expect(ui.setTitle).toHaveBeenCalledTimes(2);
    expect(ui.setTitle).toHaveBeenLastCalledWith('doom-pi · Fix the login redirect behavior · agirepo');
  });

  it('does not replace the title when the session already has a message', async () => {
    const handlers = await registerExtension();
    const ui = createUi();
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [{ type: 'message' }], getSessionId: () => 'session-1' },
      ui: ui as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);
    await handlers.get('input')?.({ text: 'A later message', source: 'interactive' }, context);

    expect(ui.setTitle).toHaveBeenCalledOnce();
    expect(ui.setTitle).toHaveBeenCalledWith(DOOM_PI_TITLE);
  });

  it('warns when the configured theme cannot be applied', async () => {
    const telemetry = createTelemetry();
    const handlers = await registerExtension(telemetry);
    const ui = createUi({ success: false, error: 'missing' });
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: ui as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);

    expect(ui.notify).toHaveBeenCalledWith('Could not apply Doom Pi theme: missing', 'warning');
    expect(telemetry.recordWarning).toHaveBeenCalledWith('doom_pi_ui.theme_apply_failed', 'missing', {
      'ui.theme': DOOM_PI_THEME,
    });
  });

  // A print-mode run has no ctx.ui.notify to receive these, so the sink is the
  // only place the failure is recorded at all.
  it('reports shell installation and leader failures to the sink', async () => {
    const telemetry = createTelemetry();
    const handlers = await registerExtension(telemetry);
    const ui = createUi();
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: ui as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);

    expect(telemetry.recordEvent).toHaveBeenCalledWith('doom_pi_ui.shell_installed', {
      'ui.theme': DOOM_PI_THEME,
      'ui.theme.applied': true,
      'ui.leader.group.count': expect.any(Number),
    });

    const factory = ui.setEditorComponent.mock.calls[0]?.[0] as (
      tui: TUI,
      theme: EditorTheme,
      keybindings: CodingKeybindingsManager,
    ) => EditorComponent;
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
    const editorTheme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as CodingKeybindingsManager;
    const editor = factory(tui, editorTheme, keybindings);

    // SPC m m resolves to app.model.select, for which this bare editor has no
    // registered handler.
    editor.handleInput(' ');
    editor.handleInput('m');
    editor.handleInput('m');

    expect(telemetry.recordWarning).toHaveBeenCalledWith(
      'doom_pi_ui.leader_action_unavailable',
      'Leader action app.model.select is unavailable.',
      { 'ui.kind': 'action' },
    );
  });

  it('shuts down telemetry when the session ends', async () => {
    const telemetry = createTelemetry();
    const handlers = await registerExtension(telemetry);
    const context = {
      mode: 'tui',
      cwd: '/repo/agirepo',
      sessionManager: { getEntries: () => [], getSessionId: () => 'session-1' },
      ui: createUi() as unknown as ExtensionUIContext,
    } as unknown as ExtensionContext;

    await handlers.get('session_start')?.({}, context);
    await handlers.get('session_shutdown')?.({}, context);

    await vi.waitFor(() => expect(telemetry.shutdown).toHaveBeenCalledOnce());
  });
});
