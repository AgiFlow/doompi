import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkProvider,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import { SUBAGENT_ROOT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeCatalogService,
  type MinorModeOwnerDefinition,
  type MinorModeOwnerHandle,
  type MinorModeState,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  type NarrationRequest,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
  type DoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import {
  createEmbeddedWorkflowFeature,
  type EmbeddedWorkflowFeature,
  type Workflow,
  type WorkflowRunRecord,
} from '@agimon-ai/workflow-mcp';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compatibleRunners,
  createWorkflowPiExtension,
  panelHint,
  parseWorkflowCommandArguments,
  shortcutLabel,
} from '../../src/adapters/pi/workflow/piExtension';
import { registerWorkflowPiTools, WORKFLOW_PI_TOOL_NAMES } from '../../src/adapters/pi/workflow/piTools';

type CommandOptions = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type ShortcutOptions = { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void };
type OverlayComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
};
type MessageRenderer = (
  message: { content: unknown; details?: unknown },
  options: { outputPad: number },
  theme: Theme,
) => { render: (width: number) => string[] };
type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((result: { content: Array<{ text: string }> }) => void) | undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

const SESSION_ID = 'session-1';
const WORKFLOW_PACKAGE = '@agimon-ai/doompi-workflow';
/** A tool from another extension, so gating has something to preserve. */
const FOREIGN_TOOL = 'read';
/** The chords the extension registers, as the tests have to press them. */
const SHORTCUT_TOGGLE_VIEW = 'ctrl+alt+w';
const SHORTCUT_CLOSE_VIEW = 'ctrl+alt+q';
/** Widget keys the extension publishes under, asserted on by several tests. */
const WIDGET_KEY_FOLLOW = 'workflow-mcp-follow';
const WIDGET_KEY_PROGRESS = 'workflow-mcp-progress';
const WORKFLOW_SPINNER_PATTERN = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]';
/** Pi lifecycle events the harness drives directly. */
const EVENT_SESSION_START = 'session_start';
const EVENT_SESSION_SHUTDOWN = 'session_shutdown';
/** Custom message type carrying a finished run's summary. */
const MESSAGE_TYPE_RUN_FINISHED = 'workflow-run-finished';
const activeCordisRoots: Context[] = [];

/** Shaped like the repository's own templates: a launcher plus one real job. */
const delegatingWorkflowYaml = [
  'name: Auth',
  'launch-command: \'launcher --name "{name}" --command "{command}"\'',
  'jobs:',
  '  build:',
  '    steps:',
  '      - name: Build',
  '        run: echo built',
  '',
].join('\n');

function runRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    displayName: 'auth-run',
    dryRun: false,
    env: { PI_SESSION_ID: SESSION_ID },
    runId: '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
    runKey: 'auth-run',
    stage: 'error',
    startedAt: '2026-01-01T00:00:00.000Z',
    workflowPath: '/repo/automations/auth.workflow.yml',
    workspace: 'agiflow',
    ...overrides,
  };
}

function createHarness(
  records: WorkflowRunRecord[] = [],
  { monitorIntervalMs = 60_000, launchAckPollMs = 5, launchAckTimeoutMs = 300, provideSharedReadiness = true } = {},
) {
  vi.stubEnv(SUBAGENT_ROOT_SESSION_ENV, '');
  const commands = new Map<string, CommandOptions>();
  const handlers = new Map<string, EventHandler>();
  let sessionStarted = false;
  let readinessCoordinator: DoomReadinessCoordinator | undefined;
  const waitForWorkflowReadiness = async (previousGeneration?: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = readinessCoordinator?.read(WORKFLOW_PACKAGE);
      if (
        snapshot?.generation !== previousGeneration &&
        (snapshot?.state === 'ready' || snapshot?.state === 'degraded')
      ) {
        return;
      }
      if (snapshot?.state === 'failed' || snapshot?.state === 'cancelled') {
        throw new Error(snapshot.error?.message ?? `Workflow readiness ended as ${snapshot.state}.`);
      }
      await new Promise((settle) => setTimeout(settle, 0));
    }
    throw new Error('Workflow readiness did not settle.');
  };
  const tools = new Map<string, ToolDefinition>();
  const shortcuts = new Map<string, ShortcutOptions>();
  const messageRenderers = new Map<string, MessageRenderer>();
  const sendUserMessage = vi.fn();
  const sendMessage = vi.fn();
  const narrationDeliveries: Array<{ generation: string; text: string }> = [];
  const backgroundProviders = new Map<string, { provider: BackgroundWorkProvider; token: symbol }>();
  const backgroundWorkLifecycle: Array<{
    kind: 'registered' | 'updated' | 'unregistered';
    generation: string;
  }> = [];
  let nextBackgroundGeneration = 0;
  const backgroundWorkService: DoomBackgroundWorkService = {
    generation: 'workflow-background-service',
    register(provider) {
      const generation = `workflow-provider:${++nextBackgroundGeneration}`;
      const token = Symbol(provider.provider);
      backgroundProviders.set(provider.provider, { provider, token });
      backgroundWorkLifecycle.push({ kind: 'registered', generation });
      let disposed = false;
      return {
        provider: provider.provider,
        generation,
        update() {
          if (!disposed && backgroundProviders.get(provider.provider)?.token === token) {
            backgroundWorkLifecycle.push({ kind: 'updated', generation });
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          if (backgroundProviders.get(provider.provider)?.token !== token) return;
          backgroundProviders.delete(provider.provider);
          backgroundWorkLifecycle.push({ kind: 'unregistered', generation });
        },
      };
    },
    snapshot(sessionId) {
      const items = [...backgroundProviders.values()].flatMap(({ provider }) =>
        provider
          .listActiveWork()
          .filter((item) => sessionId === undefined || item.sessionId === sessionId)
          .map((item) => ({ provider: provider.provider, ...item })),
      );
      return { items, errors: [] };
    },
  };
  let leaderActions: Parameters<DoomUiHubService['registerLeaderActions']>[0] | undefined;
  const registerFooter = vi.fn();
  const uiHub = {
    registerConfig: vi.fn(),
    registerFooter,
    registerLeader: vi.fn(),
    registerLeaderActions(options: Parameters<DoomUiHubService['registerLeaderActions']>[0]) {
      leaderActions = options;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (leaderActions === options) leaderActions = undefined;
      };
    },
  } as unknown as DoomUiHubService;
  let activeMode:
    | {
        readonly definition: MinorModeOwnerDefinition<ExtensionContext>;
        readonly handle: MinorModeOwnerHandle;
        state: MinorModeState;
      }
    | undefined;
  let modePublicationCount = 0;
  const modeCatalog = {
    generation: 'workflow-mode-catalog',
    dispose: vi.fn(),
    getSnapshot: () => ({ hostGeneration: 'workflow-mode-catalog', revision: 0, modes: [] }),
    invoke: vi.fn(async () => {
      throw new Error('Mode invocation is not used by the Workflow Pi fixture.');
    }),
    list: () => [],
    registerOwner(definition: MinorModeOwnerDefinition<ExtensionContext>): MinorModeOwnerHandle {
      let state = structuredClone(definition.initialState);
      let disposed = false;
      const handle: MinorModeOwnerHandle = {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (activeMode?.handle === handle) activeMode = undefined;
        },
        getState: () => structuredClone(state),
        publish(next) {
          if (disposed) return;
          state = structuredClone(next);
          if (activeMode?.handle === handle) activeMode.state = structuredClone(next);
          modePublicationCount += 1;
        },
      };
      activeMode = { definition, handle, state: structuredClone(state) };
      return handle;
    },
    subscribe: () => () => undefined,
  } as unknown as MinorModeCatalogService;
  const exec = vi.fn().mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: '' });
  const runDir = mkdtempSync(resolve(tmpdir(), 'workflow-pi-'));
  let overlayComponent: OverlayComponent | undefined;
  /**
   * Every overlay this session opened, in order. A flow like manage opens
   * several in sequence, and indexing them is the only race-free way to drive
   * one: the next overlay often exists before the test asks for it.
   */
  const overlays: OverlayComponent[] = [];
  /** Terminal height the fake TUI reports; tests vary it to size the panel. */
  let terminalRows = 40;
  // Stands in for Pi's OverlayHandle so focus toggling can be asserted.
  const overlayHandle = {
    focused: true,
    hidden: false,
    focus() {
      this.focused = true;
    },
    unfocus() {
      this.focused = false;
    },
    isFocused() {
      return this.focused;
    },
    setHidden(value: boolean) {
      this.hidden = value;
    },
    isHidden() {
      return this.hidden;
    },
    hide() {
      this.hidden = true;
    },
  };
  // Pi auto-activates tools as they register, so the fake mirrors that.
  let activeTools: string[] = [FOREIGN_TOOL];
  const realFeature = createEmbeddedWorkflowFeature();
  const runTool = realFeature.runTool;
  const runToolExecute = vi
    .spyOn(runTool, 'execute')
    .mockResolvedValue({ content: [{ text: 'started', type: 'text' }], isError: false });
  // Stands in for the embedded engine. Shutdown interrupts it directly, so this
  // spy is what proves an in-flight inline run was finalized rather than left
  // behind as a `running` record with a dead pid.
  const runServiceInterrupt = vi.fn();
  const runService = { interrupt: runServiceInterrupt } as unknown as EmbeddedWorkflowFeature['runService'];
  const pi = {
    exec,
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
    on: vi.fn((event: string, handler: EventHandler) => {
      const previous = handlers.get(event);
      handlers.set(
        event,
        previous
          ? async (eventValue, context) => {
              await previous(eventValue, context);
              return handler(eventValue, context);
            }
          : handler,
      );
    }),
    registerCommand: vi.fn((name: string, options: CommandOptions) => commands.set(name, options)),
    registerShortcut: vi.fn((shortcut: string, options: ShortcutOptions) => shortcuts.set(shortcut, options)),
    registerMessageRenderer: vi.fn((customType: string, renderer: MessageRenderer) =>
      messageRenderers.set(customType, renderer),
    ),
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    }),
    sendMessage,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const listRunsPage = vi.fn(async (input?: { filter?: (record: WorkflowRunRecord) => boolean }) => {
    const items = input?.filter ? records.filter(input.filter) : records;
    return {
      hasNextPage: false,
      hasPreviousPage: false,
      items,
      page: 1,
      pageSize: 100,
      total: items.length,
      totalPages: items.length ? 1 : 0,
    };
  });
  const claimRunRecovery = vi.fn().mockResolvedValue({
    claimId: 'claim-1',
    claimedAt: '2026-01-01T00:00:00.000Z',
    ownerSessionId: SESSION_ID,
    pid: process.pid,
  });
  const releaseRunRecoveryClaim = vi.fn().mockResolvedValue(undefined);
  const requestPause = vi.fn().mockResolvedValue({ action: 'pause', requestedAt: '2026-01-01T00:00:00.000Z' });
  const requestResume = vi.fn().mockResolvedValue({ action: 'resume', requestedAt: '2026-01-01T00:00:00.000Z' });
  const requestStop = vi.fn().mockResolvedValue({ requestedAt: '2026-01-01T00:00:00.000Z' });
  const listRuns = vi.fn(async () => records);
  const registry = {
    // Honours `filter` the way the real service does, so a test can prove the
    // session scope reaches the registry rather than only the tool.
    listRunsPage,
    // What the run observer reads. Separate from `listRunsPage` so a test can
    // tell a poll apart from a sweep.
    claimRunRecovery,
    listRuns,
    releaseRunRecoveryClaim,
    requestPause,
    requestResume,
    requestStop,
    resolveWorkspace: (workspace?: string) => workspace ?? 'default',
    // Real directory: the extension reads progress.ndjson off disk, so a stub
    // path would exercise nothing.
    runDirectoryFor: () => runDir,
    // A real path, so the observer's watch attaches instead of silently
    // falling back to its interval and making every test depend on timing.
    workspacesDirectory: () => runDir,
  } as unknown as EmbeddedWorkflowFeature['registry'];
  const recoverTool = realFeature.createRecoverTool();
  const recoverToolExecute = vi
    .spyOn(recoverTool, 'execute')
    .mockResolvedValue({ content: [{ text: 'recovered', type: 'text' }], isError: false });
  const harnessFeature = createEmbeddedWorkflowFeature({ registry, runService });
  // Stands in for the detached launcher spawn, so a delegated recovery can be
  // asserted on its command rather than by starting a terminal.
  const spawnDetached = vi.fn().mockResolvedValue(undefined);
  const cordis = new Context();
  cordis.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWorkService);
  cordis.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, modeCatalog);
  cordis.provide(DOOM_UI_HUB_SERVICE, uiHub);
  let narrationProvider: { dispose(): Promise<void> } | undefined;
  const provideNarration = async (generation: string): Promise<void> => {
    const service: DoomNarrationService = {
      generation,
      request(request: NarrationRequest) {
        narrationDeliveries.push({ generation, text: request.text });
      },
    };
    const provider = cordis.plugin((context) => context.provide(DOOM_NARRATION_SERVICE, service));
    narrationProvider = provider;
    await provider;
  };
  const initialNarrationProvider = cordis.plugin((context) =>
    context.provide(DOOM_NARRATION_SERVICE, {
      generation: 'workflow-narration-initial',
      request(request) {
        narrationDeliveries.push({ generation: 'workflow-narration-initial', text: request.text });
      },
    }),
  );
  narrationProvider = initialNarrationProvider;
  if (provideSharedReadiness) {
    const coordinator = createDoomReadinessCoordinator();
    readinessCoordinator = coordinator;
    cordis.provide(DOOM_READINESS_SERVICE, coordinator);
    cordis.effect(() => () => coordinator.dispose(), `${WORKFLOW_PACKAGE}/test-readiness`);
  }
  activeCordisRoots.push(cordis);
  createWorkflowPiExtension({
    cordis,
    monitorIntervalMs,
    launchAckPollMs,
    launchAckTimeoutMs,
    spawnDetached,
    featureFactory: () =>
      ({
        ...harnessFeature,
        recoverService: runService,
        registry,
        runService,
        runTool,
        createRecoverTool: () => recoverTool,
      }) as EmbeddedWorkflowFeature,
  })(pi);

  const ui = {
    confirm: vi.fn().mockResolvedValue(true),
    editor: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    // Drives the overlay the way Pi does: build the component, hold it for the
    // test to type into, and resolve when it calls done().
    custom: vi.fn(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (selection?: unknown) => void,
        ) => OverlayComponent,
        options?: { onHandle?: (handle: unknown) => void },
      ) =>
        new Promise<unknown>((resolveOverlay) => {
          overlayComponent = factory(
            // `terminal` is real on Pi's TUI and the panel sizes itself from
            // its rows, so the fake has to carry it or render throws.
            { requestRender: () => {}, terminal: { columns: 100, rows: terminalRows } },
            {
              bg: (_colour: string, text: string) => text,
              bold: (text: string) => text,
              fg: (_colour: string, text: string) => text,
              inverse: (text: string) => text,
            },
            {},
            (selection: unknown) => resolveOverlay(selection),
          );
          overlays.push(overlayComponent);
          options?.onHandle?.(overlayHandle);
        }),
    ),
    // Identity theme so widget assertions read as plain text.
    theme: {
      bg: (_colour: string, text: string) => text,
      bold: (text: string) => text,
      fg: (_colour: string, text: string) => text,
      inverse: (text: string) => text,
    },
  };
  const ctx = {
    cwd: '/repo',
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => SESSION_ID },
    ui,
  } as unknown as ExtensionCommandContext;
  const rawSessionStart = handlers.get(EVENT_SESSION_START);
  if (rawSessionStart) {
    handlers.set(EVENT_SESSION_START, async (event, context) => {
      await initialNarrationProvider;
      const previousGeneration = readinessCoordinator?.read(WORKFLOW_PACKAGE)?.generation;
      sessionStarted = true;
      await rawSessionStart(event, context);
      if (readinessCoordinator) await waitForWorkflowReadiness(previousGeneration);
    });
  }

  /**
   * Drive a widget factory the way the TUI does: build it with a theme, then
   * render at a width. The fake theme is identity so assertions read as plain
   * text; colour correctness is covered by the focused renderer tests.
   */
  const renderWidgetCall = (call: unknown[] | undefined, width: number): string[] => {
    const factory = call?.[1] as
      | ((tui: { requestRender: () => void }, theme: unknown) => { render: (w: number) => string[] })
      | undefined;
    if (typeof factory !== 'function') return [];
    const theme = { fg: (_color: string, text: string) => text };
    return factory({ requestRender: () => {} }, theme).render(width);
  };
  const renderWidget = (width = 80): string[] => renderWidgetCall(ui.setWidget.mock.calls.at(-1), width);
  const renderProgressWidget = (width = 80): string[] => {
    const call = ui.setWidget.mock.calls.findLast(
      (entry) => entry[0] === WIDGET_KEY_PROGRESS && typeof entry[1] === 'function',
    );
    return renderWidgetCall(call, width);
  };

  /** Flip the mode through the action handler owned by the injected UI hub. */
  const toggle = async (state: 'on' | 'off'): Promise<void> => {
    const action = state === 'on' ? 'workflow.enable' : 'workflow.disable';
    const handler = leaderActions?.handlers[action];
    if (!handler) throw new Error(`Workflow leader action '${action}' is unavailable.`);
    await handler(ctx);
  };
  const callTool = async (
    name: string,
    params: unknown,
    ctxOverrides: Record<string, unknown> = {},
    onUpdate?: (result: { content: Array<{ text: string }> }) => void,
  ) => {
    if (!sessionStarted && !readinessCoordinator?.read(WORKFLOW_PACKAGE)) {
      await handlers.get(EVENT_SESSION_START)?.({}, ctx);
    }
    const legacyActions: Record<string, string> = {
      follow_workflow: 'follow',
      tail_workflow: 'tail',
      open_workflow: 'open',
      stop_workflow: 'stop',
      recover_workflow: 'recover',
    };
    const action = legacyActions[name];
    const toolName = action ? 'workflow_run' : name;
    const toolParams = action ? { action, ...(params as Record<string, unknown>) } : params;
    return tools.get(toolName)?.execute('call-1', toolParams, undefined, onUpdate, {
      ...ctx,
      hasUI: true,
      ...ctxOverrides,
    } as never);
  };

  return {
    activeTools: () => [...activeTools],
    invokeLeaderAction: async (action: string): Promise<void> => {
      const handler = leaderActions?.handlers[action];
      if (!handler) throw new Error(`Workflow leader action '${action}' is unavailable.`);
      await handler(ctx);
    },
    invokeModeAction: async (action: string): Promise<void> => {
      const definition = activeMode?.definition;
      if (!definition) throw new Error('Workflow minor mode is unavailable.');
      await definition.handleAction(
        action,
        {},
        {
          context: ctx,
          operationId: `workflow-mode-${action}`,
          sessionKind: 'tui',
          signal: new AbortController().signal,
        },
      );
    },
    latestModeItem: (): { label?: string; detail?: string } | undefined => {
      const mode = activeMode;
      if (!mode || mode.state.activation !== 'active') return undefined;
      return { label: mode.definition.descriptor.label, detail: mode.state.detail };
    },
    /** Lifecycle speech requested through the active Voice-owned Cordis service. */
    narrations: (): string[] => narrationDeliveries.map(({ text }) => text),
    narrationDeliveries: () => [...narrationDeliveries],
    provideNarration,
    removeNarration: async (): Promise<void> => {
      const provider = narrationProvider;
      narrationProvider = undefined;
      await provider?.dispose();
    },
    /** How many times the label has been reasserted, for the churn guard. */
    modePublications: (): number => modePublicationCount,
    backgroundWorkLifecycle: () => [...backgroundWorkLifecycle],
    backgroundWorkSnapshot: () => backgroundWorkService.snapshot(SESSION_ID),
    footerRegistrations: () => registerFooter.mock.calls.length,
    /** Seed the run's progress log the way a live runner would append it. */
    writeProgress: (events: unknown[]) => {
      mkdirSync(runDir, { recursive: true });
      // Newline-terminated, exactly as the recorder writes it. An unterminated
      // final line is the torn-write case a tailing reader must hold back, so a
      // fixture missing it would silently drop its own last event.
      writeFileSync(resolve(runDir, 'progress.ndjson'), events.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    },
    callTool,
    commands,
    ctx,
    exec,
    handlers,
    messageRenderers,
    listRuns,
    listRunsPage,
    pi,
    rawSessionStart,
    readinessCoordinator,
    registry,
    overlay: () => overlayComponent,
    overlayHandle: () => overlayHandle,
    /** Resize the fake terminal before opening a panel. */
    setTerminalRows: (rows: number) => {
      terminalRows = rows;
    },
    /** The overlay is built inside an async tool call, so wait for it. */
    waitForOverlay: async (): Promise<OverlayComponent> => {
      for (let attempt = 0; attempt < 100 && !overlayComponent; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 5));
      }
      if (!overlayComponent) throw new Error('Overlay was never opened.');
      return overlayComponent;
    },
    /** The nth overlay this session opened, waiting for it to exist. */
    overlayAt: async (index: number): Promise<OverlayComponent> => {
      for (let attempt = 0; attempt < 400 && overlays.length <= index; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 5));
      }
      const overlay = overlays[index];
      if (!overlay) throw new Error(`Overlay ${index} was never opened; ${overlays.length} were.`);
      return overlay;
    },
    renderProgressWidget,
    renderWidget,
    recoverToolExecute,
    spawnDetached,
    claimRunRecovery,
    releaseRunRecoveryClaim,
    requestPause,
    requestResume,
    requestStop,
    runServiceInterrupt,
    runToolExecute,
    sendMessage,
    sendUserMessage,
    shortcuts,
    toggle,
    tools,
    feature: harnessFeature,
    ui,
    waitForWorkflowReadiness,
  };
}

/**
 * Change what the registry reports, the way a run advancing on disk would.
 *
 * The extension holds the registry object the harness built, so replacing what
 * the mocks resolve is enough to move a run between stages mid-test. Both read
 * paths are set together: the tools page the registry, the run observer lists
 * it, and a test that moved only one would have them disagree about reality.
 */
function listRuns(
  harness: { listRuns: ReturnType<typeof vi.fn>; listRunsPage: ReturnType<typeof vi.fn> },
  items: WorkflowRunRecord[],
): void {
  harness.listRuns.mockResolvedValue(items);
  harness.listRunsPage.mockResolvedValue({
    hasNextPage: false,
    hasPreviousPage: false,
    items,
    page: 1,
    pageSize: 100,
    total: items.length,
    totalPages: items.length ? 1 : 0,
  });
}

/**
 * Wait until the monitor has polled the registry a few more times.
 *
 * What makes a "nothing happened" assertion meaningful: without it the test
 * would pass simply by running before the first tick.
 */
async function pollsSettle(harness: { listRunsPage: ReturnType<typeof vi.fn> }, ticks = 3): Promise<void> {
  const mock = harness.listRunsPage;
  const target = mock.mock.calls.length + ticks;
  await vi.waitFor(() => expect(mock.mock.calls.length).toBeGreaterThanOrEqual(target));
}

// Pinned per platform explicitly, because everything else asserts the label by
// calling this function: without these the integration tests would agree with
// whatever it happened to produce.
describe('shortcutLabel', () => {
  it('writes modifiers as the glyphs a macOS keyboard actually shows', () => {
    expect(shortcutLabel(SHORTCUT_TOGGLE_VIEW, 'darwin')).toBe('⌃⌥W');
    expect(shortcutLabel(SHORTCUT_CLOSE_VIEW, 'darwin')).toBe('⌃⌥Q');
    expect(shortcutLabel('shift+enter', 'darwin')).toBe('⇧ENTER');
  });

  it('spells modifiers out everywhere else', () => {
    expect(shortcutLabel(SHORTCUT_TOGGLE_VIEW, 'linux')).toBe('Ctrl+Alt+W');
    expect(shortcutLabel(SHORTCUT_CLOSE_VIEW, 'win32')).toBe('Ctrl+Alt+Q');
  });

  // A macOS user told to press "alt" has to work out that it means Option, a
  // key most Apple keyboards do not label "alt" at all.
  it('never shows a mac user the word alt', () => {
    expect(shortcutLabel(SHORTCUT_TOGGLE_VIEW, 'darwin')).not.toContain('alt');
    expect(shortcutLabel(SHORTCUT_TOGGLE_VIEW, 'darwin')).not.toContain('Alt');
  });

  // Only the label is platform-specific. What Pi registers must stay canonical
  // on every platform, which the harness proves by looking the handler up by
  // its literal binding.
  it('changes the label without changing the binding', () => {
    expect(shortcutLabel(SHORTCUT_TOGGLE_VIEW, 'darwin')).not.toBe(SHORTCUT_TOGGLE_VIEW);
    expect(createHarness([]).shortcuts.has(SHORTCUT_TOGGLE_VIEW)).toBe(true);
    expect(createHarness([]).shortcuts.has(SHORTCUT_CLOSE_VIEW)).toBe(true);
  });
});

describe('panelHint', () => {
  // The footer is the only exit instruction on screen once the notice has
  // scrolled away, so the failsafe has to be in it, not just in the docs.
  it('leads with the exit that works on every terminal', () => {
    const hint = panelHint(true, 'darwin');

    expect(hint.indexOf('Esc Esc')).toBe(0);
    expect(hint).toContain('⌃⌥W');
    expect(hint).toContain('⌃⌥Q');
  });

  // A run with no terminal behind it must not advertise typing controls, or
  // the user spends the next minute wondering why nothing responds.
  it('says a view-only panel takes no typing', () => {
    const hint = panelHint(false, 'darwin');

    expect(hint).toContain('view only');
    expect(hint).toContain('⌃⌥Q');
    expect(hint).not.toContain('⌃⌥W');
    expect(hint).not.toContain('Esc Esc');
  });

  it('spells the chords out away from macOS', () => {
    expect(panelHint(true, 'linux')).toContain('Ctrl+Alt+W');
  });
});

/**
 * Drive a doom choice overlay by label: step the cursor onto the option, then
 * commit. Index-based navigation would silently break the moment the manager
 * adds or removes an action.
 */
async function chooseInOverlay(overlay: OverlayComponent, label: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = overlay.render(100).find((line) => line.includes('›') && !line.includes('SPC ›'));
    if (current?.includes(label)) break;
    overlay.handleInput?.('\x1b[B');
  }
  overlay.handleInput?.('\r');
  await new Promise((settle) => setTimeout(settle, 0));
}

describe('workflow-mcp Pi extension', () => {
  it('uses feature defaults and rejects unavailable launcher views', async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;

    registerWorkflowPiTools(pi, { feature: createHarness().feature });

    expect([...tools.keys()]).toEqual([...WORKFLOW_PI_TOOL_NAMES]);
    for (const action of ['follow', 'tail', 'open']) {
      await expect(
        tools.get('workflow_run')?.execute('call', { action, runKey: 'run' }, undefined, undefined, {
          sessionManager: { getSessionId: () => SESSION_ID },
        }),
      ).rejects.toThrow('not available in this session');
    }
  });

  it('keeps raw tail dependency output out of the agent-visible result', async () => {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    const record = runRecord({ stage: 'running' });
    const tailRun = vi.fn().mockResolvedValue('raw PTY frame from dependency');

    registerWorkflowPiTools(pi, {
      feature: createEmbeddedWorkflowFeature(),
      requireSessionRun: vi.fn().mockResolvedValue(record),
      tailRun,
    });

    const result = await tools
      .get('workflow_run')
      ?.execute('call', { action: 'tail', runKey: record.runKey }, undefined, undefined, {
        sessionManager: { getSessionId: () => SESSION_ID },
      } as ExtensionContext);

    expect(tailRun).toHaveBeenCalled();
    expect(result?.content[0].text).toContain('Raw launcher output is hidden from chat');
    expect(result?.content[0].text).not.toContain('raw PTY frame from dependency');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(SUBAGENT_ROOT_SESSION_ENV, '');
  });

  afterEach(async () => {
    await Promise.allSettled(activeCordisRoots.splice(0).map((root) => root.fiber.dispose()));
    vi.unstubAllEnvs();
  });

  it('computes runners supported by every mapped workflow step', () => {
    const workflow = {
      jobs: {
        development: {
          steps: [
            { interactiveRun: { claude: 'claude', codex: 'codex', pi: 'pi' } },
            { interactiveRun: { codex: 'codex', pi: 'pi' } },
          ],
        },
      },
      name: 'Development',
    } as Workflow;

    expect(compatibleRunners(workflow)).toEqual(['codex', 'pi']);
  });

  it('parses deterministic launch options', () => {
    expect(
      parseWorkflowCommandArguments('dev-full --runner pi --launcher tmux --workspace agiflow --name "Auth work"'),
    ).toEqual({
      launcher: 'tmux',
      name: 'Auth work',
      positionals: ['dev-full'],
      runner: 'pi',
      workspace: 'agiflow',
    });
  });

  // The whole point of the redesign: one palette entry, not eight. The launch
  // verb is that one, and it earns its place by being the only way a cockpit
  // can start a workflow: a browser can send a session a prompt frame and
  // nothing else. If this list grows again, the namespace cost has regressed.
  it('registers the launch command and nothing else', () => {
    expect([...createHarness().commands.keys()]).toEqual(['workflow-launch']);
  });

  it('registers every gated tool name it claims to gate', () => {
    expect([...createHarness().tools.keys()].sort()).toEqual([...WORKFLOW_PI_TOOL_NAMES].sort());
  });

  // The tools carry their own context. Nothing is injected into the system
  // prompt, so if a rule is not on a tool the agent never sees it.
  it('carries the operating rules on the tools themselves', () => {
    const tools = createHarness().tools as unknown as Map<string, { promptGuidelines?: string[] }>;
    const guidelines = (name: string) => (tools.get(name)?.promptGuidelines ?? []).join('\n');

    expect(guidelines('launch_workflow')).toContain('AGIFLOW_JOB_KIND and AGIFLOW_JOB_ID together');
    expect(guidelines('launch_workflow')).toContain('a non-empty prompt');
    expect(guidelines('launch_workflow')).toContain('STARTED, not when it has finished');
    expect(guidelines('launch_workflow')).toContain('409');
    expect(guidelines('workflow_run')).toContain('started is not a run that succeeded');
    // Recovery points at the skill this package ships, and keeps the two
    // constraints that must hold even if that skill is never read.
    const recover = guidelines('workflow_run');
    expect(recover).toContain('`workflow-recovery` skill');
    expect(recover).toContain('Never edit issue.md or repair.json');
    expect(recover).toContain('verify real process and registry progress');
  });

  it('injects nothing into the system prompt', () => {
    expect(createHarness().handlers.has('before_agent_start')).toBe(false);
  });

  // The package ships this skill itself rather than assuming the host
  // repository supplies one, but the dormant battery mode must stay neutral.
  it('discovers workflow-recovery only while Workflow mode is active', async () => {
    const harness = createHarness();
    const discover = async (): Promise<string[]> => {
      const result = (await harness.handlers.get('resources_discover')?.({}, harness.ctx)) as {
        skillPaths: string[];
      };
      return result.skillPaths;
    };

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    expect(await discover()).toEqual([]);

    await harness.toggle('on');
    const skillPaths = await discover();
    expect(skillPaths).toHaveLength(1);
    expect(skillPaths[0]).toMatch(/[/\\]skills$/);
    const skill = readFileSync(resolve(skillPaths[0]!, 'workflow-recovery/SKILL.md'), 'utf8');
    expect(skill).toContain('name: workflow-recovery');
    expect(skill).toContain('description:');
    expect(skill).toContain('not** a relaunch');
    expect(skill).toContain('Never edit `issue.md` or `repair.json`');

    await harness.toggle('off');
    expect(await discover()).toEqual([]);
    await harness.handlers.get('session_shutdown')?.({}, harness.ctx);
  });

  it('leaves workflow tools inactive until the mode is turned on', async () => {
    const harness = createHarness();

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    for (const name of WORKFLOW_PI_TOOL_NAMES) expect(harness.activeTools()).not.toContain(name);
    expect(harness.activeTools()).toContain(FOREIGN_TOOL);
  });

  it('activates workflow tools on and strips them off, preserving other extensions', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await harness.toggle('on');
    for (const name of WORKFLOW_PI_TOOL_NAMES) expect(harness.activeTools()).toContain(name);
    expect(harness.activeTools()).toContain(FOREIGN_TOOL);

    await harness.toggle('off');
    // The foreign tool surviving is the regression guard: setActiveTools is a
    // whole-list setter, so a bare literal here would silently disable it.
    expect(harness.activeTools()).toEqual([FOREIGN_TOOL]);
  });

  // Two actions behind one key: `SPC w e` enters the mode and, once it is on,
  // the same key is republished as the way out.
  it('enables and disables from separate leader actions', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await harness.toggle('on');
    expect(harness.activeTools()).toContain('launch_workflow');

    await harness.toggle('on');
    expect(harness.activeTools()).toContain('launch_workflow');

    await harness.toggle('off');
    expect(harness.activeTools()).not.toContain('launch_workflow');
  });

  it('honours WORKFLOW_MCP_MODE=on so non-interactive dispatch keeps its launch tool', async () => {
    vi.stubEnv('WORKFLOW_MCP_MODE', 'on');
    try {
      const harness = createHarness();
      await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
      expect(harness.activeTools()).toContain('launch_workflow');
      expect(await harness.handlers.get('resources_discover')?.({}, harness.ctx)).toMatchObject({
        skillPaths: [expect.stringMatching(/[/\\]skills$/)],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // `/workflow status` is gone: the mode display answers it at a glance. What
  // still has to hold is that each toggle explains the state it just entered.
  it('explains the state it has just entered', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await harness.toggle('on');
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Workflow mode on'), 'info');

    await harness.toggle('off');
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Workflow mode off'), 'info');
  });

  // The mode line owns the enabled state; the live list owns running work. The
  // extension therefore has no reason to claim Pi's shared status/footer row.
  it('keeps the shared status row unclaimed while workflow mode is on', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await harness.toggle('on');

    expect(harness.ui.setStatus).not.toHaveBeenCalled();
    expect(harness.latestModeItem()).toMatchObject({ label: 'Workflow' });
  });

  // Contributed rather than painted: doom-pi-ui shows the name beside the
  // editor's badge and the detail in the leader panel, so this extension owns
  // the label and not where it lands.
  it('contributes its mode label while the mode is on', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    expect(harness.latestModeItem()).toBeUndefined();

    await harness.toggle('on');
    expect(harness.latestModeItem()).toMatchObject({ label: 'Workflow' });

    await harness.toggle('off');
    expect(harness.latestModeItem()).toBeUndefined();
  });

  // Every republish repaints the shared surfaces for every other mode too, so a
  // label reasserted on each monitor tick would churn the TUI for nothing.
  it('leaves the label alone while the mode is unchanged', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })], { monitorIntervalMs: 5 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    await harness.toggle('on');
    const published = harness.modePublications();

    await pollsSettle(harness);

    expect(harness.modePublications()).toBe(published);
  });

  it('takes the label off when the session ends', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    await harness.toggle('on');

    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx);

    expect(harness.latestModeItem()).toBeUndefined();
  });

  it('does not contribute running workflows to the doom footer', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.footerRegistrations()).toBe(0);
    expect(harness.ui.setStatus).not.toHaveBeenCalled();
  });

  it('shows running work in the live list regardless of workflow mode', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);
    harness.writeProgress([{ type: 'job', status: 'running', job: 'plan', index: 0, total: 2, at: 't1' }]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.renderProgressWidget().join('\n')).toMatch(
      new RegExp(`\\[plan\\] ${WORKFLOW_SPINNER_PATTERN} Starting workflow`),
    );
  });

  it('uses a starting fallback before a run emits its first progress event', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.renderProgressWidget().join('\n')).toMatch(
      new RegExp(`auth-run\\[[^\\]]+\\]\\[workflow\\] ${WORKFLOW_SPINNER_PATTERN} Starting workflow`),
    );
  });

  it('registers workflow runs through the injected background-work service', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    expect(harness.backgroundWorkSnapshot()).toMatchObject({
      items: [
        {
          provider: 'workflow-mcp',
          id: '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
          sessionId: SESSION_ID,
        },
      ],
      errors: [],
    });

    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx);
    expect(harness.backgroundWorkSnapshot()).toEqual({ items: [], errors: [] });
  });

  it('keeps one provider generation and refreshes its snapshot when the session restarts', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const lifecycle = harness.backgroundWorkLifecycle();
    const registered = lifecycle.filter(({ kind }) => kind === 'registered');
    const retired = lifecycle.filter(({ kind }) => kind === 'unregistered');
    expect(registered).toHaveLength(1);
    expect(retired).toHaveLength(0);
    expect(lifecycle.filter(({ kind }) => kind === 'updated').length).toBeGreaterThanOrEqual(2);
    expect(harness.backgroundWorkSnapshot().items).toHaveLength(1);
  });

  it('returns from session_start while initialization continues and makes the first dependent tool wait', async () => {
    const record = runRecord({ stage: 'running' });
    const harness = createHarness([record]);
    let releaseRegistryRead = (_records: WorkflowRunRecord[]): void => undefined;
    harness.listRuns.mockReturnValueOnce(
      new Promise<WorkflowRunRecord[]>((resolveRead) => {
        releaseRegistryRead = resolveRead;
      }),
    );

    await harness.rawSessionStart?.({}, harness.ctx);

    expect(harness.readinessCoordinator?.read(WORKFLOW_PACKAGE)?.state).toBe('pending');
    let toolSettled = false;
    const toolCall = harness.callTool('tail_workflow', { runKey: record.runKey }).then((result) => {
      toolSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(toolSettled).toBe(false);

    releaseRegistryRead([record]);
    await expect(toolCall).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('Raw launcher output is hidden from chat') })],
    });
    expect(harness.readinessCoordinator?.read(WORKFLOW_PACKAGE)?.state).toBe('ready');
    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx);
  });

  it('owns readiness locally when installed into standalone Pi without a Doom session root', async () => {
    const record = runRecord({ stage: 'running' });
    const harness = createHarness([record], { provideSharedReadiness: false });

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    await expect(harness.callTool('tail_workflow', { runKey: record.runKey })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('Raw launcher output is hidden from chat') })],
    });
    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx);
  });

  it('turns the mode on through the injected minor-mode catalog', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    expect(harness.activeTools()).not.toContain('launch_workflow');

    await harness.invokeModeAction('activate');

    expect(harness.activeTools()).toContain('launch_workflow');
    expect(harness.latestModeItem()).toMatchObject({ label: 'Workflow' });
  });

  it('rejects unknown minor-mode actions', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await expect(harness.invokeModeAction('invalid')).rejects.toThrow('Unknown workflow mode action: invalid');

    expect(harness.activeTools()).not.toContain('launch_workflow');
  });

  it('launches through the tool, stamped with the session', async () => {
    const harness = createHarness();
    const onUpdate = vi.fn();

    const result = await harness.callTool(
      'launch_workflow',
      {
        workflowPath: '/repo/automations/workflows/dev-full.workflow.yml',
        workspace: 'agiflow',
      },
      {},
      onUpdate,
    );

    expect(harness.runToolExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ PI_SESSION_ID: SESSION_ID }),
        workflowPath: '/repo/automations/workflows/dev-full.workflow.yml',
        workspace: 'agiflow',
      }),
    );
    expect(onUpdate.mock.calls.map((call) => call[0].content[0]?.text)).toEqual([
      'Checking workflow capacity...',
      'Launching workflow /repo/automations/workflows/dev-full.workflow.yml...',
    ]);
    expect(result?.content.at(-1)?.text).toContain(
      'call workflow_run with action status and verify the recorded stage',
    );
  });

  // The launcher's process chain has stayed open for over a minute after the
  // run itself was registered and working, and a launch that waits for it holds
  // the caller's turn open for exactly that long. The registry answers earlier
  // and more truthfully: a recorded run is a run that started.
  it('answers a launch when the run registers, not when the launcher chain closes', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    harness.runToolExecute.mockImplementation(() => new Promise(() => {}));
    listRuns(harness, [
      runRecord({
        displayName: 'Dance Production',
        runKey: 'dance-run',
        stage: 'running',
        startedAt: new Date().toISOString(),
        workflowId: 'dance.workflow',
        workflowPath: '/repo/automations/dance.workflow.yml',
      }),
    ]);

    const result = await harness.callTool('launch_workflow', { workflowPath: '/repo/automations/dance.workflow.yml' });

    expect(result?.content[0]?.text).toContain('Run key: dance-run');
    expect(result?.content[0]?.text).toContain('Dance Production');
  });

  // Two launches in flight from one session must not report each other's key.
  it('ignores a registered run from a different workflow while acknowledging', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    harness.runToolExecute.mockImplementation(() => new Promise(() => {}));
    listRuns(harness, [
      runRecord({
        runKey: 'other-run',
        stage: 'running',
        startedAt: new Date().toISOString(),
        workflowId: 'other.workflow',
        workflowPath: '/repo/automations/other.workflow.yml',
      }),
    ]);

    const result = await harness.callTool('launch_workflow', { workflowPath: '/repo/automations/dance.workflow.yml' });

    expect(result?.content[0]?.text).not.toContain('other-run');
    expect(result?.content[0]?.text).toContain('no run has registered yet');
  });

  // Answering early trades the launcher's exit code for timeliness. Dropping
  // that code is not part of the trade.
  it('reports a launch that fails after it was already reported started', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    let failLaunch: ((error: Error) => void) | undefined;
    harness.runToolExecute.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failLaunch = reject;
        }),
    );
    listRuns(harness, [
      runRecord({
        runKey: 'dance-run',
        stage: 'running',
        startedAt: new Date().toISOString(),
        workflowId: 'dance.workflow',
        workflowPath: '/repo/automations/dance.workflow.yml',
      }),
    ]);
    await harness.callTool('launch_workflow', { workflowPath: '/repo/automations/dance.workflow.yml' });

    failLaunch?.(new Error('launcher died'));

    await vi.waitFor(() =>
      expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('launcher died'), 'warning'),
    );
  });

  it('lets dispatcher-owned Agiflow identity override agent launch env', async () => {
    vi.stubEnv('AGIFLOW_DISPATCH_CONTEXT_FILE', '/tmp/dispatch-context.xml');
    vi.stubEnv('AGIFLOW_ORGANIZATION_ID', 'host-org');
    vi.stubEnv('AGIFLOW_PROJECT_ID', 'host-project');
    vi.stubEnv('AGIFLOW_DEVICE_ID', 'host-device');
    vi.stubEnv('BACKEND_AGIFLOW_API_ENDPOINT', 'https://host.agiflow.test');
    vi.stubEnv('AGIFLOW_DISPATCH_SECRET_FILE', '/tmp/host-secrets.env');
    try {
      const harness = createHarness();
      await harness.callTool('launch_workflow', {
        env: {
          AGIFLOW_ORGANIZATION_ID: 'agent-org',
          AGIFLOW_PROJECT_ID: 'agent-project',
          AGIFLOW_DEVICE_ID: 'agent-device',
          BACKEND_AGIFLOW_API_ENDPOINT: 'https://agent.agiflow.test',
          AGIFLOW_DISPATCH_SECRET_FILE: '/tmp/agent-secrets.env',
        },
        workflowPath: '/repo/automations/workflows/dev-full.workflow.yml',
        workspace: 'agiflow',
      });

      expect(harness.runToolExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          env: {
            AGIFLOW_DEVICE_ID: 'host-device',
            AGIFLOW_DISPATCH_SECRET_FILE: '/tmp/host-secrets.env',
            AGIFLOW_ORGANIZATION_ID: 'host-org',
            AGIFLOW_PROJECT_ID: 'host-project',
            BACKEND_AGIFLOW_API_ENDPOINT: 'https://host.agiflow.test',
            PI_SESSION_ID: SESSION_ID,
          },
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('follows cmux output and stops following via the shortcut', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'job output\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });
    expect(harness.exec).toHaveBeenCalledWith(
      'cmux',
      ['read-screen', '--workspace', 'workspace-id', '--scrollback', '--lines', '24'],
      { timeout: 10_000 },
    );
    expect(harness.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY_FOLLOW, expect.any(Function), {
      placement: 'aboveEditor',
    });
    expect(harness.renderWidget()).toContain('job output');

    await harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);
    expect(harness.ui.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY_FOLLOW, undefined);
  });

  it("never scrapes or foregrounds Pi's own cmux workspace", async () => {
    vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-host');
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-host' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'pi chat frame\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });
    const opened = await harness.callTool('open_workflow', { runKey: 'auth-run' }, { hasUI: false });

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.renderWidget().join('\n')).toContain("Pi's own terminal");
    expect(opened?.content[0].text).toContain("Pi's own terminal");
    expect(opened?.content[0].text).not.toContain('pi chat frame');
  });

  it("never scrapes or foregrounds Pi's own tmux pane", async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-host/default,1,0');
    vi.stubEnv('TMUX_PANE', '%host');
    const record = runRecord({
      launcher: { paneId: '%host', sessionName: 'workflow-host', type: 'tmux' },
      stage: 'running',
    });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'pi chat frame\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });
    const opened = await harness.callTool('open_workflow', { runKey: 'auth-run' }, { hasUI: false });

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.renderWidget().join('\n')).toContain("Pi's own terminal");
    expect(opened?.content[0].text).toContain("Pi's own terminal");
  });

  it('reuses a recent launcher screen instead of forking the multiplexer again', async () => {
    // Reading a run's screen means forking `cmux read-screen`, measured at
    // ~75ms. Every live surface wants it, and the run panel repaints five times
    // a second, so the read is coalesced behind a minimum interval.
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'job output\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });
    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    const reads = harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'read-screen');
    expect(reads).toHaveLength(1);
    // Still showing the output, from the cached read rather than a fresh fork.
    expect(harness.renderWidget()).toContain('job output');
  });

  it('reads the registry once per inspector refresh', async () => {
    // The roster and the detail pane want the same run. Looking it up twice
    // paged the whole registry a second time on every 750ms tick.
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'job output\n' });

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const opening = harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);
    const inspector = await harness.waitForOverlay();
    // Wait for a populated roster, not just a mounted component. An empty one
    // never reaches the detail pane, and the count below would pass on nothing.
    await vi.waitFor(() => expect(inspector.render(100).join('\n')).toContain('auth-run'));

    // Two other things page this same registry: the component's own 750ms poll and
    // the extension's 120ms debounced status refresh. Either one landing inside the
    // window below reads as a second lookup and fails the count for a reason that
    // has nothing to do with the refresh under test. Stop the poll, then let the
    // debounce drain — no event after this re-arms it.
    clearInterval((inspector as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    await new Promise((settle) => setTimeout(settle, 200));
    harness.listRunsPage.mockClear();

    (inspector as unknown as { invalidate: () => void }).invalidate();
    await vi.waitFor(() => expect(harness.listRunsPage).toHaveBeenCalled());
    await new Promise((settle) => setTimeout(settle, 25));

    expect(harness.listRunsPage).toHaveBeenCalledTimes(1);

    inspector.handleInput?.('\x1b');
    await opening;
  });

  it('opens the workflow inspector when no run view is active', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    harness.ui.setWidget.mockClear();

    const opening = harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);
    const inspector = await harness.waitForOverlay();

    expect(harness.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlay: true, onHandle: expect.any(Function) }),
    );
    inspector.handleInput?.('\x1b');
    await opening;
    expect(harness.ui.setWidget).not.toHaveBeenCalled();
  });

  it('launches the catalog cursor workflow with r, through the shared executor', async () => {
    const harness = createHarness();
    const listWorkflowsExecute = vi.spyOn(harness.feature.listWorkflowsTool, 'execute').mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            directory: '/repo',
            hasNextPage: false,
            page: 1,
            pageSize: 100,
            workflows: [
              {
                description: 'Deploy the API',
                name: 'Deploy',
                path: 'automations/deploy.workflow.yml',
                tags: [],
              },
            ],
          }),
        },
      ],
      isError: false,
    });
    vi.spyOn(harness.feature.parser, 'parseWorkflowFile').mockReturnValue({
      jobs: { deploy: { steps: [{ interactiveRun: { codex: 'codex' } }] } },
      name: 'Deploy',
      on: { user_prompt: {} },
    } as Workflow);
    harness.ui.editor.mockResolvedValue('deploy this API');

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    void harness.invokeLeaderAction('workflow.catalog');

    const board = await harness.overlayAt(0);
    const rendered = board.render(100).join('\n');
    expect(rendered).toContain('WORKFLOWS');
    // The detail pane is on the cursor workflow without an inspect step.
    expect(rendered).toContain('INSPECTING Deploy');
    board.handleInput?.('r');

    // The board closes on launch, so the runner choice is reachable.
    const runner = await harness.overlayAt(1);
    expect(runner.render(100).join('\n')).toContain('Select a workflow runner');
    runner.handleInput?.('\r');

    await vi.waitFor(() => expect(harness.runToolExecute).toHaveBeenCalled());
    expect(listWorkflowsExecute).toHaveBeenCalledWith({ directory: '/repo', page: 1, pageSize: 100 });
    expect(harness.runToolExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'deploy this API',
        runner: 'codex',
        workflowPath: '/repo/automations/deploy.workflow.yml',
      }),
    );
    expect(harness.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('needs an interactive'),
      expect.anything(),
    );
  });

  it('runs the leader manage action only for current-session runs and pauses safely', async () => {
    const mine = runRecord({ executionState: 'running', runKey: 'mine', stage: 'running' });
    const foreign = runRecord({ env: { PI_SESSION_ID: 'other-session' }, runKey: 'foreign', stage: 'running' });
    const harness = createHarness([mine, foreign]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const managing = harness.invokeLeaderAction('workflow.manage');
    const inspector = await harness.waitForOverlay();
    await vi.waitFor(() => expect(inspector.render(100).join('\n')).toContain('mine'));
    expect(inspector.render(100).join('\n')).not.toContain('foreign');
    inspector.handleInput?.('\r');

    const menu = await harness.overlayAt(1);
    expect(menu.render(100).join('\n')).toContain('Manage mine');
    await chooseInOverlay(menu, 'Pause');
    const reopened = await harness.overlayAt(2);
    expect(harness.requestPause).toHaveBeenCalledWith(
      'agiflow',
      'mine',
      undefined,
      '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
    );
    await chooseInOverlay(reopened, 'Back');
    await managing;
  });

  it('offers resume for a paused run and does not stop it when manager selection is cancelled', async () => {
    const paused = runRecord({ executionState: 'paused', runKey: 'paused', stage: 'running' });
    const harness = createHarness([paused]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const managing = harness.invokeLeaderAction('workflow.manage');
    const inspector = await harness.waitForOverlay();
    await vi.waitFor(() => expect(inspector.render(100).join('\n')).toContain('paused'));
    inspector.handleInput?.('\r');

    const menu = await harness.overlayAt(1);
    expect(menu.render(100).join('\n')).toContain('Manage paused');
    await chooseInOverlay(menu, 'Resume');
    // The menu reopens only after the control call, so waiting for it first
    // keeps the assertion below free of a race with the reopen.
    const reopened = await harness.overlayAt(2);
    expect(harness.requestResume).toHaveBeenCalledWith('agiflow', 'paused', '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f');
    await chooseInOverlay(reopened, 'Back');
    await managing;
    expect(harness.requestStop).not.toHaveBeenCalled();
  });

  it('does not stop when stop confirmation is cancelled', async () => {
    const harness = createHarness([runRecord({ runKey: 'cancel-stop', stage: 'running' })]);
    harness.ui.confirm.mockResolvedValue(false);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const managing = harness.invokeLeaderAction('workflow.manage');
    const inspector = await harness.waitForOverlay();
    await vi.waitFor(() => expect(inspector.render(100).join('\n')).toContain('cancel-stop'));
    inspector.handleInput?.('\r');

    const menu = await harness.overlayAt(1);
    expect(menu.render(100).join('\n')).toContain('Manage cancel-stop');
    await chooseInOverlay(menu, 'Stop');
    // A cancelled confirmation returns to the menu, so its reopening is the
    // signal that the confirm resolved.
    const reopened = await harness.overlayAt(2);
    expect(harness.ui.confirm).toHaveBeenCalledOnce();
    await chooseInOverlay(reopened, 'Back');
    await managing;
    expect(harness.requestStop).not.toHaveBeenCalled();
  });

  it('revalidates a stop after confirmation before controlling the run', async () => {
    const record = runRecord({ runKey: 'stale-stop', stage: 'running' });
    const harness = createHarness([record]);
    harness.ui.confirm.mockImplementation(async () => {
      listRuns(harness, [{ ...record, stage: 'completed' }]);
      return true;
    });

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const managing = harness.invokeLeaderAction('workflow.manage');
    const inspector = await harness.waitForOverlay();
    await vi.waitFor(() => expect(inspector.render(100).join('\n')).toContain('stale-stop'));
    inspector.handleInput?.('\r');

    const menu = await harness.overlayAt(1);
    expect(menu.render(100).join('\n')).toContain('Manage stale-stop');
    await chooseInOverlay(menu, 'Stop');
    await managing;
    await vi.waitFor(() =>
      expect(harness.ui.notify).toHaveBeenCalledWith('stale-stop is no longer running.', 'warning'),
    );
    expect(harness.requestStop).not.toHaveBeenCalled();
  });

  it('offers a failed run from another Pi session for recovery adoption', async () => {
    const foreign = runRecord({
      env: { PI_SESSION_ID: 'session-that-closed' },
      runKey: 'interrupted-elsewhere',
      stage: 'error',
    });
    const harness = createHarness([foreign]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const recovering = harness.invokeLeaderAction('workflow.recover');
    const picker = await harness.waitForOverlay();
    expect(picker.render(100).join('\n')).toContain('interrupted-elsewhere');
    picker.handleInput?.('\r');
    await recovering;

    const request = harness.sendUserMessage.mock.calls[0]?.[0] as string;
    expect(request).toContain('"runKey":"interrupted-elsewhere"');
  });

  it('hands recovery to the agent exactly once with escaped identity and packaged skill path', async () => {
    const record = runRecord({
      displayName: 'Failure output must stay private',
      runKey: 'broken"\\run',
      stage: 'error',
      workspace: 'agiflow"workspace',
    });
    const harness = createHarness([record]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    const recovering = harness.invokeLeaderAction('workflow.recover');
    // Failed runs go through the same filterable picker as the catalog.
    const picker = await harness.waitForOverlay();
    expect(picker.render(100).join('\n')).toContain('WORKFLOW RECOVERY');
    picker.handleInput?.('\r');
    await recovering;

    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
    const [request, options] = harness.sendUserMessage.mock.calls[0] as [string, { deliverAs: string }];
    const identityLine = request.split('\n').find((line) => line.startsWith('Run identity: '));
    expect(identityLine).toBeDefined();
    expect(JSON.parse(identityLine!.slice('Run identity: '.length))).toEqual({
      runKey: record.runKey,
      workspace: record.workspace,
    });
    const skillLine = request.split('\n').find((line) => line.startsWith('Read the package-owned recovery skill'));
    expect(skillLine).toMatch(/skills[\\/]workflow-recovery[\\/]SKILL\.md/);
    expect(request).not.toMatch(/dryRun\s*[:=]/);
    expect(request).not.toMatch(/job\s*[:=]/);
    expect(request).not.toContain('Failure output must stay private');
    expect(options).toEqual({ deliverAs: 'followUp' });
    expect(harness.activeTools()).toEqual(expect.arrayContaining([FOREIGN_TOOL, ...WORKFLOW_PI_TOOL_NAMES]));
  });

  it('keeps terminal error records out of the active workflow list', async () => {
    const mine = runRecord({ runKey: 'failed-here', stage: 'error' });
    const foreign = runRecord({ env: { PI_SESSION_ID: 'other-session' }, runKey: 'failed-there', stage: 'error' });
    const harness = createHarness([mine, foreign]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.renderProgressWidget()).toEqual([]);
    expect(harness.ui.setWidget.mock.calls.some(([key, value]) => key === WIDGET_KEY_PROGRESS && value)).toBe(false);
  });

  it('follows tmux output using the durable pane identity', async () => {
    const record = runRecord({
      launcher: { paneId: '%12', sessionId: '$4', sessionName: 'workflow-auth-run', type: 'tmux', windowId: '@8' },
      stage: 'running',
    });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'tmux output\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    // `-e` keeps the pane's colour; without it tmux renders the capture as
    // plain text and every attribute dies at the source.
    expect(harness.exec).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-e', '-t', '%12', '-S', '-24'], {
      timeout: 10_000,
    });
    expect(harness.renderWidget()).toContain('tmux output');
  });

  // The TUI contract is that no rendered line may exceed the given width. The
  // launcher output is arbitrary terminal capture, so this is the line between
  // a clean widget and a corrupted one.
  it('fits every widget line within the terminal width', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: `${'x'.repeat(300)}\n` });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    // visibleWidth, not length: truncateToWidth appends an SGR reset, so a
    // correctly fitted line is longer in bytes than it is on screen.
    for (const width of [20, 40, 80, 200]) {
      for (const line of harness.renderWidget(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('reads a cmux run in colour through terminal.replay, not the plain-text screen', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({
      code: 0,
      killed: false,
      stderr: '',
      stdout: JSON.stringify({
        render_grid: {
          styles: [{ id: 1, foreground: '#FF0000', foreground_source: 'rgb', background_source: 'default' }],
          row_spans: [{ row: 1, column: 0, text: 'build failed', style_id: 1 }],
          scrollback_spans: [],
        },
      }),
    });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    expect(harness.exec).toHaveBeenCalledWith(
      'cmux',
      ['rpc', 'terminal.replay', JSON.stringify({ workspace_id: 'workspace-id' })],
      { timeout: 10_000 },
    );
    const rendered = harness.renderWidget(120).join('\n');
    expect(rendered).toContain('build failed');
    expect(rendered).toContain('\x1b[38;2;255;0;0m');
  });

  it('falls back to the plain-text screen when cmux cannot answer terminal.replay', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    // An older cmux: the rpc verb is unknown, the read-screen alias still works.
    harness.exec.mockImplementation(async (_command: string, args: string[]) =>
      args[0] === 'rpc'
        ? { code: 1, killed: false, stderr: 'unknown method', stdout: '' }
        : { code: 0, killed: false, stderr: '', stdout: 'plain output\n' },
    );

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    expect(harness.renderWidget(120).join('\n')).toContain('plain output');
  });

  it('sheds header detail on a narrow terminal but keeps the run key', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'out\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    const wide = harness.renderWidget(120)[0];
    expect(wide).toContain('auth-run');
    expect(wide).toContain('agiflow');
    expect(wide).toContain(shortcutLabel(SHORTCUT_TOGGLE_VIEW));

    const narrow = harness.renderWidget(24)[0];
    expect(narrow).toContain('auth-run');
    expect(narrow).not.toContain(shortcutLabel(SHORTCUT_TOGGLE_VIEW));
  });

  // The GitHub-Actions shape: finished jobs collapse to one line, the running
  // job expands to its steps. A scraped terminal cannot express this.
  it('renders the job tree when the run recorded progress', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.writeProgress([
      { at: 't1', type: 'job', status: 'running', job: 'plan', index: 0, total: 2 },
      { at: 't2', type: 'step', status: 'completed', job: 'plan', step: 'read spec' },
      { at: 't3', type: 'job', status: 'completed', job: 'plan' },
      { at: 't4', type: 'job', status: 'running', job: 'implement', index: 1, total: 2 },
      { at: 't5', type: 'step', status: 'completed', job: 'implement', step: 'nx build' },
      { at: 't6', type: 'step', status: 'running', job: 'implement', step: 'nx test' },
    ]);

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });
    const rendered = harness.renderWidget(100).join('\n');

    expect(rendered).toContain('✔ plan');
    expect(rendered).toContain('▸ implement');
    expect(rendered).toContain('2/2');
    // The running job's steps are listed...
    expect(rendered).toContain('nx test');
    // ...and the finished job's are not.
    expect(rendered).not.toContain('read spec');
    // Progress replaces the screen scrape rather than sitting alongside it.
    expect(harness.exec).not.toHaveBeenCalled();
  });

  it('falls back to the launcher screen when a run recorded no progress', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'raw output\n' });

    await harness.callTool('follow_workflow', { runKey: 'auth-run' });

    expect(harness.renderWidget()).toContain('raw output');
  });

  // "Show it over Pi" is a persistent panel, not a modal. Awaiting the overlay
  // would hold the tool call open and freeze the agent mid-turn, leaving
  // nothing to switch back to.
  it('opens a persistent overlay without blocking the tool call', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);

    // Resolves on its own: no one closed anything.
    const result = await harness.callTool('open_workflow', { runKey: 'auth-run' });

    expect(harness.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlay: true, onHandle: expect.any(Function) }),
    );
    // select-workspace would have moved the user out of Pi.
    expect(harness.exec.mock.calls.some(([, args]) => args?.includes('select-workspace'))).toBe(false);
    expect(result?.content[0].text).toContain(shortcutLabel(SHORTCUT_TOGGLE_VIEW));
  });

  it('shows workflow PTY frames in the explicit overlay but not its chat result', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'workflow PTY frame\n' });

    const result = await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    expect(component.render(100).join('\n')).toContain('workflow PTY frame');
    expect(result?.content[0].text).not.toContain('workflow PTY frame');
  });

  it('resizes a tmux run to the panel it is being watched in, once per geometry', async () => {
    const record = runRecord({
      launcher: { paneId: '%12', sessionId: '$4', sessionName: 'workflow-auth-run', type: 'tmux', windowId: '@8' },
      stage: 'running',
    });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'tmux output\n' });

    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();
    component.render(120);
    component.render(120);

    const resizes = harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'resize-window');
    // Two paints at one size buy one resize; the window, not the pane, is what
    // carries an absolute size in tmux.
    expect(resizes).toHaveLength(1);
    expect(resizes[0][1]).toEqual(['resize-window', '-t', '@8', '-x', expect.any(String), '-y', expect.any(String)]);

    component.render(200);
    expect(harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'resize-window')).toHaveLength(2);
  });

  it('leaves a cmux run at its own size, because cmux cannot be told an absolute one', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'plain output\n' });

    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();
    component.render(120);

    expect(harness.exec.mock.calls.some(([, args]) => args?.[0] === 'resize-window')).toBe(false);
    expect(harness.exec.mock.calls.some(([command]) => command === 'cmux')).toBe(true);
  });

  it('batches typing and hands escape to the run so its agent can be interrupted', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    for (const char of 'yes') component.handleInput?.(char);
    await new Promise((settle) => setTimeout(settle, 60));

    // One batched send, not three: at ~18ms per call that is the difference
    // between usable and unusable typing.
    let sends = harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual(['send', '--workspace', 'workspace-id', 'yes']);

    component.handleInput?.('\x1b');
    await new Promise((settle) => setTimeout(settle, 60));

    // Escape reaches the run rather than closing the panel: interrupting the
    // agent inside a step matters more than a shortcut to dismiss.
    sends = harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send');
    expect(sends).toHaveLength(2);
    expect(sends[1][1]).toEqual(['send', '--workspace', 'workspace-id', '\x1b']);
  });

  it('handles the typing shortcut inside the focused run before the TTY can swallow it', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    component.handleInput?.('\x1b\x17');
    await new Promise((settle) => setTimeout(settle, 30));

    expect(harness.overlayHandle()?.isFocused()).toBe(false);
    expect(harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send')).toHaveLength(0);

    await harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);
    expect(harness.overlayHandle()?.isFocused()).toBe(true);
    expect(harness.overlayHandle()?.hidden).toBe(false);
  });

  it('handles the close shortcut inside the focused run without forwarding it', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    component.handleInput?.('\x1b\x11');
    await new Promise((settle) => setTimeout(settle, 30));

    expect(harness.overlayHandle()?.hidden).toBe(true);
    expect(harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send')).toHaveLength(0);
  });

  // Pi clips an over-long overlay from the end, so the footer is the first line
  // lost to a short terminal — and it is the one carrying the way out.
  it('keeps the escape hatch in the panel footer at every size', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    for (const width of [40, 80, 120]) {
      // The frame's bottom border is the last row, so the legend sits above it.
      expect(component.render(width).at(-2)).toContain('Esc Esc');
    }
  });

  // The chords ride on a modifier some terminals never send: macOS without
  // Option-as-Meta turns ctrl+alt+w into a plain ctrl+w, which the panel then
  // forwards to the run. Escape is the one key every terminal agrees on, which
  // is what makes it the exit that cannot be taken away.
  it('closes the panel on a quick double escape when the chords cannot be typed', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    component.handleInput?.('\x1b');
    component.handleInput?.('\x1b');
    await new Promise((settle) => setTimeout(settle, 60));

    expect(harness.overlayHandle()?.hidden).toBe(true);
    // Only the first escape went out: the run still gets its interrupt, and the
    // one that closed the panel was consumed rather than forwarded.
    const sends = harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual(['send', '--workspace', 'workspace-id', '\x1b']);
    const notice = harness.ui.notify.mock.calls.map(([message]) => String(message)).join('\n');
    expect(notice).toContain('Closed the auth-run view');
  });

  // Two interrupts sent a second apart are two interrupts. Closing the panel
  // there would take the view away from someone who never asked to leave.
  it('keeps the panel open when the escapes are too far apart to be one gesture', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    const component = await harness.waitForOverlay();

    component.handleInput?.('\x1b');
    await new Promise((settle) => setTimeout(settle, 400));
    component.handleInput?.('\x1b');
    await new Promise((settle) => setTimeout(settle, 60));

    expect(harness.overlayHandle()?.hidden).toBe(false);
    expect(harness.exec.mock.calls.filter(([, args]) => args?.[0] === 'send')).toHaveLength(2);
  });

  // A natively hosted run has no multiplexer to address, so sendToRun drops
  // everything typed at it. Focusing that panel is how a user ends up typing
  // into a void with no indication anything is wrong.
  it('opens a natively hosted run as a view that never takes the keyboard', async () => {
    const record = runRecord({ launcher: { type: 'native' }, stage: 'running' });
    const harness = createHarness([record]);

    const result = await harness.callTool('open_workflow', { runKey: 'auth-run' });
    await harness.waitForOverlay();

    expect(harness.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlayOptions: expect.objectContaining({ nonCapturing: true }) }),
    );
    expect(result?.content[0].text).toContain('view only');
    const notice = harness.ui.notify.mock.calls.map(([message]) => String(message)).join('\n');
    expect(notice).toContain('view only');
  });

  // pi-tui's focus() ignores nonCapturing, so nothing but this guard stops the
  // toggle handing the keyboard to a panel that cannot use it.
  it('refuses to give typing to a view-only panel', async () => {
    const record = runRecord({ launcher: { type: 'native' }, stage: 'running' });
    const harness = createHarness([record]);
    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    await harness.waitForOverlay();
    harness.ui.notify.mockClear();

    await harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);

    expect(harness.overlayHandle()?.hidden).toBe(false);
    const notice = harness.ui.notify.mock.calls.map(([message]) => String(message)).join('\n');
    expect(notice).toContain('takes no typing');
  });

  // A tmux or cmux panel is the interactive case and must keep its focus toggle.
  it('still opens a multiplexed run with the keyboard', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);

    await harness.callTool('open_workflow', { runKey: 'auth-run' });
    await harness.waitForOverlay();

    const options = harness.ui.custom.mock.calls.at(-1)?.[1] as { overlayOptions?: Record<string, unknown> };
    expect(options?.overlayOptions?.nonCapturing).toBeUndefined();
  });

  it('leaves the close key to Pi when no panel is open', async () => {
    const harness = createHarness([]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    await expect(harness.shortcuts.get(SHORTCUT_CLOSE_VIEW)?.handler(harness.ctx)).resolves.toBeUndefined();
    expect(harness.ui.notify).not.toHaveBeenCalled();
  });

  // The task-like widget carries the workflow name, elapsed time, job, and
  // current step without occupying either footer implementation.
  it('publishes running workflows to the live workflow list', async () => {
    const harness = createHarness([runRecord({ runKey: 'ixx-324', stage: 'running' })]);
    harness.writeProgress([
      { type: 'job', status: 'running', job: 'plan', index: 0, total: 2, at: '2026-01-01T00:00:00.000Z' },
    ]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY_PROGRESS, expect.any(Function), {
      placement: 'aboveEditor',
    });
    const widget = harness.renderProgressWidget().join('\n');
    expect(widget).toContain('● Workflows (1)');
    expect(widget).toMatch(new RegExp(`auth-run\\[[^\\]]+\\]\\[plan\\] ${WORKFLOW_SPINNER_PATTERN} Starting workflow`));
    expect(harness.ui.setStatus).not.toHaveBeenCalled();
  });

  it('shows step transitions in the live list without writing chat messages', async () => {
    const record = runRecord({ runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([record]);
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
      { type: 'step', status: 'completed', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:12.000Z' },
    ]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.renderProgressWidget().join('\n')).toMatch(/auth-run\[[^\]]+\]\[verify\] \* Claim the job/);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('replaces the progress widget cleanly when session_start repeats', async () => {
    const record = runRecord({ runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([record]);
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
    ]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const progressCalls = harness.ui.setWidget.mock.calls.filter(([key]) => key === WIDGET_KEY_PROGRESS);
    expect(progressCalls.map(([, value]) => (typeof value === 'function' ? 'register' : 'remove'))).toEqual([
      'register',
      'remove',
      'register',
    ]);
    expect(harness.renderProgressWidget().join('\n')).toMatch(
      new RegExp(`\\[verify\\] ${WORKFLOW_SPINNER_PATTERN} Claim the job`),
    );
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps progress visible while the agent is mid-turn without steering chat', async () => {
    const record = runRecord({ runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([record]);
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
    ]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, { ...harness.ctx, isIdle: () => false } as never);

    expect(harness.renderProgressWidget().join('\n')).toMatch(
      new RegExp(`\\[verify\\] ${WORKFLOW_SPINNER_PATTERN} Claim the job`),
    );
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps another Pi session out of passive UI and persisted agent context', async () => {
    const foreign = runRecord({ env: { PI_SESSION_ID: 'another-session' }, stage: 'running' });
    const harness = createHarness([foreign]);
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
    ]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.ui.setStatus).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    const widget = harness.ui.setWidget.mock.calls.filter((entry) => entry[0] === WIDGET_KEY_PROGRESS).at(-1);
    expect(widget?.[1]).toBeUndefined();

    const opening = harness.shortcuts.get(SHORTCUT_TOGGLE_VIEW)?.handler(harness.ctx);
    const inspector = await harness.waitForOverlay();
    await vi.waitFor(() => expect(inspector.render(80).join('\n')).toContain('No active workflows'));
    inspector.handleInput?.('\x1b');
    await opening;
  });

  it('publishes launch, success, and failure narration requests', async () => {
    const harness = createHarness([], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const successful = runRecord({
      displayName: 'Successful build',
      runId: 'successful-run-id',
      runKey: 'successful-run',
      stage: 'running',
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    listRuns(harness, [successful]);
    await vi.waitFor(() => expect(harness.narrations()).toEqual(['Workflow launched: Successful build.']));

    const completed = { ...successful, stage: 'completed' as const };
    listRuns(harness, [completed]);
    await vi.waitFor(() =>
      expect(harness.narrations()).toEqual([
        'Workflow launched: Successful build.',
        'Workflow succeeded: Successful build.',
      ]),
    );

    const failing = runRecord({
      displayName: 'Failing build',
      runId: 'failing-run-id',
      runKey: 'failing-run',
      stage: 'running',
      startedAt: new Date(Date.now() + 2_000).toISOString(),
    });
    listRuns(harness, [completed, failing]);
    await vi.waitFor(() => expect(harness.narrations()).toContain('Workflow launched: Failing build.'));

    listRuns(harness, [completed, { ...failing, stage: 'error' }]);
    await vi.waitFor(() => expect(harness.narrations()).toContain('Workflow failed: Failing build.'));
  });

  it('drops narration while the Voice provider is absent and rebinds to its replacement', async () => {
    const harness = createHarness([], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const first = runRecord({
      displayName: 'First provider run',
      runId: 'first-provider-run-id',
      runKey: 'first-provider-run',
      stage: 'running',
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    listRuns(harness, [first]);
    await vi.waitFor(() => expect(harness.narrations()).toEqual(['Workflow launched: First provider run.']));

    await harness.removeNarration();
    const unbound = runRecord({
      displayName: 'Unbound run',
      runId: 'unbound-run-id',
      runKey: 'unbound-run',
      stage: 'running',
      startedAt: new Date(Date.now() + 2_000).toISOString(),
    });
    listRuns(harness, [first, unbound]);
    await pollsSettle(harness);
    expect(harness.narrations()).toEqual(['Workflow launched: First provider run.']);

    await harness.provideNarration('workflow-narration-replacement');
    listRuns(harness, [first, { ...unbound, stage: 'completed' }]);
    await vi.waitFor(() =>
      expect(harness.narrationDeliveries()).toContainEqual({
        generation: 'workflow-narration-replacement',
        text: 'Workflow succeeded: Unbound run.',
      }),
    );
  });

  // The registry is one directory under $HOME shared by every repo and every
  // Pi session on the machine, so "a run finished" has to mean "a run this
  // session launched finished" or the notice goes to the wrong agent.
  it('announces a finished run to the session that launched it', async () => {
    const running = runRecord({ runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([running], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    listRuns(harness, [{ ...running, stage: 'completed' }]);

    await vi.waitFor(() => {
      const notice = harness.ui.notify.mock.calls.map(([message]) => String(message)).join('\n');
      expect(notice).toContain('ixx-324 completed');
    });
    const finished = harness.sendMessage.mock.calls.find(
      ([message]) => message.customType === MESSAGE_TYPE_RUN_FINISHED,
    );
    expect(finished?.[1]).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  it('announces a failed run with its pushed job and step evidence', async () => {
    const running = runRecord({ runKey: 'failed-run', stage: 'running' });
    const harness = createHarness([running], { monitorIntervalMs: 10 });
    harness.writeProgress([
      {
        type: 'step',
        status: 'running',
        job: 'verify',
        step: 'Claim the job',
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'step',
        status: 'failed',
        job: 'verify',
        step: 'Claim the job',
        reason: 'claim failed',
        at: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'job',
        status: 'failed',
        job: 'verify',
        reason: 'claim failed',
        at: '2026-01-01T00:00:05.000Z',
      },
    ]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    listRuns(harness, [{ ...running, failedJob: 'verify', stage: 'error' }]);

    await vi.waitFor(() => {
      const message = harness.sendMessage.mock.calls.find(
        ([candidate]) => candidate.customType === MESSAGE_TYPE_RUN_FINISHED,
      )?.[0];
      expect(message?.content).toContain('failed-run in workspace agiflow ended in error');
      expect(message?.content).toContain('Failed job: verify (step: Claim the job)');
      expect(message?.content).toContain('Step reported: claim failed');
    });
    expect(harness.sendMessage.mock.calls.some(([message]) => message.customType === 'workflow-step')).toBe(false);
  });

  it('announces a run that starts and finishes between monitor polls', async () => {
    const harness = createHarness([], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const finished = runRecord({
      runKey: 'fast-run',
      stage: 'completed',
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    listRuns(harness, [finished]);

    await vi.waitFor(() => {
      const messages = harness.sendMessage.mock.calls.filter(
        ([message]) => message.customType === MESSAGE_TYPE_RUN_FINISHED,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.[0].content).toContain('fast-run');
    });
  });

  it('batches terminal runs into one root wake-up', async () => {
    const first = runRecord({ runId: 'run-1', runKey: 'first', stage: 'running' });
    const second = runRecord({ runId: 'run-2', runKey: 'second', stage: 'running' });
    const harness = createHarness([first, second], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    listRuns(harness, [
      { ...first, stage: 'completed' },
      { ...second, stage: 'completed' },
    ]);

    await vi.waitFor(() => {
      const messages = harness.sendMessage.mock.calls.filter(
        ([message]) => message.customType === MESSAGE_TYPE_RUN_FINISHED,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.[0].content).toContain('first');
      expect(messages[0]?.[0].content).toContain('second');
      expect(messages[0]?.[0].details).toMatchObject({
        runIds: ['run-1', 'run-2'],
        // The renderer draws its lines from `runs`; `runIds` stays for readers
        // that already index by id.
        runs: [
          expect.objectContaining({ runKey: 'first', stage: 'completed' }),
          expect.objectContaining({ runKey: 'second', stage: 'completed' }),
        ],
      });
    });
  });

  it('retries terminal delivery after a send failure', async () => {
    const running = runRecord({ runId: 'retry-run-id', runKey: 'retry-run', stage: 'running' });
    const harness = createHarness([running], { monitorIntervalMs: 10 });
    let failed = false;
    harness.sendMessage.mockImplementation((message) => {
      if (!failed && message.customType === MESSAGE_TYPE_RUN_FINISHED) {
        failed = true;
        throw new Error('send failed');
      }
    });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    listRuns(harness, [{ ...running, stage: 'completed' }]);

    await vi.waitFor(() => {
      const messages = harness.sendMessage.mock.calls.filter(
        ([message]) => message.customType === MESSAGE_TYPE_RUN_FINISHED,
      );
      expect(messages).toHaveLength(2);
    });
  });

  it('stays silent when a run belonging to another session finishes', async () => {
    const foreign = runRecord({ env: { PI_SESSION_ID: 'another-session' }, runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([foreign], { monitorIntervalMs: 10 });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    listRuns(harness, [{ ...foreign, stage: 'completed' }]);

    // Wait for the monitor to have actually observed the change, so this is a
    // proven silence rather than an assertion that ran before anything polled.
    await pollsSettle(harness);

    // Neither a toast for the user nor a turn's worth of context for the
    // agent: this session has nothing to do with that run.
    expect(harness.ui.notify).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  // The observer already carries the transition, so updating the transient row
  // must not buy another registry page or append anything to the transcript.
  it('renders a pushed step without extra registry reads or chat messages', async () => {
    const harness = createHarness([runRecord({ runKey: 'ixx-324', stage: 'running' })], { monitorIntervalMs: 60_000 });
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
      { type: 'step', status: 'completed', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:05.000Z' },
    ]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    expect(harness.renderProgressWidget().join('\n')).toContain('[verify] * Claim the job');
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.listRuns).toHaveBeenCalledTimes(1);
  });

  it('removes a finished run and emits only its terminal message', async () => {
    const running = runRecord({ runKey: 'ixx-324', stage: 'running' });
    const harness = createHarness([running], { monitorIntervalMs: 10 });
    harness.writeProgress([
      { type: 'step', status: 'running', job: 'verify', step: 'Claim the job', at: '2026-01-01T00:00:00.000Z' },
    ]);
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    expect(harness.renderProgressWidget().join('\n')).toContain('Claim the job');

    listRuns(harness, [{ ...running, stage: 'completed' }]);

    await vi.waitFor(() => {
      const progressCall = harness.ui.setWidget.mock.calls.filter(([key]) => key === WIDGET_KEY_PROGRESS).at(-1);
      expect(progressCall?.[1]).toBeUndefined();
      expect(
        harness.sendMessage.mock.calls.filter(([message]) => message.customType === MESSAGE_TYPE_RUN_FINISHED),
      ).toHaveLength(1);
    });
    expect(harness.sendMessage.mock.calls.some(([message]) => message.customType === 'workflow-step')).toBe(false);
  });

  it('retains the legacy renderer for workflow-step cards already in a session', () => {
    const harness = createHarness([]);
    const renderer = harness.messageRenderers.get('workflow-step');
    const message = {
      content: '[auth-run]: verify\nSTARTED::Claim the job',
      details: {
        displayName: 'auth-run',
        job: 'verify',
        status: 'STARTED',
        step: 'Claim the job',
      },
    };

    const component = renderer?.(message, { outputPad: 0 }, harness.ctx.ui.theme);
    const rendered = component?.render(80).join('\n') ?? '';

    expect(rendered).toContain('[auth-run]: verify');
    expect(rendered).toContain('STARTED::Claim the job');
    expect(rendered).not.toContain('[workflow-step]');
  });

  it('takes the progress row away when nothing is running', async () => {
    const harness = createHarness([runRecord({ stage: 'completed' })]);

    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);

    const call = harness.ui.setWidget.mock.calls.filter((entry) => entry[0] === WIDGET_KEY_PROGRESS).at(-1);
    expect(call?.[1]).toBeUndefined();
  });

  // The doom frame sizes itself from the terminal, so the footer is drawn rather
  // than clipped. It is the only on-screen hint for how to get out, which is why
  // it is asserted at every height rather than assumed.
  it('sizes the panel to the terminal so the exit hint is never clipped', async () => {
    for (const rows of [12, 24, 40, 80]) {
      const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
      const harness = createHarness([record]);
      harness.setTerminalRows(rows);
      await harness.callTool('open_workflow', { runKey: 'auth-run' });
      const overlay = await harness.waitForOverlay();

      const lines = overlay.render(80);

      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.at(-2)).toContain(shortcutLabel(SHORTCUT_CLOSE_VIEW));
    }
  });

  it('tells the user how to close the panel when it opens', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);

    const result = await harness.callTool('open_workflow', { runKey: 'auth-run' });
    await harness.waitForOverlay();

    expect(result?.content[0].text).toContain(shortcutLabel(SHORTCUT_CLOSE_VIEW));
    expect(result?.content[0].text).toContain('Escape twice');
    // The tool result is addressed to the agent. The user has to be told too,
    // or the only place the exit appears is one dim line inside the panel.
    const notice = harness.ui.notify.mock.calls.map(([message]) => String(message)).join('\n');
    expect(notice).toContain(shortcutLabel(SHORTCUT_TOGGLE_VIEW));
    // The failsafe leads: it is the only exit that survives a terminal which
    // does not transmit the chords.
    expect(notice).toContain('Esc twice');
  });

  it('falls back to the launcher when there is no UI to render into', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);

    const result = await harness.callTool('open_workflow', { runKey: 'auth-run' }, { hasUI: false });

    expect(harness.ui.custom).not.toHaveBeenCalled();
    expect(result?.content[0].text).toContain('Opened auth-run in cmux');
  });

  it('returns chat-safe tail status without launcher frames', async () => {
    const record = runRecord({ launcher: { type: 'cmux', workspaceId: 'workspace-id' }, stage: 'running' });
    const harness = createHarness([record]);
    harness.exec.mockResolvedValue({ code: 0, killed: false, stderr: '', stdout: 'job output\n' });
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx);
    harness.ui.setWidget.mockClear();

    const result = await harness.callTool('tail_workflow', { runKey: 'auth-run' });

    expect(result?.content[0].text).toContain('Raw launcher output is hidden from chat');
    expect(result?.content[0].text).not.toContain('job output');
    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.ui.setWidget).not.toHaveBeenCalled();
  });

  it('rejects an unknown run key rather than picking one', async () => {
    const harness = createHarness([runRecord()]);

    await expect(harness.callTool('tail_workflow', { runKey: 'nope' })).rejects.toThrow('No workflow run matches');
  });
});

/**
 * The registry is one directory under $HOME shared by every repository and every
 * Pi session on the machine. Without scoping, each session can list, foreground,
 * stop, and recover every other session's runs, and the agent has no way to tell
 * which of them it is actually responsible for.
 */
describe('workflow-mcp Pi extension session ownership', () => {
  /** A run belonging to a different Pi session, i.e. another agent's work. */
  const foreign = runRecord({
    displayName: 'their-run',
    env: { PI_SESSION_ID: 'session-2' },
    launcher: { type: 'cmux', workspaceId: 'their-workspace' },
    runKey: 'their-run',
    stage: 'running',
  });
  /** A run started from the command line: stamped by nobody. */
  const unstamped = runRecord({ displayName: 'cli-run', env: {}, runKey: 'cli-run', stage: 'running' });

  it('reports status only for a run this session launched', async () => {
    const mine = runRecord({ runKey: 'auth-run', stage: 'running' });
    const harness = createHarness([mine, foreign, unstamped]);

    const result = await harness.callTool('workflow_run', { action: 'status', runKey: 'auth-run' });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('auth-run');
    expect(text).not.toContain('their-run');
    expect(text).not.toContain('cli-run');
  });

  it('does not expose another session"s or unstamped live runs to status', async () => {
    const harness = createHarness([foreign, unstamped]);

    await expect(harness.callTool('workflow_run', { action: 'status', runKey: 'their-run' })).rejects.toThrow(
      'No workflow run matches',
    );
    await expect(harness.callTool('workflow_run', { action: 'status', runKey: 'cli-run' })).rejects.toThrow(
      'No workflow run matches',
    );
  });

  it('keeps generic status and tail scoped for a foreign terminal failure', async () => {
    const failedForeign = { ...foreign, stage: 'error' } as WorkflowRunRecord;
    const harness = createHarness([failedForeign]);

    await expect(harness.callTool('workflow_run', { action: 'status', runKey: 'their-run' })).rejects.toThrow(
      'No workflow run matches',
    );
    await expect(harness.callTool('workflow_run', { action: 'tail', runKey: 'their-run' })).rejects.toThrow(
      'No workflow run matches',
    );
  });

  it('reads durable foreign failure evidence only through the recovery action', async () => {
    const failedForeign = { ...foreign, stage: 'error' } as WorkflowRunRecord;
    const harness = createHarness([failedForeign]);
    harness.writeProgress([{ job: 'build', status: 'failed', type: 'job' }]);

    const result = await harness.callTool('workflow_run', { action: 'recovery-evidence', runKey: 'their-run' });

    expect(result?.content[0]?.text).toContain('run.json');
    expect(result?.content[0]?.text).toContain('"stage": "error"');
    expect(result?.content[0]?.text).toContain('progress.ndjson');
    expect(result?.content[0]?.text).toContain('"status":"failed"');
    expect(harness.exec).not.toHaveBeenCalledWith('cmux', expect.arrayContaining(['read-screen']), expect.anything());
  });

  // Stopping is the costly one: `requestStop` writes into the run directory, so
  // the check has to happen before the tool is reached, not after.
  it('refuses to stop a run another session launched', async () => {
    const harness = createHarness([foreign]);

    await expect(harness.callTool('stop_workflow', { runKey: 'their-run' })).rejects.toThrow(
      'No workflow run matches "their-run" in this session',
    );
    expect(harness.requestStop).not.toHaveBeenCalled();
  });

  it('still stops a run this session launched and binds the request to its generation', async () => {
    const harness = createHarness([runRecord({ stage: 'running' })]);

    await harness.callTool('stop_workflow', { runKey: 'auth-run' });

    expect(harness.requestStop).toHaveBeenCalledWith(
      undefined,
      'auth-run',
      undefined,
      '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
    );
  });

  it('pauses and resumes only a run this session launched', async () => {
    const harness = createHarness([runRecord({ stage: 'running' }), foreign]);

    await harness.callTool('workflow_run', { action: 'pause', reason: 'user requested', runKey: 'auth-run' });
    await harness.callTool('workflow_run', { action: 'resume', runKey: 'auth-run' });

    expect(harness.requestPause).toHaveBeenCalledWith(
      undefined,
      'auth-run',
      'user requested',
      '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
    );
    expect(harness.requestResume).toHaveBeenCalledWith(undefined, 'auth-run', '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f');
    await expect(harness.callTool('workflow_run', { action: 'pause', runKey: 'their-run' })).rejects.toThrow(
      'No workflow run matches',
    );
  });

  // Recovery is the deliberate ownership-transfer path. It may adopt a
  // terminal run from a session that is no longer available, but no other
  // action above gains cross-session access.
  it('recovers a failed run another session launched', async () => {
    const failedForeign = { ...foreign, stage: 'error' } as WorkflowRunRecord;
    const harness = createHarness([failedForeign]);

    await harness.callTool('recover_workflow', { runKey: 'their-run' });

    expect(harness.recoverToolExecute).toHaveBeenCalled();
  });

  it('does not adopt a running run from another session', async () => {
    const harness = createHarness([foreign]);

    await expect(harness.callTool('recover_workflow', { runKey: 'their-run' })).rejects.toThrow(
      'No failed workflow run matches',
    );
    expect(harness.recoverToolExecute).not.toHaveBeenCalled();
  });

  it('still recovers a run this session launched', async () => {
    const harness = createHarness([runRecord()]);

    await harness.callTool('recover_workflow', { runKey: 'auth-run' });

    expect(harness.recoverToolExecute).toHaveBeenCalled();
  });

  it('preserves the globally resolved non-default workspace for in-process recovery', async () => {
    const harness = createHarness([runRecord({ workspace: 'non-default' })]);

    await harness.callTool('recover_workflow', { runKey: 'auth-run' });

    expect(harness.recoverToolExecute).toHaveBeenCalledWith(
      expect.objectContaining({ runKey: 'auth-run', workspace: 'non-default' }),
    );
  });

  it('fails closed when a recovery key is ambiguous across workspaces', async () => {
    const first = runRecord({ workspace: 'one' });
    const second = runRecord({ workspace: 'two' });
    const harness = createHarness([first, second]);

    await expect(harness.callTool('recover_workflow', { runKey: 'auth-run' })).rejects.toThrow(
      'exists in more than one workspace',
    );
    expect(harness.recoverToolExecute).not.toHaveBeenCalled();
  });

  it('resolves an owned live duplicate before considering foreign workspace ambiguity', async () => {
    const mine = runRecord({ runKey: 'shared', stage: 'running', workspace: 'mine' });
    const theirs = runRecord({
      env: { PI_SESSION_ID: 'another-session' },
      runKey: 'shared',
      stage: 'running',
      workspace: 'theirs',
    });
    const harness = createHarness([theirs, mine]);

    const result = await harness.callTool('workflow_run', { action: 'status', runKey: 'shared' });

    expect(result?.content[0]?.text).toContain('"workspace": "mine"');
  });

  it('fails closed when this session owns the same key in multiple workspaces', async () => {
    const harness = createHarness([
      runRecord({ runKey: 'shared', stage: 'running', workspace: 'one' }),
      runRecord({ runKey: 'shared', stage: 'running', workspace: 'two' }),
    ]);

    await expect(harness.callTool('workflow_run', { action: 'status', runKey: 'shared' })).rejects.toThrow(
      'exists in more than one workspace in this session',
    );
  });

  /**
   * A recovery replays with the launch step skipped, so in-process it runs every
   * job here. For an `interactiveRun` workflow that means an agent TUI spawned
   * onto this process's terminal, which inside Pi is the screen the user is
   * looking at. A workflow that knows how to delegate gets recovered that way.
   */
  it('recovers through a launcher when the workflow declares a launch-command', async () => {
    vi.stubEnv('CMUX_SURFACE_ID', 'surface-host');
    vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-host');
    vi.stubEnv('TMUX_PANE', '%host');
    const directory = mkdtempSync(resolve(tmpdir(), 'workflow-recover-'));
    const workflowPath = resolve(directory, 'auth.workflow.yml');
    writeFileSync(workflowPath, delegatingWorkflowYaml, 'utf8');
    const harness = createHarness([runRecord({ workflowPath })]);

    const result = await harness.callTool('recover_workflow', { runKey: 'auth-run' });

    expect(harness.recoverToolExecute).not.toHaveBeenCalled();
    const [, args] = harness.spawnDetached.mock.calls.at(-1) ?? [];
    const argv = args as string[];
    expect(argv).toContain('launch-process');
    // The recovery itself is the launcher's payload, quoted for one more shell.
    expect(argv.at(-1)).toContain('recover-workflow');
    expect(argv.at(-1)).toContain('auth-run');
    expect(argv.at(-1)).toContain('--recovery-claim');
    expect(argv.at(-1)).toContain('claim-1');
    expect(harness.claimRunRecovery).toHaveBeenCalledWith('agiflow', 'auth-run', SESSION_ID);
    const spawnOptions = harness.spawnDetached.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv };
    expect(spawnOptions.env?.[SUBAGENT_ROOT_SESSION_ENV]).toBeUndefined();
    expect(spawnOptions.env?.CMUX_SURFACE_ID).toBeUndefined();
    expect(spawnOptions.env?.CMUX_WORKSPACE_ID).toBeUndefined();
    expect(spawnOptions.env?.TMUX_PANE).toBeUndefined();
    expect(result?.content[0]?.text).toContain('launcher of its own');
  });

  it('releases the claim when the detached launcher cannot start', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'workflow-recover-'));
    const workflowPath = resolve(directory, 'auth.workflow.yml');
    writeFileSync(workflowPath, delegatingWorkflowYaml, 'utf8');
    const harness = createHarness([runRecord({ workflowPath })]);
    harness.spawnDetached.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(harness.callTool('recover_workflow', { runKey: 'auth-run' })).rejects.toThrow('spawn failed');

    expect(harness.releaseRunRecoveryClaim).toHaveBeenCalledWith('agiflow', 'auth-run', 'claim-1');
  });

  it('recovers in process when the workflow has no launcher to delegate to', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'workflow-recover-'));
    const workflowPath = resolve(directory, 'auth.workflow.yml');
    writeFileSync(workflowPath, delegatingWorkflowYaml.replace(/^launch-command:.*$/m, ''), 'utf8');
    const harness = createHarness([runRecord({ workflowPath })]);

    await harness.callTool('recover_workflow', { runKey: 'auth-run' });

    expect(harness.spawnDetached).not.toHaveBeenCalled();
    expect(harness.recoverToolExecute).toHaveBeenCalled();
  });

  // A dry run prints the recovery plan instead of executing it, so it has
  // nothing to hand to a launcher and its output belongs to the caller.
  it('keeps a dry-run recovery in process even when the workflow delegates', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'workflow-recover-'));
    const workflowPath = resolve(directory, 'auth.workflow.yml');
    writeFileSync(workflowPath, delegatingWorkflowYaml, 'utf8');
    const harness = createHarness([runRecord({ workflowPath })]);

    await harness.callTool('recover_workflow', { runKey: 'auth-run', dryRun: true });

    expect(harness.spawnDetached).not.toHaveBeenCalled();
    expect(harness.recoverToolExecute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  for (const tool of ['follow_workflow', 'tail_workflow', 'open_workflow']) {
    it(`refuses to ${tool} a run another session launched`, async () => {
      const harness = createHarness([foreign]);

      await expect(harness.callTool(tool, { runKey: 'their-run' })).rejects.toThrow('in this session');
    });
  }

  // An unstamped run is invisible for the same reason a foreign one is, and the
  // message has to point at where it can actually be managed.
  it('points at the CLI for a run it cannot see', async () => {
    const harness = createHarness([unstamped]);

    await expect(harness.callTool('tail_workflow', { runKey: 'cli-run' })).rejects.toThrow('workflow-mcp CLI');
  });

  // Existence is not leaked: a run that is not this session's reads exactly like
  // one that was never launched, so probing keys tells the agent nothing.
  it('reports a foreign run the same way as a missing one', async () => {
    const harness = createHarness([foreign]);
    const messageFor = async (runKey: string): Promise<string> => {
      try {
        await harness.callTool('tail_workflow', { runKey });
        throw new Error(`Expected ${runKey} to be refused.`);
      } catch (error) {
        return String((error as Error).message);
      }
    };

    const missing = await messageFor('never-existed');
    const theirs = await messageFor('their-run');

    expect(theirs.replace('their-run', 'never-existed')).toBe(missing);
  });
});

describe('workflow-mcp Pi extension shutdown', () => {
  /**
   * A workflow with no `launch-command` runs its engine inside the Pi process.
   * Closing Pi kills the orchestrator mid-step, so without this the record stays
   * `running` behind a dead pid and nothing owns the run any more.
   */
  it('finalizes an inline run still in flight when the session closes', async () => {
    const harness = createHarness();
    let finish: (() => void) | undefined;
    // Settles only once the engine is interrupted, which is what a real inline
    // run does: `run()` returns after the interrupt unwinds it.
    harness.runToolExecute.mockImplementation(
      () =>
        new Promise((settle) => {
          finish = () => settle({ content: [{ text: 'interrupted', type: 'text' }], isError: false });
        }),
    );
    harness.runServiceInterrupt.mockImplementation(() => finish?.());

    const launch = harness.callTool('launch_workflow', { workflowPath: '/repo/automations/auth.workflow.yml' });
    await vi.waitFor(() => expect(harness.runToolExecute).toHaveBeenCalled());

    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx as never);

    expect(harness.runServiceInterrupt).toHaveBeenCalledWith('SIGTERM', expect.objectContaining({ phase: 'workflow' }));
    // Shutdown waited for the record to land, rather than racing the process out.
    await expect(launch).resolves.toBeDefined();
  });

  // A run handed to tmux or cmux outlives Pi by design, so interrupting the
  // engine on the way out would stop work the user expects to keep going.
  it('leaves a delegated launch alone', async () => {
    const harness = createHarness();

    await harness.callTool('launch_workflow', { workflowPath: '/repo/automations/auth.workflow.yml' });
    await harness.handlers.get(EVENT_SESSION_SHUTDOWN)?.({}, harness.ctx as never);

    expect(harness.runServiceInterrupt).not.toHaveBeenCalled();
  });

  it('makes repeated session shutdown idempotent', async () => {
    const harness = createHarness();
    await harness.handlers.get(EVENT_SESSION_START)?.({}, harness.ctx as never);

    const shutdown = harness.handlers.get(EVENT_SESSION_SHUTDOWN);
    await expect(shutdown?.({}, harness.ctx as never)).resolves.toBeUndefined();
    await expect(shutdown?.({}, harness.ctx as never)).resolves.toBeUndefined();

    expect(harness.runServiceInterrupt).not.toHaveBeenCalled();
  });
});
