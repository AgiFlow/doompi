import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRootSessionId, SUBAGENT_ROOT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  requireDoomNarrationService,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  createDoomReadinessCoordinator,
  type DoomReadinessCoordinator,
  type DoomReadinessHandle,
  type DoomReadinessNotification,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import {
  createEmbeddedWorkflowFeature,
  type EmbeddedWorkflowFeature,
  readWorkflowProgress,
  summarizeWorkflowProgress,
  type Workflow,
  type WorkflowProgressEvent,
  type WorkflowProgressJob,
  type WorkflowRunControl,
  type WorkflowRunRecord,
  type WorkflowStage,
  WorkflowTerminalService,
} from '@agimon-ai/workflow-mcp';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { type OverlayHandle, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { type RunProviderHandle, registerRunProvider } from '../../../services/backgroundWork';
import { narrateWorkflowTransition, type WorkflowNarrationSink } from '../../../services/workflowNarration';
import { WorkflowInspectorComponent, type WorkflowInspectorSelection } from '../../../tui/workflow/workflowInspector';
import { TerminalInputBatcher } from '../../../tui/workflow/workflowOverlay';
import {
  registerWorkflowFinishedRenderer,
  type WorkflowFinishedRun,
  WORKFLOW_FINISHED_MESSAGE,
} from '../../../tui/workflow/workflowFinishedMessage';
import { openWorkflowCatalogOverlay } from '../../../tui/workflow/workflowCatalog';
import { openWorkflowPickerOverlay } from '../../../tui/workflow/workflowPicker';
import { WorkflowProgressOverlay, workflowProgressRow } from '../../../tui/workflow/workflowProgressOverlay';
import { openWorkflowChoice, openWorkflowInput } from '../../../tui/workflow/workflowPrompt';
import { runPanelUiOptions, WorkflowRunPanelComponent } from '../../../tui/workflow/workflowRunPanel';
import { isWorkflowStepMessageDetails, renderWorkflowStepMessage } from '../../../tui/workflow/workflowStepMessage';
import {
  LEADER_DISABLE_ACTION,
  LEADER_ENABLE_ACTION,
  LEADER_CATALOG_ACTION,
  LEADER_MANAGE_ACTION,
  LEADER_RECOVER_ACTION,
  PACKAGE_SOURCE,
} from '../../../types/index.ts';
import {
  finishedRunSummary,
  isSessionRun,
  launchNotice,
  runsForSession,
  toolResultText,
  withOptions,
} from './piToolBridge';
import {
  createWorkflowLaunchExecutor,
  registerWorkflowPiTools,
  WORKFLOW_PI_TOOL_NAMES,
  type WorkflowLaunchExecutor,
  type WorkflowLaunchInput,
} from './piTools';
import {
  launchWorkflowEntry,
  loadWorkflowCatalog,
  summarizeWorkflowFile,
  type WorkflowLauncherUi,
} from './workflowLauncher';
import {
  isLaunchParseFailure,
  parseWorkflowLaunchCommand,
  resolveWorkflowEntry,
  validateWorkflowLaunch,
} from '../../../services/workflowLaunchCommand.ts';
import { createWorkflowTerminalService } from '../../../services/workflowTerminal.ts';

const DOOM_FULLSCREEN_UI_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: 'top-left',
    width: '100%',
    maxHeight: '100%',
    margin: 0,
  },
} as const;

/** A run panel currently on screen, and how to take it down. */
interface ActiveOverlay {
  handle?: OverlayHandle;
  /**
   * Whether keys typed at this panel can reach the run.
   *
   * False for a natively hosted run, which has no multiplexer to address. Such
   * a panel is opened without focus and must never be given it: typing into it
   * would go nowhere at all.
   */
  interactive: boolean;
  runKey: string;
  teardown: () => void;
}

/** Renderer retained for step cards already persisted by older package versions. */
const LEGACY_WORKFLOW_STEP_MESSAGE = 'workflow-step';
const FOLLOW_WIDGET_KEY = 'workflow-mcp-follow';
const MODE_ID = 'workflow';
const MODE_LABEL = 'Workflow';
const MODE_LABEL_STYLE = 'accent';
const MODE_ORDER = 20;
const MODE_ACTION_ACTIVATE = 'activate';
const MODE_ACTION_DEACTIVATE = 'deactivate';

function workflowModeState(active: boolean, runCount: number): MinorModeState {
  return {
    activation: active ? 'active' : 'inactive',
    condition: 'ready',
    ...(active ? { detail: runCount > 0 ? `${runCount} active runs` : 'tools enabled', color: MODE_LABEL_STYLE } : {}),
    actions: [
      ...(active
        ? [{ id: MODE_ACTION_ACTIVATE, enabled: false, disabledReason: 'Workflow mode is active.' } as const]
        : [{ id: MODE_ACTION_ACTIVATE, enabled: true } as const]),
      ...(active
        ? [{ id: MODE_ACTION_DEACTIVATE, enabled: true } as const]
        : [{ id: MODE_ACTION_DEACTIVATE, enabled: false, disabledReason: 'Workflow mode is inactive.' } as const]),
    ],
  };
}

const LEADER_MODE_BREADCRUMB = 'SPC w e';
const CATALOG_BREADCRUMB = 'SPC › w / workflows › l / list';
const MANAGE_BREADCRUMB = 'SPC › w / workflows › r / runs';
const RECOVER_BREADCRUMB = 'SPC › w / workflows › c / recover';
const RUN_PANEL_BREADCRUMB = 'SPC › w / workflows › run';
const PAUSED_EXECUTION_STATE = 'paused';

const UNFOLLOW_SHORTCUT = 'ctrl+alt+w';
/**
 * Dismisses the run panel.
 *
 * Separate from the focus toggle because a focused panel hands every key to the
 * run, Escape included, so a plain "Escape closes an overlay" is unavailable:
 * interrupting the agent inside a step is worth more than a close key. Folding
 * closing into the focus toggle instead would leave an unfocused panel with no
 * way back to typing into the run.
 *
 * Not the only way out. This chord relies on a modifier some terminals do not
 * transmit, so `DoubleEscapeDetector` backs it with a plain double-Escape that
 * every terminal can send.
 */
const CLOSE_OVERLAY_SHORTCUT = 'ctrl+alt+q';

/** Modifier glyphs macOS users read on their own keyboards and in every menu. */
const MAC_MODIFIER_GLYPHS: Record<string, string> = {
  alt: '⌥',
  cmd: '⌘',
  ctrl: '⌃',
  meta: '⌘',
  shift: '⇧',
};

/**
 * Render a binding the way the user's own platform writes it.
 *
 * The binding string Pi registers stays canonical (`ctrl+alt+w`) on every
 * platform; only the label changes. A macOS user reading "alt" has to translate
 * it to the Option key they actually press, and the modifier is not even
 * labelled "alt" on most Apple keyboards.
 *
 * Pi branches on `process.platform` for its own keybindings, so this follows a
 * convention already in the host rather than inventing one.
 */
export function shortcutLabel(binding: string, platform: NodeJS.Platform = process.platform): string {
  const parts = binding.split('+');
  if (platform === 'darwin') {
    // Glyphs join without separators, as they do in a macOS menu: ⌃⌥W.
    return parts.map((part) => MAC_MODIFIER_GLYPHS[part] ?? part.toUpperCase()).join('');
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('+');
}
const DEFAULT_PAGE_SIZE = 100;
/**
 * The reconcile sweep, which is a fallback rather than the mechanism.
 *
 * The observer reports a change as it happens, so this only bounds how long a
 * change nothing notified us about stays invisible. It was 5s when it was the
 * only way anything was noticed.
 */
const MONITOR_INTERVAL_MS = 30_000;
/**
 * Coalescing window for event-driven status refreshes.
 *
 * A run emits several transitions at once, and each one would otherwise page
 * the registry for the authoritative lifecycle snapshot. One page per burst.
 */
const STATUS_REFRESH_DEBOUNCE_MS = 120;
const PI_EXEC_TIMEOUT_MS = 10_000;
const RECOVERY_EVIDENCE_MAX_BYTES = 64 * 1024;
const RUNNING_STATUS = 'running';
const COMPLETED_STATUS = 'completed';
const FAILED_STATUS = 'failed';
const ERROR_STAGE = 'error';
const ERROR_COLOUR = 'error';
/**
 * How long shutdown waits for an interrupted inline run to finalize its record.
 *
 * Long enough for a step that honours SIGTERM to unwind and for the registry
 * write that follows, short enough that a step ignoring it does not strand the
 * user in a session that will not close.
 */
const SHUTDOWN_FINALIZE_TIMEOUT_MS = 10_000;
const FOLLOW_INTERVAL_MS = 2_000;
const TAIL_LINES = 24;
/** Below these a resized run has no room left to draw, so it keeps its own size and the panel clips. */
/**
 * Overlay refresh cadence and size.
 *
 * Faster than the background widget's 2s: a foregrounded terminal that lags
 * behind your own typing reads as broken, and only the one run being watched
 * pays for it.
 */
const OVERLAY_REFRESH_MS = 200;
/**
 * Slowest part of a refresh, given its own cadence.
 *
 * Reading a run's screen means forking `tmux capture-pane` or `cmux read-screen`,
 * measured at ~75ms. Repainting at 200ms is right for a panel; forking at 200ms
 * is not, so the two are decoupled and only the render keeps the fast tick. A
 * terminal tail is a rolling window of the last few seconds either way, so the
 * slower read costs the reader nothing they can perceive.
 */
const SCREEN_REFRESH_MS = 750;
/**
 * How many recent run announcements the launch handshake can look back through.
 *
 * Only ever searched for a run that registered within the acknowledgement
 * window, so this needs to cover concurrent launches, not session history. The
 * per-session concurrency ceiling is five.
 */
const ANNOUNCED_RUN_HISTORY = 32;
/**
 * Telemetry name for a launch being asked for.
 *
 * Named once because both launch paths, the wizard and the tool, report it and
 * a query that spans them only works while the two agree.
 */
const LAUNCH_REQUESTED_EVENT = 'doom_workflow.launch_requested';
/**
 * Recovery skill shipped by this package, offered to Pi at resource discovery.
 *
 * Recovery is the one path here complex enough to deserve a real skill rather
 * than a few tool guidelines, and this package owns that domain: it cannot
 * assume the host repository provides one. Discovery is cheap, since Pi puts
 * only the name, description, and location in the system prompt and reads the
 * body on demand.
 *
 * Resolved from the module directory, not the module file: `resolve` treats a
 * trailing filename as a path segment. Both `src/extensions` and
 * `dist/extensions` sit two levels below the package root.
 */
const SKILL_RELATIVE_PATH = '../../../../skills';

/**
 * Glyphs for widgets, panels, and notices.
 *
 * Deliberately restricted to characters that render in a default terminal font.
 * A box-drawing or emoji glyph that falls back to tofu is worse than no glyph.
 */
const GLYPH = {
  running: '▸',
  repair: '⚠',
  completed: '✔',
  failed: '✖',
  separator: '·',
} as const;

/**
 * The panel's footer: how to leave, in the order a stuck user needs it.
 *
 * Escape leads on an interactive panel because it is the key every terminal
 * transmits, and the one someone reaches for first when a view will not let go.
 * A view-only panel says so instead: a user who does not know the run is
 * unreachable reads the silence as the panel being broken.
 */
export function panelHint(interactive: boolean, platform: NodeJS.Platform = process.platform): string {
  const close = shortcutLabel(CLOSE_OVERLAY_SHORTCUT, platform);
  if (!interactive) return `view only ${GLYPH.separator} ${close} closes this view`;
  return [
    'Esc Esc closes this view',
    `${shortcutLabel(UNFOLLOW_SHORTCUT, platform)} switches typing`,
    `${close} closes`,
  ].join(` ${GLYPH.separator} `);
}

/** The same hints as key caps, for the doom footer legend. */
export function panelHints(
  interactive: boolean,
  platform: NodeJS.Platform = process.platform,
): readonly (readonly [string, string])[] {
  const close: readonly [string, string] = [shortcutLabel(CLOSE_OVERLAY_SHORTCUT, platform), 'close'];
  if (!interactive) return [close];
  // Leads the legend, and spelled as the copy says it: this cap is the escape
  // hatch, and the chords beside it ride on a modifier some terminals never send.
  return [['Esc Esc', 'close'], [shortcutLabel(UNFOLLOW_SHORTCUT, platform), 'switch typing'], close];
}

/**
 * Header and output lines for the follow widget, fitted to the terminal.
 *
 * Every line a component renders must fit the given width, so the header sheds
 * detail right to left as the terminal narrows: the dismissal hint goes first,
 * then the workspace/stage context, and the run key survives longest because it
 * is the identifier the user needs to name the run.
 *
 * Colour is applied after fitting. Measuring plain text and styling afterwards
 * keeps the arithmetic honest, since escape codes occupy no visible columns.
 */
function renderFollowLines(record: WorkflowRunRecord, output: string[], theme: Theme, width: number): string[] {
  const key = `${GLYPH.running} ${record.runKey}`;
  const meta = [record.workspace, stageLabel(record), record.runner].filter(Boolean).join(` ${GLYPH.separator} `);
  const hint = `${shortcutLabel(UNFOLLOW_SHORTCUT)} to background`;
  const gap = '   ';

  let header = theme.fg('accent', truncateToWidth(key, width));
  if (visibleWidth(key) + gap.length + visibleWidth(meta) <= width) {
    header += gap + theme.fg('muted', meta);
    const used = visibleWidth(key) + gap.length + visibleWidth(meta);
    if (used + gap.length + visibleWidth(hint) <= width) header += gap + theme.fg('dim', hint);
  }

  return [header, ...output.map((line) => truncateToWidth(line, width))];
}

/**
 * Job tree for the follow widget, in the shape a CI run reads best.
 *
 * Finished jobs collapse to a single line so the eye lands on the one still
 * running, whose steps are listed. That is the whole reason this exists: a
 * scraped terminal shows whatever the runner last printed, which is not the
 * same as knowing which job of how many is in flight.
 */
function renderProgressLines(jobs: WorkflowProgressJob[], theme: Theme, width: number): string[] {
  const lines: string[] = [];
  for (const job of jobs) {
    const glyph =
      job.status === COMPLETED_STATUS ? GLYPH.completed : job.status === FAILED_STATUS ? GLYPH.failed : GLYPH.running;
    const colour = job.status === COMPLETED_STATUS ? 'success' : job.status === FAILED_STATUS ? ERROR_COLOUR : 'accent';
    const position = job.total ? ` ${GLYPH.separator} ${(job.index ?? 0) + 1}/${job.total}` : '';
    lines.push(truncateToWidth(theme.fg(colour, `${glyph} ${job.name}`) + theme.fg('dim', position), width));

    // Only the job in flight expands. A finished job's steps are noise.
    if (job.status !== RUNNING_STATUS) continue;
    for (const step of job.steps) {
      const stepGlyph =
        step.status === COMPLETED_STATUS
          ? GLYPH.completed
          : step.status === FAILED_STATUS
            ? GLYPH.failed
            : GLYPH.running;
      const stepColour =
        step.status === RUNNING_STATUS ? 'muted' : step.status === FAILED_STATUS ? ERROR_COLOUR : 'dim';
      lines.push(truncateToWidth(theme.fg(stepColour, `    ${stepGlyph} ${step.name}`), width));
    }
  }
  return lines;
}

function progressEventsForRun(record: WorkflowRunRecord, events: WorkflowProgressEvent[]): WorkflowProgressEvent[] {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) return events;
  return events.filter((event) => {
    const eventAt = Date.parse(event.at);
    return !Number.isFinite(eventAt) || eventAt >= startedAt;
  });
}

/** Human-readable stage, rather than leaking the raw registry enum. */
function stageLabel(record: WorkflowRunRecord): string {
  if (record.stale) return 'stale';
  if (record.stage === ERROR_STAGE) return FAILED_STATUS;
  return record.stage;
}

interface ParsedArguments {
  invalidLauncher?: string;
  launcher?: MultiplexerLauncher;
  name?: string;
  positionals: string[];
  runner?: string;
  workspace?: string;
}

/** Spawn a launcher and forget it, which is all a delegated run needs from us. */
export type DetachedSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<void>;

interface WorkflowPiExtensionOptions {
  /** Package plugin context used to resolve session-scoped Cordis services. */
  cordis?: Context;
  followIntervalMs?: number;
  monitorIntervalMs?: number;
  /** Initial session mode, used by the non-interactive dispatcher composition. */
  initialMode?: boolean;
  /** Told about every mode change, so the leader menu can offer the way out rather than the way in. */
  onModeChange?: (enabled: boolean) => void;
  featureFactory?: () => EmbeddedWorkflowFeature;
  /** Reject work inherited from a stale session or disposed package root. */
  isActive?: () => boolean;
  /** Injected so a test can read the delegated command without running it. */
  spawnDetached?: DetachedSpawn;
  launchAckPollMs?: number;
  launchAckTimeoutMs?: number;
}

export interface WorkflowPiRuntime {
  dispose(context?: ExtensionContext): Promise<void>;
}

/**
 * Multiplexer identity of THIS process, which a launcher spawn must not carry.
 *
 * A child that inherits it records Pi's own workspace as the run's launcher, so
 * every later `open` or `tail` would foreground or scrape this session's screen
 * instead of the run's. The status file is per-step and equally non-inheritable.
 */
const CMUX_WORKSPACE_ID_ENV = 'CMUX_WORKSPACE_ID';
const TMUX_PANE_ENV = 'TMUX_PANE';
const WORKFLOW_TMUX_SESSION_NAME_ENV = 'WORKFLOW_TMUX_SESSION_NAME';
const LAUNCHER_ENVIRONMENT_STRIPPED = [
  'CMUX_SURFACE_ID',
  SUBAGENT_ROOT_SESSION_ENV,
  CMUX_WORKSPACE_ID_ENV,
  TMUX_PANE_ENV,
  'WORKFLOW_LAUNCHER_TYPE',
  WORKFLOW_TMUX_SESSION_NAME_ENV,
  'WORKFLOW_STATUS_FILE',
] as const;

/**
 * Slack between this process's clock and the run record's timestamp.
 *
 * The record is written by another process, and a launch acknowledged a
 * fraction of a second "before" it began is a clock difference, not somebody
 * else's run.
 */
const LAUNCH_ACK_CLOCK_SKEW_MS = 2_000;

const LAUNCHER_ENV = 'WORKFLOW_LAUNCHER';
const RECOVER_COMMAND = 'recover-workflow';
const LAUNCH_PROCESS_COMMAND = 'launch-process';

/**
 * How a run is hosted, which is also the name of the binary that addresses it.
 *
 * One token per launcher rather than two, because they are the same token: a
 * record's `launcher.type` is `tmux` precisely because tmux is what hosts it and
 * `tmux` is what reads it back. `native` has no binary, which is exactly why
 * every surface has to branch on it.
 */
const LAUNCHER_TMUX = 'tmux';
const LAUNCHER_CMUX = 'cmux';
const LAUNCHER_NATIVE = 'native';
/** The cmux socket method that answers with a styled render grid rather than plain text. */
/** The verb the cockpit's launch dialog sends; the leader board does the same work. */
const WORKFLOW_LAUNCH_COMMAND = 'workflow-launch';
type MultiplexerLauncher = typeof LAUNCHER_TMUX | typeof LAUNCHER_CMUX;

const HOST_TERMINAL_OUTPUT_BLOCKED =
  "This run points at Pi's own terminal, so its launcher screen is hidden. Use workflow status instead.";

/**
 * Whether stale or inherited launcher metadata addresses this Pi process.
 *
 * Reading such a target recursively captures the chat into its own widget;
 * opening or sending to it can foreground or type into Pi itself. New embedded
 * runs record `native`, but this guard also makes older records safe.
 */
/**
 * A run with no recorded launcher, which reading and foregrounding both hit.
 *
 * Older records predate launcher identity being persisted, so this is a real
 * state rather than a corrupt one, and both surfaces owe the user the same
 * explanation for it.
 */
const NO_LAUNCHER_RECORDED = 'No durable launcher identity is recorded for this run.';

/**
 * The identifier a run record carries for its definition.
 *
 * Derived the same way `RunWorkflowService` derives it, so the two agree: the
 * file name without its final extension, which keeps the `.workflow` part.
 */
function workflowIdFor(workflowPath: string): string {
  return basename(workflowPath, extname(workflowPath));
}

function launcherEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of LAUNCHER_ENVIRONMENT_STRIPPED) delete env[key];
  return env;
}

/** The launcher the workflow templates default to, when it is a known one. */
function preferredLauncher(): MultiplexerLauncher | undefined {
  const value = process.env[LAUNCHER_ENV];
  return value === LAUNCHER_TMUX || value === LAUNCHER_CMUX ? value : undefined;
}

/**
 * One shell word per argument.
 *
 * `launch-process` hands `--command` to the launcher as a shell string, so a
 * run key or a path with a space in it has to survive one more round of shell
 * parsing than the argv we spawn with.
 */
function shellCommand(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
}

/**
 * The workflow-mcp CLI this extension is built against.
 *
 * Resolved from the dependency rather than PATH: `pnpm exec workflow-mcp` finds
 * whatever the workspace root happens to install, which is not necessarily this
 * version, and it pays for a package-manager resolution on the launch path.
 */
function resolveWorkflowCli(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@agimon-ai/workflow-mcp/cli');
  } catch {
    return undefined;
  }
}

const detachedSpawn: DetachedSpawn = async (command, args, options) => {
  // Detached with no stdio: the run owns a launcher terminal of its own, and
  // anything inherited from here would be written onto Pi's screen. Wait only
  // for spawn/error so an immediate exec failure releases the recovery claim.
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, [...args], { ...options, detached: true, stdio: 'ignore' });
    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      child.off('error', rejectSpawn);
      child.unref();
      resolveSpawn();
    });
  });
};

function tokenize(value: string): string[] {
  return (
    value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1);
      }
      return token;
    }) ?? []
  );
}

export function parseWorkflowCommandArguments(value: string): ParsedArguments {
  const tokens = tokenize(value);
  const parsed: ParsedArguments = { positionals: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === '--launcher' && next) {
      if (next === LAUNCHER_CMUX || next === LAUNCHER_TMUX) parsed.launcher = next;
      else parsed.invalidLauncher = next;
      index += 1;
    } else if (token === '--runner' && next) {
      parsed.runner = next;
      index += 1;
    } else if (token === '--workspace' && next) {
      parsed.workspace = next;
      index += 1;
    } else if (token === '--name' && next) {
      parsed.name = next;
      index += 1;
    } else {
      parsed.positionals.push(token);
    }
  }
  return parsed;
}

function collectRunnerMaps(value: unknown, maps: string[][]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRunnerMaps(item, maps);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'interactiveRun' || key === 'run') && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      maps.push(Object.keys(nested));
    } else {
      collectRunnerMaps(nested, maps);
    }
  }
}

export function compatibleRunners(workflow: Workflow): string[] | undefined {
  const maps: string[][] = [];
  collectRunnerMaps(workflow, maps);
  if (maps.length === 0) return undefined;
  return maps[0].filter((runner) => maps.every((available) => available.includes(runner))).sort();
}

async function listAllRuns(
  registry: EmbeddedWorkflowFeature['registry'],
  workspace?: string,
): Promise<WorkflowRunRecord[]> {
  const records: WorkflowRunRecord[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await registry.listRunsPage({ page, pageSize: DEFAULT_PAGE_SIZE, workspace });
    records.push(...result.items);
    hasNextPage = result.hasNextPage;
    page += 1;
  }
  return records;
}

/**
 * One run, as a person reads it.
 *
 * Middle dots rather than pipes: pipes read as table borders in a terminal and
 * collide visually with the launcher output the widget sits above.
 */
function runLabel(record: WorkflowRunRecord): string {
  return [record.runKey, record.workspace, stageLabel(record), record.runner]
    .filter(Boolean)
    .join(` ${GLYPH.separator} `);
}

export function installWorkflowPiRuntime(options: WorkflowPiExtensionOptions = {}) {
  return (pi: ExtensionAPI): WorkflowPiRuntime => {
    const feature = options.featureFactory?.() ?? createEmbeddedWorkflowFeature();
    const runtimeGeneration = randomUUID();
    let runtimeActive = true;
    let sessionGeneration = 0;
    let readinessAbort: AbortController | undefined;
    let readinessHandle: Promise<DoomReadinessHandle<void>> | undefined;
    let standaloneReadiness: DoomReadinessCoordinator | undefined;
    const invocationActive = options.isActive ?? (() => true);
    const isRuntimeActive = (): boolean => runtimeActive && invocationActive();
    const notifyStandaloneReadiness = (notification: DoomReadinessNotification): void => {
      const diagnostics = notification.diagnostics.join('; ');
      const detail = (notification.error?.message ?? diagnostics) || 'Initialization did not complete.';
      const message = `${notification.packageId} initialization ${notification.state}: ${detail}`;
      if (sessionCtx?.hasUI) sessionCtx.ui.notify(message, 'warning');
      else process.emitWarning(message);
    };
    const readinessCoordinator = (_ctx: ExtensionContext): DoomReadinessCoordinator => {
      const shared = options.cordis ? readDoomReadinessCoordinator(options.cordis) : undefined;
      if (shared) return shared;
      standaloneReadiness ??= createDoomReadinessCoordinator({ notify: notifyStandaloneReadiness });
      return standaloneReadiness;
    };
    const waitForReadiness = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      const pending = readinessHandle;
      if (!pending) throw new Error('Workflow session initialization has not started.');
      const handle = await pending;
      signal?.throwIfAborted();
      await handle.wait(signal ? { signal } : undefined);
      if (!isRuntimeActive() || pending !== readinessHandle) {
        throw new Error('Workflow readiness belongs to a stale extension generation.');
      }
    };
    const bindPiMember = (target: ExtensionAPI, property: PropertyKey): unknown => {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const readinessPi = new Proxy(pi, {
      get(target, property) {
        if (property !== 'registerTool') return bindPiMember(target, property);
        return (tool: Parameters<ExtensionAPI['registerTool']>[0]): void => {
          target.registerTool({
            ...tool,
            execute: async (toolCallId, params, signal, onUpdate, ctx) => {
              await waitForReadiness(signal);
              return tool.execute(toolCallId, params, signal, onUpdate, ctx);
            },
          });
        };
      },
    });
    const { parser, recoverService, registry, runService, runTool } = feature;
    const spawnDetached = options.spawnDetached ?? detachedSpawn;
    const monitorIntervalMs = options.monitorIntervalMs ?? MONITOR_INTERVAL_MS;
    const followIntervalMs = options.followIntervalMs ?? FOLLOW_INTERVAL_MS;
    let monitorTimer: NodeJS.Timeout | undefined;
    let monitorRefreshActive = false;
    let followTimer: NodeJS.Timeout | undefined;
    let followRefreshActive = false;
    let followedRun: WorkflowRunRecord | undefined;
    let previousStages = new Map<string, WorkflowStage>();
    const pendingTerminalRuns = new Map<string, WorkflowRunRecord>();
    const deliveredTerminalRuns = new Set<string>();
    let sessionStartedAt = 0;
    let runProvider: RunProviderHandle | undefined = options.cordis ? registerRunProvider(options.cordis) : undefined;
    let lifecycleNarrationReady = false;
    let sessionRunCount = 0;
    let workflowMode = false;
    let publishedWorkflowState: string | undefined;
    let modeContribution: MinorModeOwnerHandle | undefined;
    options.cordis?.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
      const initialState = workflowModeState(workflowMode, sessionRunCount);
      const contribution = registerMinorModeOwner<ExtensionContext>(requireMinorModeCatalog(modeContext), {
        descriptor: {
          source: PACKAGE_SOURCE,
          id: MODE_ID,
          label: MODE_LABEL,
          description: 'Workflow discovery, launch, inspection, control, and recovery tools.',
          order: MODE_ORDER,
          actions: [
            {
              id: MODE_ACTION_ACTIVATE,
              label: 'Activate',
              description: 'Enable workflow tools for this session.',
              contexts: ['tui', 'headless'],
              parameters: [],
            },
            {
              id: MODE_ACTION_DEACTIVATE,
              label: 'Deactivate',
              description: 'Disable workflow tools without stopping active runs.',
              contexts: ['tui', 'headless'],
              parameters: [],
            },
          ],
        },
        initialState,
        async handleAction(actionId, _argumentsValue, execution) {
          await waitForReadiness();
          if (actionId === MODE_ACTION_ACTIVATE) {
            await applyWorkflowMode(true, execution.context);
            return { message: 'Workflow mode activated.' };
          }
          if (actionId === MODE_ACTION_DEACTIVATE) {
            await applyWorkflowMode(false, execution.context);
            return { message: 'Workflow mode deactivated.' };
          }
          throw new Error(`Unknown workflow mode action: ${actionId}`);
        },
      });
      modeContribution = contribution;
      publishedWorkflowState = JSON.stringify(initialState);
      return () => {
        contribution.dispose();
        if (modeContribution === contribution) {
          modeContribution = undefined;
          publishedWorkflowState = undefined;
        }
      };
    });
    /** Kept so callers outside a handler can still resolve the session id. */
    let sessionCtx: ExtensionContext | undefined;
    let activeOverlay: ActiveOverlay | undefined;
    let inspectorHandle: OverlayHandle | undefined;
    let inspectorOpen = false;
    /** The runs the inspector last listed, keyed the way its items are. */
    let inspectorRecords = new Map<string, WorkflowRunRecord>();
    /**
     * The pushed view of runs this session owns.
     *
     * A delegated run executes in a launcher's process, so nothing in here ever
     * observes it directly. What it observes is the registry the run writes to,
     * which is why this replaces polling rather than instrumenting anything.
     */
    let runControl: WorkflowRunControl | undefined;
    const disposeRunControl = new Set<() => void>();
    /**
     * Job and step transitions per run, accumulated from pushed events.
     *
     * The live list derives its current position from this stream and a failed
     * run reuses the same events for its terminal summary. Released after that
     * summary is delivered.
     */
    const runEvents = new Map<string, WorkflowProgressEvent[]>();
    /**
     * Runs the observer has announced, newest first, for the launch handshake.
     *
     * A launch needs the run key of the run it just started, and the launcher
     * process never learns it. Bounded, because a session that launches all day
     * must not accumulate a record per launch for the sake of a lookup that
     * only ever cares about the last few seconds.
     */
    const announcedRuns: WorkflowRunRecord[] = [];
    /** Active records are the authoritative membership of the task-like progress widget. */
    const activeRunRecords = new Map<string, WorkflowRunRecord>();
    /** Invalidates a registry snapshot when a newer pushed lifecycle event lands mid-read. */
    let activeRunRevision = 0;
    const progressOverlay = new WorkflowProgressOverlay();

    /**
     * The session that owns this extension's runs.
     *
     * Taken from whatever context Pi hands us, and deliberately the SAME value
     * `launch_workflow` stamps onto a run: reading the stamp from one place and
     * the filter from another is how a run goes invisible to the session that
     * just started it. `session_start` fills this in for a session that has
     * launched nothing yet; before either, it is undefined and every ownership
     * check fails closed, which is correct because such a session owns no runs.
     */
    let knownSessionId: string | undefined;
    let telemetry: DoomTelemetry | undefined;
    const getTelemetry = (ctx?: ExtensionContext): DoomTelemetry => {
      telemetry ??= createDoomTelemetry({
        serviceName: 'doom-workflow',
        packageName: '@agimon-ai/doompi-workflow',
        cwd: ctx?.cwd,
        env: process.env,
        enableLogs: true,
        enableTraces: true,
      });
      return telemetry;
    };
    let narrationService: DoomNarrationService | undefined;
    const reportNarrationFailure = (error: unknown): void => {
      void getTelemetry(sessionCtx)
        .recordWarning('doom_workflow.narration_failed', error)
        .catch((telemetryError: unknown) => {
          process.emitWarning(`Doom-workflow could not record a narration failure: ${String(telemetryError)}`);
        });
    };
    const narrationSink: WorkflowNarrationSink = {
      narrate(text) {
        const service = narrationService;
        const request = createNarrationRequest(text);
        if (!service || !request) return;
        try {
          void Promise.resolve(service.request(request)).catch(reportNarrationFailure);
        } catch (error) {
          reportNarrationFailure(error);
        }
      },
    };
    options.cordis?.inject([DOOM_NARRATION_SERVICE], (serviceContext) => {
      const service = requireDoomNarrationService(serviceContext);
      narrationService = service;
      return () => {
        if (narrationService === service) narrationService = undefined;
      };
    });
    const observeSession = (sessionId: string | undefined): void => {
      if (sessionId && isRuntimeActive()) knownSessionId = resolveRootSessionId(sessionId);
    };
    const currentSessionId = (): string | undefined => {
      const sessionId = knownSessionId ?? sessionCtx?.sessionManager.getSessionId();
      return sessionId ? resolveRootSessionId(sessionId) : undefined;
    };
    const isRootProcess = (ctx: ExtensionContext, rootSessionId: string): boolean =>
      ctx.sessionManager.getSessionId().trim() === rootSessionId;

    /**
     * The registry is one directory under $HOME shared by every repository and
     * every Pi session on the machine, so an unscoped tool would let any session
     * list, foreground, stop, or recover any other session's runs. Scoping is a
     * host-level filter on the tool instance, not a caller input: the agent
     * cannot opt out of it, and the CLI (which is how orphaned runs are managed)
     * keeps the global view.
     */
    const recoverTool = feature.createRecoverTool({
      // Ownership follows the recovering session. The host supplies identity
      // out of band; the tool schema cannot choose or override it.
      ownerSessionId: currentSessionId,
    });
    const controlTool = feature.createControlTool();

    /**
     * Inline executions still in flight, so shutdown can finalize them.
     *
     * A workflow declaring `launch-command` hands off to tmux or cmux and its
     * promise settles almost immediately; one without runs its whole engine in
     * this process. Only the latter lingers here, so the set needs no launcher
     * check of its own.
     */
    const pendingInlineRuns = new Set<Promise<unknown>>();
    const trackPendingRun = <T>(run: Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      const runTelemetry = getTelemetry();
      pendingInlineRuns.add(run);
      void runTelemetry.recordEvent('doom_workflow.run_started', { outcome: 'started' });
      // Bookkeeping and telemetry share one handler pair on purpose. A separate
      // `finally` derives a promise that rejects with nobody watching, and an
      // unhandled rejection ends the process, TUI included. Since a launch is
      // answered from the registry, nothing else is necessarily awaiting this
      // run by the time it fails, so this pair is the only thing standing
      // between a failed launcher and a dead session.
      void run.then(
        () => {
          pendingInlineRuns.delete(run);
          return runTelemetry.recordEvent('doom_workflow.run_finished', {
            duration_ms: Date.now() - startedAt,
            outcome: 'completed',
          });
        },
        (error: unknown) => {
          pendingInlineRuns.delete(run);
          return runTelemetry.recordError('doom_workflow.run_failed', error, {
            duration_ms: Date.now() - startedAt,
          });
        },
      );
      return run;
    };

    const rejectRunner = (workflowPath: string, runner: string): string | undefined => {
      const compatible = compatibleRunners(parser.parseWorkflowFile(workflowPath));
      if (!compatible || compatible.includes(runner)) return undefined;
      return `Runner ${JSON.stringify(runner)} is not available across this workflow. Compatible runners: ${compatible.join(', ') || 'none'}.`;
    };

    const launchExecutor: WorkflowLaunchExecutor = createWorkflowLaunchExecutor({
      activeRunCount: async () => sessionRunCount,
      observeSession,
      rejectRunner,
      runTool,
      trackPendingRun,
      ...(options.launchAckPollMs === undefined ? {} : { launchAckPollMs: options.launchAckPollMs }),
      ...(options.launchAckTimeoutMs === undefined ? {} : { launchAckTimeoutMs: options.launchAckTimeoutMs }),
      // A run registering is the earliest honest answer to "did it start?": the
      // launcher's own process chain can stay open long after the run is
      // working, and a launch that waits for it holds the caller's turn open
      // for as long as that takes.
      //
      // Answered from what the observer has announced, with the poll driving a
      // sweep rather than waiting for one. Reading `announcedRuns` alone would
      // make the handshake hostage to a filesystem notification, and a dropped
      // one would cost the caller the whole acknowledgement budget for a run
      // that had already registered. A sweep costs the registry read this used
      // to do on its own, and every other surface gets its events from it.
      findLaunchedRun: async ({ sessionId, since, workflowPath }) => {
        const expectedId = workflowIdFor(workflowPath);
        const matches = (record: WorkflowRunRecord): boolean => {
          if (!isSessionRun(record, sessionId) || record.stale) return false;
          // Matched on identity as well as time so two launches in flight from
          // one session cannot report each other's run key.
          if (record.workflowId && record.workflowId !== expectedId) return false;
          const startedAt = Date.parse(record.startedAt);
          return Number.isFinite(startedAt) && startedAt >= since - LAUNCH_ACK_CLOCK_SKEW_MS;
        };
        // No observer here: the dispatcher bridge runs the launch tool without
        // a session of its own, so it still has to look for itself.
        if (!runControl) return (await listAllRuns(registry)).find(matches);
        await runControl.refresh();
        return announcedRuns.find(matches);
      },
      // A launch answered early still owes the user its failure.
      onLateFailure: (error, ctx) => {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(launchNotice(`Workflow launch failed after it was reported started.\n${detail}`), 'warning');
      },
      onLaunch: async (ctx) => {
        await getTelemetry(ctx).recordEvent(LAUNCH_REQUESTED_EVENT, { outcome: 'requested' });
        return refreshStatus(ctx, false);
      },
    });

    /** Repaint the live list from pushed state without writing progress into chat. */
    const publishProgressOverlay = (): void => {
      const records = [...activeRunRecords.values()].sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          runIdentity(left).localeCompare(runIdentity(right)),
      );
      progressOverlay.update(
        records.map((record) => workflowProgressRow(record, runEvents.get(runIdentity(record)) ?? [])),
      );
    };

    /** Add, refresh, or remove one run from the live list. */
    const noteActiveRecord = (record: WorkflowRunRecord): void => {
      activeRunRevision += 1;
      const identity = runIdentity(record);
      if (record.stage === RUNNING_STATUS && !record.stale) activeRunRecords.set(identity, record);
      else activeRunRecords.delete(identity);
      publishProgressOverlay();
    };

    /** Replace widget membership from an authoritative registry snapshot. */
    const replaceActiveRecords = (records: readonly WorkflowRunRecord[]): void => {
      activeRunRecords.clear();
      for (const record of records) activeRunRecords.set(runIdentity(record), record);
      publishProgressOverlay();
    };

    /** Keep every pushed progress event for both the live row and terminal summary. */
    const noteProgressEvent = (identity: string, event: WorkflowProgressEvent): void => {
      const events = runEvents.get(identity) ?? [];
      events.push(event);
      runEvents.set(identity, events);
    };

    /**
     * Ask for a status refresh, collapsing a burst of events into one.
     *
     * The live list updates from the event itself, but terminal detection still
     * needs the session's authoritative record set, and that costs a registry
     * page. A run emitting six transitions at once must not buy six.
     */
    let statusRefreshTimer: NodeJS.Timeout | undefined;
    const scheduleStatusRefresh = (ctx: ExtensionContext): void => {
      if (!isRuntimeActive() || ctx !== sessionCtx || statusRefreshTimer) return;
      statusRefreshTimer = setTimeout(() => {
        statusRefreshTimer = undefined;
        if (isRuntimeActive() && ctx === sessionCtx) void refreshStatus(ctx, true);
      }, STATUS_REFRESH_DEBOUNCE_MS);
      statusRefreshTimer.unref?.();
    };

    /** Everything remembered about a run, released once it can produce no more. */
    const forgetRun = (identity: string): void => {
      runEvents.delete(identity);
    };

    /**
     * Subscribe to the registry instead of asking it what changed.
     *
     * A run this session launched executes in a launcher's own process, so the
     * only thing connecting it to this one is the session stamp on its record.
     * The filter is that stamp, and it is applied inside the observer so a
     * shared registry never leaks another session's runs into this UI.
     */
    const startRunControl = async (ctx: ExtensionContext): Promise<void> => {
      const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId());
      const control = feature.createRunControl({
        recordFilter: (candidate) => isSessionRun(candidate, sessionId),
      });
      runControl = control;
      const controlIsCurrent = (): boolean => isRuntimeActive() && ctx === sessionCtx && runControl === control;

      const controlDisposers = [
        control.on('step', (event) => {
          if (!controlIsCurrent()) return;
          const identity = runIdentity(event.record);
          noteProgressEvent(identity, {
            at: event.at,
            job: event.job,
            status: event.status,
            step: event.step,
            type: 'step',
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          });
          noteActiveRecord(event.record);
          scheduleStatusRefresh(ctx);
        }),
        control.on('job', (event) => {
          if (!controlIsCurrent()) return;
          const identity = runIdentity(event.record);
          noteProgressEvent(identity, {
            at: event.at,
            job: event.job,
            status: event.status,
            type: 'job',
            ...(event.index === undefined ? {} : { index: event.index }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.total === undefined ? {} : { total: event.total }),
          });
          noteActiveRecord(event.record);
          scheduleStatusRefresh(ctx);
        }),
        control.on('runStarted', (event) => {
          if (!controlIsCurrent()) return;
          announcedRuns.unshift(event.record);
          if (announcedRuns.length > ANNOUNCED_RUN_HISTORY) announcedRuns.length = ANNOUNCED_RUN_HISTORY;
          noteActiveRecord(event.record);
          scheduleStatusRefresh(ctx);
        }),
        control.on('runUpdated', (event) => {
          if (!controlIsCurrent()) return;
          noteActiveRecord(event.record);
          void refreshStatus(ctx, true);
        }),
        control.on('runFinished', (event) => {
          if (!controlIsCurrent()) return;
          noteActiveRecord(event.record);
          void refreshStatus(ctx, true);
        }),
      ];
      for (const dispose of controlDisposers) disposeRunControl.add(dispose);

      try {
        await control.start();
      } catch (error) {
        for (const dispose of controlDisposers) {
          disposeRunControl.delete(dispose);
          dispose();
        }
        control.dispose();
        if (runControl === control) runControl = undefined;
        throw error;
      }
      if (!isRuntimeActive() || ctx !== sessionCtx || runControl !== control) {
        for (const dispose of controlDisposers) {
          disposeRunControl.delete(dispose);
          dispose();
        }
        control.dispose();
        if (runControl === control) runControl = undefined;
      }
    };

    const stopRunControl = (): void => {
      if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
      statusRefreshTimer = undefined;
      for (const dispose of disposeRunControl) dispose();
      disposeRunControl.clear();
      runControl?.dispose();
      runControl = undefined;
      runEvents.clear();
      activeRunRevision += 1;
      activeRunRecords.clear();
      publishProgressOverlay();
    };

    /** Dismiss the run panel entirely, leaving the run itself alone. */
    const closeOverlay = (): void => {
      activeOverlay?.teardown();
      activeOverlay?.handle?.hide();
      activeOverlay = undefined;
    };

    const runIdentity = (record: WorkflowRunRecord): string => record.runId ?? `${record.workspace}/${record.runKey}`;

    const publishModeWidget = (): void => {
      const contribution = modeContribution;
      if (!contribution) return;
      const next = workflowModeState(workflowMode, sessionRunCount);
      const serialized = JSON.stringify(next);
      if (serialized === publishedWorkflowState) return;
      publishedWorkflowState = serialized;
      contribution.publish(next);
    };

    const refreshStatus = async (ctx: ExtensionContext, notifyChanges: boolean): Promise<void> => {
      if (!isRuntimeActive() || ctx !== sessionCtx) return;
      // Resolved before the guard is latched. Anything that can throw between
      // setting the flag and entering the try would strand it set, and a
      // stranded flag turns every later refresh into the early return above:
      // the run snapshot freezes, so the loop's launch budget never recovers.
      const activeTelemetry = getTelemetry(ctx);
      if (monitorRefreshActive) {
        void activeTelemetry.recordEvent('doom_workflow.monitor_skipped', { outcome: 'already_running' });
        return;
      }
      const startedAt = Date.now();
      const activeRevisionAtRead = activeRunRevision;
      monitorRefreshActive = true;
      try {
        const records = await listAllRuns(registry);
        if (!isRuntimeActive() || ctx !== sessionCtx) return;
        const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId());
        const rootProcess = isRootProcess(ctx, sessionId);
        const sessionRecords = records.filter((record) => isSessionRun(record, sessionId));
        const running = sessionRecords.filter((record) => record.stage === RUNNING_STATUS && !record.stale);
        const failed = sessionRecords.filter((record) => record.stage === ERROR_STAGE);
        // Never let a snapshot taken before a pushed terminal event resurrect
        // the row that event just removed. The next refresh can reconcile from
        // a fresh snapshot if any lifecycle event landed during this read.
        if (activeRevisionAtRead === activeRunRevision) replaceActiveRecords(running);
        void activeTelemetry.recordEvent('doom_workflow.monitor_counts', {
          'workflow.run_count': sessionRecords.length,
          'workflow.running_count': running.length,
          'workflow.failed_count': failed.length,
          mode: workflowMode ? 'on' : 'off',
        });

        // Runs this Pi session launched, identified by the session stamp the
        // launch tool puts in the run environment. Publishing them lets other
        // extensions size their own work without reaching into this one.
        const mine = runsForSession(records, sessionId).filter((record) => !record.stale);
        sessionRunCount = mine.length;
        publishModeWidget();
        runProvider?.update(mine.map((record) => ({ id: record.runId ?? record.runKey, sessionId })));

        // A run that has left the session's set can never produce output again,
        // so its cached screen is dead weight.
        forgetLauncherScreens(new Set(sessionRecords.map((record) => runIdentity(record))));

        const nextStages = new Map(sessionRecords.map((record) => [runIdentity(record), record.stage]));
        for (const record of sessionRecords) {
          const identity = runIdentity(record);
          const previous = previousStages.get(identity);
          const startedAt = Date.parse(record.startedAt);
          const startedDuringSession =
            previous === undefined &&
            (sessionStartedAt === 0 || !Number.isFinite(startedAt) || startedAt >= sessionStartedAt);
          if (lifecycleNarrationReady) {
            const narratedPrevious =
              previous === RUNNING_STATUS || previous === COMPLETED_STATUS || previous === ERROR_STAGE
                ? previous
                : undefined;
            narrateWorkflowTransition(narrationSink, record, narratedPrevious, startedDuringSession);
          }
          if (!notifyChanges || !rootProcess || record.stage === RUNNING_STATUS) continue;
          if (!deliveredTerminalRuns.has(identity) && (previous === RUNNING_STATUS || startedDuringSession)) {
            pendingTerminalRuns.set(identity, record);
          }
        }

        // Accumulated transitions belong to runs still going or still owed a
        // summary. Detect terminal deliveries before pruning so a failed run's
        // in-memory events remain available to its terminal message.
        const retainedEventIdentities = new Set([
          ...sessionRecords
            .filter((record) => record.stage === RUNNING_STATUS && !record.stale)
            .map((record) => runIdentity(record)),
          ...pendingTerminalRuns.keys(),
        ]);
        for (const identity of runEvents.keys()) {
          if (!retainedEventIdentities.has(identity)) forgetRun(identity);
        }

        if (notifyChanges) {
          for (const record of sessionRecords) {
            const previous = previousStages.get(runIdentity(record));
            if (previous !== RUNNING_STATUS || record.stage === RUNNING_STATUS) continue;
            const completed = record.stage === COMPLETED_STATUS;
            const detail = record.failedJob ? ` at ${record.failedJob}` : '';
            ctx.ui.notify(
              completed
                ? `${GLYPH.completed} ${record.runKey} completed`
                : `${GLYPH.failed} ${record.runKey} ${stageLabel(record)}${detail}`,
              completed ? 'info' : 'warning',
            );
            void activeTelemetry.recordEvent('doom_workflow.run_transition', {
              outcome: completed ? 'completed' : stageLabel(record),
            });
          }
        }

        if (rootProcess && pendingTerminalRuns.size > 0) {
          try {
            const terminalRecords = [...pendingTerminalRuns.values()];
            const summaries = await Promise.all(
              terminalRecords.map(async (record) => {
                if (record.stage === COMPLETED_STATUS) return finishedRunSummary(record, []);
                // A failure needs the job tree to say which job died. The
                // transitions pushed while the run was going are already in
                // hand; only a run that finished before this session began
                // watching has nothing accumulated and has to be read.
                const identity = runIdentity(record);
                const events =
                  runEvents.get(identity) ??
                  progressEventsForRun(record, await readWorkflowProgress(registry.runDirectoryFor(record)));
                return finishedRunSummary(record, summarizeWorkflowProgress(events));
              }),
            );
            pi.sendMessage(
              {
                customType: WORKFLOW_FINISHED_MESSAGE,
                content: summaries.join('\n\n'),
                display: true,
                details: {
                  runIds: terminalRecords.map((record) => record.runId ?? runIdentity(record)),
                  runs: terminalRecords.map((record): WorkflowFinishedRun => ({
                    runKey: record.runKey,
                    workspace: record.workspace,
                    stage: record.stage,
                    ...(record.workflowId ? { workflowId: record.workflowId } : {}),
                    ...(record.failedJob ? { failedJob: record.failedJob } : {}),
                    ...(record.errorMessage ? { error: record.errorMessage } : {}),
                  })),
                },
              },
              { triggerTurn: true, deliverAs: 'steer' },
            );
            for (const record of terminalRecords) {
              const identity = runIdentity(record);
              deliveredTerminalRuns.add(identity);
              pendingTerminalRuns.delete(identity);
              // Its summary has been delivered, so the accumulated transitions
              // can never be needed again.
              forgetRun(identity);
            }
          } catch (error) {
            await activeTelemetry.recordError('doom_workflow.terminal_delivery_failed', error, {
              'workflow.pending_terminal_count': pendingTerminalRuns.size,
            });
          }
        }

        previousStages = nextStages;
        void activeTelemetry.recordEvent('doom_workflow.monitor_finished', {
          duration_ms: Date.now() - startedAt,
          outcome: 'completed',
        });
      } catch (error) {
        await activeTelemetry.recordError('doom_workflow.monitor_failed', error, {
          duration_ms: Date.now() - startedAt,
        });
        ctx.ui.notify(
          `Workflow status refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
      } finally {
        monitorRefreshActive = false;
      }
    };

    const clearFollow = (ctx: ExtensionContext): void => {
      if (followTimer) clearInterval(followTimer);
      followTimer = undefined;
      followedRun = undefined;
      ctx.ui.setWidget(FOLLOW_WIDGET_KEY, undefined);
    };

    /**
     * This session's view of the terminals its runs were launched into.
     *
     * The engine owns how a launcher is read and driven; this owns how often,
     * which is a property of the surface rather than of the run. Every panel
     * here repaints five times a second and a scrape forks a CLI, so the two
     * concerns stayed separate when the reads moved down into the engine.
     */
    const terminalFacade = new WorkflowTerminalService({
      run: async (command, args, options) => {
        const result = await pi.exec(command, [...args], { timeout: options.timeoutMs });
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      },
      lines: TAIL_LINES,
      timeoutMs: PI_EXEC_TIMEOUT_MS,
    });
    const terminals = createWorkflowTerminalService<WorkflowRunRecord>({
      terminal: terminalFacade,
      now: () => Date.now(),
      refreshMs: SCREEN_REFRESH_MS,
    });

    /**
     * Geometry last asked of each run, so a repaint that changes nothing costs
     * no exec. Keyed by run identity, like every other per-run cache here.
     */
    const launcherGeometry = new Map<string, string>();

    /**
     * Match the run's own terminal to the panel showing it.
     *
     * A run draws at whatever geometry its launcher gave it, so a panel
     * narrower than that shows a clipped window onto a wider screen rather than
     * a smaller rendering of it. Which launchers can be told a size is the
     * engine's business; not asking twice for the same size is this one's.
     *
     * The size is NOT restored when the panel closes: the window belongs to this
     * run, and a run that is watched at panel size should stay readable at panel
     * size for whoever attaches to it next.
     */
    const resizeLauncherViewport = (record: WorkflowRunRecord, columns: number, rows: number): void => {
      const identity = runIdentity(record);
      const geometry = `${columns}x${rows}`;
      if (launcherGeometry.get(identity) === geometry) return;
      launcherGeometry.set(identity, geometry);
      void terminalFacade.resize(record, columns, rows);
    };

    /**
     * A run's recent output, reusing a recent read rather than forking again.
     *
     * Rendering stays as fast as it ever was: the caller gets the cached lines
     * immediately and the next repaint picks up whatever the refresh found.
     */
    const cachedLauncherScreen = (record: WorkflowRunRecord): Promise<string[]> => {
      // Answered here rather than by the engine: the engine cannot know that
      // the caller's own terminal is a Pi session with a status surface to
      // send the reader to instead.
      if (terminalFacade.targetsCurrentTerminal(record)) return Promise.resolve([HOST_TERMINAL_OUTPUT_BLOCKED]);
      return terminals.screen(runIdentity(record), record, TAIL_LINES);
    };

    /** Runs whose screens can never change again cannot earn their memory back. */
    const forgetLauncherScreens = (live: Set<string>): void => {
      terminals.forget(live);
      // The geometry cache is per run for the same reason the screens are: a
      // run that is gone can never be resized again.
      for (const identity of launcherGeometry.keys()) {
        if (!live.has(identity)) launcherGeometry.delete(identity);
      }
    };

    /**
     * Bring a run's launcher to the foreground.
     *
     * Returns a status line rather than notifying, because its only caller is now
     * the `workflow_run` tool's `open` action and the agent needs to read the outcome.
     */
    const openLauncher = async (record: WorkflowRunRecord): Promise<string> => {
      const launcher = record.launcher;
      if (!launcher) return NO_LAUNCHER_RECORDED;
      if (terminalFacade.targetsCurrentTerminal(record)) return HOST_TERMINAL_OUTPUT_BLOCKED;
      if (launcher.type === LAUNCHER_NATIVE) {
        return 'This run is hosted natively rather than in a multiplexer, so there is no separate window to bring forward.';
      }
      if (launcher.type === LAUNCHER_CMUX) {
        await pi.exec(LAUNCHER_CMUX, ['select-workspace', '--workspace', launcher.workspaceId], {
          timeout: PI_EXEC_TIMEOUT_MS,
        });
        return `Opened ${record.runKey} in cmux.`;
      }
      if (!process.env.TMUX) {
        return 'Pi is not attached to tmux. Follow the output instead, or attach to the recorded tmux session manually.';
      }
      const target = launcher.sessionId ?? launcher.sessionName;
      const result = await pi.exec(LAUNCHER_TMUX, ['switch-client', '-t', target], { timeout: PI_EXEC_TIMEOUT_MS });
      if (result.code !== 0) return result.stderr.trim() || `Unable to open tmux session ${target}.`;
      if (launcher.paneId) {
        await pi.exec(LAUNCHER_TMUX, ['select-pane', '-t', launcher.paneId], { timeout: PI_EXEC_TIMEOUT_MS });
      }
      return `Opened ${record.runKey} in tmux.`;
    };

    const renderFollow = async (record: WorkflowRunRecord, ctx: ExtensionContext): Promise<void> => {
      if (followRefreshActive) return;
      followRefreshActive = true;
      try {
        // Prefer the run's own progress log: it says which job and step are in
        // flight, which a scraped screen cannot. Runs started before progress
        // recording existed, and any run whose log is not readable, still get
        // the terminal tail.
        const jobs = summarizeWorkflowProgress(
          progressEventsForRun(record, await readWorkflowProgress(registry.runDirectoryFor(record))),
        );
        const lines = jobs.length > 0 ? undefined : await cachedLauncherScreen(record);
        // Component factory rather than a string array, for two reasons the
        // string form cannot give us: render() receives the terminal width, so
        // launcher output can be fitted instead of overflowing, and the theme is
        // applied fresh on every render, so a theme switch repaints correctly
        // without any cached colours to invalidate.
        ctx.ui.setWidget(
          FOLLOW_WIDGET_KEY,
          (_tui, theme) => ({
            render: (width: number) =>
              renderFollowLines(record, lines ?? renderProgressLines(jobs, theme, width), theme, width),
            invalidate: () => {
              // Nothing cached: render() rebuilds from the current theme.
            },
          }),
          { placement: 'aboveEditor' },
        );
      } finally {
        followRefreshActive = false;
      }
    };

    const followRun = async (record: WorkflowRunRecord, ctx: ExtensionContext): Promise<void> => {
      clearFollow(ctx);
      followedRun = record;
      await renderFollow(record, ctx);
      followTimer = setInterval(() => {
        if (followedRun) void renderFollow(followedRun, ctx);
      }, followIntervalMs);
      followTimer.unref?.();
    };

    /**
     * Forward literal text to a run's terminal.
     *
     * `tmux send-keys -l` and `cmux send` both take text verbatim, which keeps
     * escape sequences intact: an arrow key must arrive as one sequence, not as
     * a bracket and a letter. A natively hosted run has no multiplexer to
     * address, so it reports rather than silently dropping the keystrokes.
     */
    const sendToRun = async (record: WorkflowRunRecord, text: string): Promise<void> => {
      // Silently, because a panel only builds a keyboard for a run whose
      // capabilities already said yes: reaching here with an unwritable run
      // means the run changed under the panel, which is not the typist's problem.
      if (!terminalFacade.capabilities(record).writable) return;
      await terminalFacade.write(record, text);
    };

    /**
     * Show a run over Pi: job tree, live output, and a keyboard that reaches it.
     *
     * Blocks until the user closes it, which is what makes it feel like the run
     * rather than a report about the run. The refresh runs faster than the
     * background widget because a foregrounded terminal that lags behind your
     * own typing reads as broken.
     */
    /**
     * Show a run over Pi as a persistent panel, not a modal.
     *
     * Returns as soon as the panel is up rather than awaiting its close. An
     * awaited overlay would hold the tool call open, which freezes the agent
     * mid-turn and makes "switch back to the main agent" impossible: there is
     * nothing to switch back to while it is still waiting for a tool result.
     *
     * Focus, not lifetime, is what the user toggles. The panel stays on screen
     * while typing goes back to Pi, so Escape stays free for the run's own
     * agent, which uses it to interrupt.
     */
    const openOverlay = async (record: WorkflowRunRecord, ctx: ExtensionContext): Promise<string> => {
      closeOverlay();
      // Exactly what the engine says this run's terminal will take. A run with
      // no reachable terminal gets a panel that is a view rather than a
      // keyboard, and saying so up front beats letting the user type into nothing.
      const interactive = terminalFacade.capabilities(record).writable;
      const input = new TerminalInputBatcher((text) => sendToRun(record, text));
      let jobs: WorkflowProgressJob[] = [];
      let output: string[] = [];
      let refresh: NodeJS.Timeout | undefined;

      let polling = false;
      const poll = async (): Promise<void> => {
        jobs = summarizeWorkflowProgress(
          progressEventsForRun(record, await readWorkflowProgress(registry.runDirectoryFor(record))),
        );
        output = await cachedLauncherScreen(record);
      };
      await poll();

      const teardown = (): void => {
        if (refresh) clearInterval(refresh);
        refresh = undefined;
        input.dispose();
      };

      const entry: ActiveOverlay = { interactive, runKey: record.runKey, teardown };
      activeOverlay = entry;

      /** Shared by the panel footer, the close chord, and the double-Escape failsafe. */
      const closeWithNotice = (): void => {
        closeOverlay();
        ctx.ui.notify(`Closed the ${record.runKey} view. The run keeps going.`, 'info');
      };

      // Deliberately not awaited: the panel outlives this tool call.
      void ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          // Guarded, because a tick that outlives its interval would otherwise
          // start another read on top of the last one and keep doing so. The
          // progress log is a local file and the screen read is coalesced, so a
          // skipped tick costs nothing: the next one repaints from the same state.
          refresh = setInterval(() => {
            if (polling) return;
            polling = true;
            void poll().finally(() => {
              polling = false;
              tui.requestRender();
            });
          }, OVERLAY_REFRESH_MS);
          refresh.unref?.();

          return new WorkflowRunPanelComponent(tui, theme, {
            runKey: record.runKey,
            label: `${GLYPH.running} ${runLabel(record)}`,
            breadcrumb: RUN_PANEL_BREADCRUMB,
            interactive,
            footer: panelHint(interactive),
            hints: panelHints(interactive),
            snapshot: (width) => ({ progress: renderProgressLines(jobs, theme, width), output }),
            onViewport: (columns, rows) => resizeLauncherViewport(record, columns, rows),
            onUnfollow: () => {
              entry.handle?.unfocus();
              ctx.ui.notify('Typing goes to this session. The run keeps going.', 'info');
            },
            onClose: closeWithNotice,
            sendInput: (data) => input.write(data),
            // `flush` takes the pending bytes synchronously and sends them in the
            // background, so the panel still closes on the same keystroke.
            // Without it the run would be interrupted or not depending on whether
            // the user out-typed a 16ms timer, which is not a behaviour anyone can
            // predict or rely on.
            flushInput: () => void input.flush(),
            unfollowShortcut: UNFOLLOW_SHORTCUT,
            closeShortcut: CLOSE_OVERLAY_SHORTCUT,
            onDispose: () => {
              teardown();
              if (activeOverlay === entry) activeOverlay = undefined;
              done();
            },
          });
        },
        {
          ...runPanelUiOptions(interactive),
          onHandle: (handle) => {
            entry.handle = handle;
          },
        },
      );

      // Told to the user directly, not only through the tool result. The result
      // is addressed to the agent, and the panel's own footer is one dim line
      // that a user watching a run scroll past can easily miss. A view you
      // cannot work out how to leave is the thing to avoid here.
      ctx.ui.notify(
        interactive
          ? `${record.runKey}: typing goes to the run. Press Esc twice to close, ${shortcutLabel(UNFOLLOW_SHORTCUT)} to type here instead.`
          : `${record.runKey}: view only, because this run is hosted natively. ${shortcutLabel(CLOSE_OVERLAY_SHORTCUT)} closes it.`,
        'info',
      );

      if (!interactive) {
        return [
          `Showing ${record.runKey} over Pi, as a view only:`,
          'the run is hosted natively rather than in a multiplexer, so there is no terminal to type into.',
          `Typing stays with this session, and ${shortcutLabel(CLOSE_OVERLAY_SHORTCUT)} closes the view.`,
        ].join(' ');
      }

      return [
        `Showing ${record.runKey} over Pi. Typing goes to the run.`,
        'Pressing Escape twice quickly closes the view, and a single Escape still reaches the run.',
        `${shortcutLabel(UNFOLLOW_SHORTCUT)} moves typing between the run and this session,`,
        `and ${shortcutLabel(CLOSE_OVERLAY_SHORTCUT)} closes the view. The run keeps going either way.`,
      ].join(' ');
    };

    const openInspector = async (ctx: ExtensionContext, manage = false): Promise<void> => {
      if (inspectorOpen || activeOverlay || followedRun) return;
      inspectorOpen = true;
      try {
        const selection = await ctx.ui.custom<WorkflowInspectorSelection | undefined>(
          (tui, theme, _keybindings, done) =>
            new WorkflowInspectorComponent(
              tui,
              theme,
              {
                list: async () => {
                  const sessionId = currentSessionId();
                  const records = (await listAllRuns(registry)).filter(
                    (record) => record.stage === RUNNING_STATUS && !record.stale && isSessionRun(record, sessionId),
                  );
                  // Kept so `output` can address the run under the cursor without
                  // paging the whole registry a second time on every refresh.
                  inspectorRecords = new Map(records.map((record) => [runIdentity(record), record]));
                  return Promise.all(
                    records.map(async (record) => ({
                      displayName: record.displayName,
                      executionState: record.executionState,
                      jobs: summarizeWorkflowProgress(
                        progressEventsForRun(record, await readWorkflowProgress(registry.runDirectoryFor(record))),
                      ),
                      key: runIdentity(record),
                      output: [],
                      runKey: record.runKey,
                      startedAt: record.startedAt,
                      workspace: record.workspace,
                    })),
                  );
                },
                output: async (item) => {
                  const record = inspectorRecords.get(item.key);
                  return record ? cachedLauncherScreen(record) : ['Workflow is no longer active.'];
                },
              },
              done,
            ),
          {
            ...DOOM_FULLSCREEN_UI_OPTIONS,
            onHandle: (handle) => {
              inspectorHandle = handle;
            },
          },
        );
        if (selection) {
          const record = await requireRun(selection);
          if (manage) await manageWorkflow(record, ctx);
          else await openOverlay(record, ctx);
        }
      } finally {
        inspectorHandle = undefined;
        inspectorOpen = false;
        inspectorRecords.clear();
      }
    };

    /**
     * Resolve a run this session owns, erroring rather than picking blindly.
     *
     * A run another session launched is reported exactly like one that does not
     * exist. Distinguishing them would leak the shared registry's contents into
     * a session that has no way to act on them anyway, and would invite the
     * agent to keep trying keys it can never use.
     */
    const requireRun = async (
      input: { runKey: string; workspace?: string },
      sessionId: string | undefined = currentSessionId(),
    ): Promise<WorkflowRunRecord> => {
      observeSession(sessionId);
      const records = await listAllRuns(registry, input.workspace);
      const matches = records.filter(
        (candidate) => candidate.runKey === input.runKey && isSessionRun(candidate, sessionId),
      );
      if (matches.length > 1) {
        throw new Error(
          withOptions(
            `Workflow run key ${JSON.stringify(input.runKey)} exists in more than one workspace in this session.`,
            ['Retry with the workspace from the run identity.'],
          ),
        );
      }
      const record = matches[0];
      if (!record) {
        throw new Error(
          withOptions(`No workflow run matches ${JSON.stringify(input.runKey)} in this session.`, [
            'workflow_run with action status: use a run key from this session before retrying.',
            'Tell the user this session did not launch that run rather than guessing a similar key. A run launched by another Pi session, or from the command line, is managed there or with the workflow-mcp CLI.',
          ]),
        );
      }
      return record;
    };

    /**
     * Resolve a failed run that this session may adopt through recovery.
     *
     * Failed runs are terminal and have no live owner to conflict with. This is
     * intentionally the only cross-session lookup. Recovery-specific status
     * and durable evidence reads may use it; live output, lifecycle controls,
     * and running-run UI stay scoped to the launching session.
     */
    const requireRecoverableRun = async (input: { runKey: string; workspace?: string }): Promise<WorkflowRunRecord> => {
      const matches = (await listAllRuns(registry, input.workspace)).filter(
        (candidate) => candidate.runKey === input.runKey && candidate.stage === ERROR_STAGE,
      );
      if (matches.length > 1) {
        throw new Error(
          withOptions(`Failed workflow run key ${JSON.stringify(input.runKey)} exists in more than one workspace.`, [
            'Retry with the workspace from the recovery picker or run identity.',
          ]),
        );
      }
      const record = matches[0];
      if (!record) {
        throw new Error(
          withOptions(`No failed workflow run matches ${JSON.stringify(input.runKey)}.`, [
            'Use the recovery picker to select an interrupted or failed run, or retry with its workspace.',
            'Do not recover a running or completed workflow.',
          ]),
        );
      }
      return record;
    };

    const readRecoveryEvidenceTail = async (record: WorkflowRunRecord): Promise<string[]> => {
      const runDir = registry.runDirectoryFor(record);
      const paths = [
        resolve(runDir, 'changelog.md'),
        resolve(runDir, 'context.md'),
        resolve(runDir, 'progress.ndjson'),
      ];
      const sections: string[] = [];
      for (const path of paths) {
        try {
          const content = await readFile(path, 'utf-8');
          sections.push(`--- ${basename(path)} ---`, content.slice(-RECOVERY_EVIDENCE_MAX_BYTES).trimEnd());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return sections.length > 0 ? sections : ['No durable recovery evidence files are recorded for this run.'];
    };

    /** Read-only evidence access for the one globally adoptable record class. */
    const readRecoverableRunEvidence = async (
      input: { runKey: string; workspace?: string },
      ctx: ExtensionContext,
    ): Promise<string> => {
      const record = await requireRecoverableRun(input);
      await getTelemetry(ctx).recordEvent('doom_workflow.recovery_evidence_requested', { outcome: 'requested' });
      return [
        `Workflow: ${runLabel(record)}`,
        '--- run.json ---',
        JSON.stringify(record, null, 2),
        ...(await readRecoveryEvidenceTail(record)),
      ].join('\n');
    };

    /**
     * Recover a run in a launcher of its own instead of replaying it here.
     *
     * `RecoverWorkflowService` replays with the launch step skipped, so an
     * in-process recovery runs every job inside this process. A workflow whose
     * steps are `interactiveRun` then has its agent spawned with inherited
     * stdio, because that agent needs a real TTY to draw. Inside Pi that TTY is
     * the TUI: the agent draws over it, and the reset sequence written when the
     * step ends is one Pi never issued and cannot repaint from. Delegating
     * costs a process and keeps the screen.
     *
     * Undefined leaves the caller on the in-process path: a workflow that
     * declares no `launch-command` has no launcher to delegate to, and a
     * definition that cannot be read is better diagnosed by the replay itself.
     */
    const delegateRecovery = async (
      input: { runKey: string; workspace?: string; runner?: string },
      ctx: ExtensionContext,
    ): Promise<string | undefined> => {
      const cli = resolveWorkflowCli();
      if (!cli) return undefined;
      const record = await requireRecoverableRun(input);
      let workflow: Workflow;
      try {
        workflow = parser.parseWorkflowFile(record.workflowPath);
      } catch {
        return undefined;
      }
      if (!workflow['launch-command']) return undefined;

      // Mint the transfer capability in the shared registry before spawning.
      // The delegated CLI can only adopt this exact terminal record and gets
      // the owner identity from the claim rather than caller-controlled argv.
      const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId());
      const claim = await registry.claimRunRecovery(record.workspace, record.runKey, sessionId);
      const cwd = record.originalRepoPath ?? ctx.cwd;
      const recoverCommand = shellCommand([
        process.execPath,
        cli,
        RECOVER_COMMAND,
        record.runKey,
        '--workspace',
        record.workspace,
        '--recovery-claim',
        claim.claimId,
        ...(input.runner ? ['--runner', input.runner] : []),
      ]);
      const launcher = preferredLauncher();
      try {
        await spawnDetached(
          process.execPath,
          [
            cli,
            LAUNCH_PROCESS_COMMAND,
            ...(launcher ? ['--launcher', launcher] : []),
            '--name',
            `${record.displayName} recover`,
            '--cwd',
            cwd,
            '--command',
            recoverCommand,
          ],
          { cwd, env: launcherEnvironment() },
        );
      } catch (error) {
        await registry.releaseRunRecoveryClaim(record.workspace, record.runKey, claim.claimId);
        throw error;
      }
      await getTelemetry(ctx).recordEvent('doom_workflow.recover_delegated', {
        launcher: launcher ?? 'auto',
        outcome: 'delegated',
      });
      return `Recovering ${record.runKey} in a launcher of its own, so this session keeps its terminal. It reports back here when it ends.`;
    };

    const manageWorkflow = async (selected: WorkflowRunRecord, ctx: ExtensionContext): Promise<void> => {
      let record = selected;
      while (true) {
        const actions = ['Open output'];
        const state = record.executionState ?? RUNNING_STATUS;
        if (state === RUNNING_STATUS) actions.push('Pause');
        if (state === PAUSED_EXECUTION_STATE) actions.push('Resume');
        if (record.stage === RUNNING_STATUS) actions.push('Stop');
        actions.push('Back');
        const action = await openWorkflowChoice(ctx, {
          title: `Manage ${record.runKey}`,
          breadcrumb: MANAGE_BREADCRUMB,
          choices: actions,
        });
        if (!action || action === 'Back') return;

        record = await requireRun(record);
        if (record.stage !== RUNNING_STATUS) {
          ctx.ui.notify(`${record.runKey} is no longer running.`, 'warning');
          return;
        }
        if (action === 'Open output') {
          await openOverlay(record, ctx);
          return;
        }
        if (action === 'Stop') {
          const confirmed = await ctx.ui.confirm(
            `Stop ${record.runKey}?`,
            'The workflow will be interrupted and will not be restarted automatically.',
          );
          if (!confirmed) continue;
          record = await requireRun(record);
          if (record.stage !== RUNNING_STATUS) {
            ctx.ui.notify(`${record.runKey} is no longer running.`, 'warning');
            return;
          }
        }
        if (action !== 'Pause' && action !== 'Resume' && action !== 'Stop') continue;
        if (!record.runId) throw new Error(`${record.runKey} has no controllable run generation.`);
        const result = await controlTool.execute({
          action: action.toLowerCase() as 'pause' | 'resume' | 'stop',
          expectedRunId: record.runId,
          ...(action === 'Stop' ? { reason: 'Stopped from the workflow manager.' } : {}),
          runKey: record.runKey,
          workspace: record.workspace,
        });
        if (result.isError) throw new Error(toolResultText(result) || `Unable to ${action.toLowerCase()} workflow.`);
        ctx.ui.notify(toolResultText(result) || `${action} requested for ${record.runKey}.`, 'info');
        await refreshStatus(ctx, false);
        record = await requireRun(record);
      }
    };

    /**
     * The wizard's prompts, backed by doom overlays instead of Pi's native
     * widgets, so a launch reads as one framed sequence rather than three styles.
     *
     * `editor` stays with Pi: the workflow prompt is multi-line authoring, and
     * reimplementing a text editor to match a frame would be a poor trade.
     */
    const doomLauncherUi = (ctx: ExtensionContext, breadcrumb: string): WorkflowLauncherUi => ({
      editor: (title, prefill) => ctx.ui.editor(title, prefill),
      input: (title, placeholder) =>
        openWorkflowInput(ctx, { title, breadcrumb, ...(placeholder ? { fallback: placeholder } : {}) }),
      notify: (message, type) => ctx.ui.notify(message, type),
      select: (title, options) => openWorkflowChoice(ctx, { title, breadcrumb, choices: options }),
    });

    /**
     * `SPC w l`: the repository's workflows, the cursor workflow's parsed
     * detail beside it, and `r` to launch that one. Launching closes the board
     * first - the launch prompts are host dialogs, and a fullscreen overlay
     * would sit over them.
     */
    const openWorkflowCatalog = async (ctx: ExtensionContext): Promise<void> => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The workflow list needs an interactive Pi session.', 'warning');
        return;
      }
      const entries = await loadWorkflowCatalog(feature.listWorkflowsTool, ctx.cwd);
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      const launchOptions = {
        compatibleRunners,
        launch: (input: WorkflowLaunchInput, launchContext: ExtensionContext) =>
          launchExecutor.execute(input, launchContext),
        parseWorkflow: (workflowPath: string) => parser.parseWorkflowFile(workflowPath),
        ui: doomLauncherUi(ctx, CATALOG_BREADCRUMB),
      };
      await openWorkflowCatalogOverlay(
        ctx,
        entries.map((entry) => ({
          key: entry.path,
          name: entry.name,
          relativePath: entry.relativePath,
          description: entry.description,
          tags: entry.tags,
        })),
        {
          loadDetail: (row) => summarizeWorkflowFile(row.key, launchOptions),
          launchWorkflow: (row) => {
            const entry = byPath.get(row.key);
            if (!entry) return;
            void launchWorkflowEntry(launchOptions, entry, ctx).then(
              (result) => {
                // Trimmed, because a launch that ran in this process answers
                // with the engine's whole console log, and notifying that
                // verbatim paints tens of lines of banner and job tree over
                // the transcript.
                if (result) ctx.ui.notify(launchNotice(toolResultText(result)), 'info');
              },
              (error: unknown) => {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
              },
            );
          },
        },
      );
    };

    /**
     * `/workflow-launch`: the same launch the catalog board performs, as a line.
     *
     * The cockpit can only send a session a prompt frame, so this is how a
     * browser starts a workflow; typing it by hand does the same thing. Every
     * value the board would have asked for in a dialog arrives on the line, and
     * what the workflow requires is checked before anything is started, because
     * a run missing its prompt starts and then waits for terminal input that is
     * never coming.
     */
    const launchFromCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
      const parsed = parseWorkflowLaunchCommand(args);
      if (isLaunchParseFailure(parsed)) {
        ctx.ui.notify(parsed.error, 'error');
        return;
      }
      const entries = await loadWorkflowCatalog(feature.listWorkflowsTool, ctx.cwd);
      const entry = resolveWorkflowEntry(entries, parsed.workflow);
      if (!entry) {
        ctx.ui.notify(`No workflow matches '${parsed.workflow}' under ${ctx.cwd}.`, 'error');
        return;
      }
      const detail = summarizeWorkflowFile(entry.path, {
        compatibleRunners,
        parseWorkflow: (workflowPath: string) => parser.parseWorkflowFile(workflowPath),
      });
      if (detail.error !== undefined) {
        ctx.ui.notify(`${entry.name} could not be read: ${detail.error}`, 'error');
        return;
      }
      const problems = validateWorkflowLaunch(detail, parsed);
      if (problems.length > 0) {
        ctx.ui.notify(problems.join(' '), 'error');
        return;
      }
      const workflow = parser.parseWorkflowFile(entry.path);
      const input: WorkflowLaunchInput = {
        workflowPath: entry.path,
        ...(parsed.runner === undefined ? {} : { runner: parsed.runner }),
        ...(typeof workflow.workspace === 'string' ? { workspace: workflow.workspace } : {}),
        ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
        ...(Object.keys(parsed.inputs).length === 0 ? {} : { inputs: parsed.inputs }),
      };
      const result = await launchExecutor.execute(input, ctx);
      // Trimmed for the same reason the board trims it: a launch that ran in
      // this process answers with the engine's whole console log.
      ctx.ui.notify(launchNotice(toolResultText(result)), 'info');
    };

    pi.registerCommand(WORKFLOW_LAUNCH_COMMAND, {
      description: 'Launch a workflow: /workflow-launch <workflow> [runner=x] [key=value …] [prompt]',
      handler: async (args, ctx) => {
        await waitForReadiness();
        try {
          await launchFromCommand(args, ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });

    const openRecoveryHandoff = async (ctx: ExtensionContext): Promise<void> => {
      // Recovery adopts terminal work. Include failed runs from dead or other
      // sessions here; passive UI and all controls over live runs stay scoped.
      const records = (await listAllRuns(registry)).filter((record) => record.stage === ERROR_STAGE);
      if (records.length === 0) {
        ctx.ui.notify('No failed workflows are available to recover.', 'info');
        return;
      }
      const chosen = await openWorkflowPickerOverlay(
        ctx,
        {
          title: 'WORKFLOW RECOVERY',
          breadcrumb: RECOVER_BREADCRUMB,
          unit: 'failed runs',
          action: 'recover',
          filterPlaceholder: 'type to filter by name, run key or failed job',
          emptyMessage: 'No failed workflows are available to recover.',
        },
        records.map((record) => ({
          key: `${record.workspace}/${record.runKey}`,
          name: record.displayName,
          detail: `${record.workspace}/${record.runKey}${record.failedJob ? ` · ${record.failedJob}` : ''}`,
          ...(record.failedJob ? { search: record.failedJob } : {}),
          value: record,
        })),
      );
      if (!chosen) return;
      const record = await requireRecoverableRun(chosen);
      if (record.stage !== ERROR_STAGE) throw new Error(`${record.runKey} is no longer failed.`);
      const skillFile = resolve(
        dirname(fileURLToPath(import.meta.url)),
        SKILL_RELATIVE_PATH,
        'workflow-recovery',
        'SKILL.md',
      );
      if (!existsSync(skillFile)) throw new Error(`Workflow recovery skill is unavailable at ${skillFile}.`);
      setWorkflowMode(true);
      ctx.ui.notify(
        'Workflow tools enabled. The agent will investigate this failure and choose the safe next step.',
        'info',
      );
      pi.sendUserMessage(
        [
          'Investigate recovery for this failed workflow run. This selection is permission to investigate, not permission to recover blindly.',
          `Run identity: ${JSON.stringify({ runKey: record.runKey, workspace: record.workspace })}`,
          `Read the package-owned recovery skill with the read tool at ${JSON.stringify(skillFile)} before acting.`,
          'Inspect status, every relevant log source, process state, the staged run.json, and only the repair referenced by activeRepairId.',
          'Choose exactly one outcome: recover, launch fresh, or defer. Never edit issue.md or repair.json, never scan historical repairs, and never pass recovery dryRun or a job override.',
          'Do not recover terminal, approval-pending, blocked, or otherwise unsafe work. If evidence is incomplete, defer and explain what is missing.',
          'If recovery is justified, preserve the recorded worktree and repair metadata, then verify real process and registry progress before reporting success.',
        ].join('\n'),
        { deliverAs: 'followUp' },
      );
    };

    /**
     * Turn workflow mode on or off.
     *
     * `setActiveTools` is a whole-list setter, so this is always a
     * read-modify-write against `getActiveTools()`. Passing a bare literal would
     * silently deactivate every other extension's tools.
     *
     * Activating also injects each tool's `promptSnippet` and `promptGuidelines`
     * into the system prompt, and deactivating strips them: in Pi, tool gating
     * and instruction injection are the same lever.
     */
    const setWorkflowMode = (enabled: boolean): void => {
      if (!isRuntimeActive()) return;
      const active = new Set(pi.getActiveTools());
      for (const name of WORKFLOW_PI_TOOL_NAMES) {
        if (enabled) active.add(name);
        else active.delete(name);
      }
      pi.setActiveTools([...active]);
      workflowMode = enabled;
      // Published here rather than in refreshStatus so the label lands with the
      // toggle: the status refresh is an async registry read, and a label that
      // waits for it looks like the command did nothing.
      publishModeWidget();
      options.onModeChange?.(enabled);
    };

    /**
     * What the user sees on every mode change.
     *
     * Leads with the state, then the one thing they can do next. Turning the
     * mode on is useless without knowing that you now just ask in plain
     * language, so that sentence earns its place; the tool count does not, and
     * is left to the README.
     */
    const modeSummary = (): string =>
      workflowMode
        ? [
            `${GLYPH.completed} Workflow mode on`,
            'Ask for workflows in plain language: the agent can list, launch, inspect, pause, resume, stop, and recover runs.',
            `${shortcutLabel(UNFOLLOW_SHORTCUT)} stops following a run without stopping it.`,
          ].join('\n')
        : [
            'Workflow mode off',
            `Press ${LEADER_MODE_BREADCRUMB} to give the agent its workflow tools. Runs already going are unaffected.`,
          ].join('\n');

    /**
     * Toggle the mode from the leader menu.
     *
     * Replaces the `/workflow [on|off|status]` command: the mode line already
     * answers `status` at a glance, and the other two arguments were a keyboard
     * path to a switch the leader menu spells out. Plan mode is reached the same
     * way, so the two modes are no longer toggled through different surfaces.
     */
    const applyWorkflowMode = async (enabled: boolean, ctx: ExtensionContext): Promise<void> => {
      setWorkflowMode(enabled);
      if (!workflowMode) clearFollow(ctx);
      ctx.ui.notify(modeSummary(), 'info');
      // Both directions: turning off has to clear the indicator, not just leave
      // the last one on screen until the monitor next fires.
      await refreshStatus(ctx, false);
    };

    // Zero palette cost, unlike a command. Guarded on an active follow so it
    // does not swallow the key when there is nothing to dismiss.
    pi.registerShortcut(UNFOLLOW_SHORTCUT, {
      description: 'Open workflows or move typing between a workflow run and this session',
      handler: async (ctx) => {
        await waitForReadiness();
        // With a panel up this is a focus toggle, not a dismissal: the run stays
        // visible either way, and the user is only choosing who receives keys.
        const handle = activeOverlay?.handle;
        if (handle) {
          // pi-tui's `focus()` does not honour `nonCapturing`, so a view-only
          // panel would take the keyboard if this were left to fall through,
          // and every key after it would vanish into a run that cannot hear it.
          if (!activeOverlay?.interactive) {
            ctx.ui.notify('This run is hosted natively, so the view takes no typing. Your keys stay here.', 'info');
            return;
          }
          if (handle.isFocused()) {
            handle.unfocus();
            ctx.ui.notify('Typing goes to this session. The run keeps going.', 'info');
          } else {
            handle.focus();
            ctx.ui.notify(`Typing goes to ${activeOverlay?.runKey}.`, 'info');
          }
          return;
        }
        if (followedRun) {
          clearFollow(ctx);
          ctx.ui.notify('Workflow continues in the background.', 'info');
          return;
        }
        await openInspector(ctx);
      },
    });

    // Dismissing is its own key because the panel cannot use Escape: a focused
    // panel forwards every key to the run so its agent stays interruptible.
    pi.registerShortcut(CLOSE_OVERLAY_SHORTCUT, {
      description: 'Close the workflow run view',
      handler: async (ctx) => {
        await waitForReadiness();
        // Guarded so the key falls through to Pi when no panel is up.
        if (!activeOverlay) return;
        const runKey = activeOverlay.runKey;
        closeOverlay();
        ctx.ui.notify(`Closed the ${runKey} view. The run keeps going.`, 'info');
      },
    });

    // A battery-included mode must not add model-visible skills while dormant.
    // Discovery follows session_start, so environment-driven dispatcher
    // activation is visible at startup while the normal parent remains neutral.
    // The existence guard also fails closed if packaging ever drops the skill.
    pi.on('resources_discover', () => {
      if (!workflowMode) return { skillPaths: [] };
      const skillPath = resolve(dirname(fileURLToPath(import.meta.url)), SKILL_RELATIVE_PATH);
      return { skillPaths: existsSync(skillPath) ? [skillPath] : [] };
    });

    registerWorkflowFinishedRenderer(pi);

    pi.registerMessageRenderer(LEGACY_WORKFLOW_STEP_MESSAGE, (message, { outputPad }, theme) => {
      const details = isWorkflowStepMessageDetails(message.details) ? message.details : undefined;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      return renderWorkflowStepMessage(details, content, outputPad, theme);
    });

    registerWorkflowPiTools(readinessPi, {
      runTool,
      recoverTool,
      launchExecutor,
      controlTool,
      requireSessionRun: requireRun,
      requireRecoverableRun,
      readRecoveryEvidence: readRecoverableRunEvidence,
      delegateRecovery,
      trackPendingRun,
      observeSession,
      activeRunCount: async () => sessionRunCount,
      onLaunch: async (ctx) => {
        await getTelemetry(ctx).recordEvent(LAUNCH_REQUESTED_EVENT, { outcome: 'requested' });
        return refreshStatus(ctx, false);
      },
      followRun: async (input, ctx) => {
        const record = await requireRun(input, ctx.sessionManager.getSessionId());
        await getTelemetry(ctx).recordEvent('doom_workflow.follow_started', { outcome: 'started' });
        await followRun(record, ctx);
        return `Following ${runLabel(record)}. Press ${shortcutLabel(UNFOLLOW_SHORTCUT)} to stop following; the run keeps going.`;
      },
      tailRun: async (input, ctx) => {
        const record = await requireRun(input, ctx.sessionManager.getSessionId());
        await getTelemetry(ctx).recordEvent('doom_workflow.tail_requested', { outcome: 'requested' });
        return [
          `Workflow: ${runLabel(record)}`,
          `Stage: ${stageLabel(record)}`,
          'Raw launcher output is hidden from chat. Use action follow or open to view it.',
        ].join('\n');
      },
      openRun: async (input, ctx) => {
        const record = await requireRun(input, ctx.sessionManager.getSessionId());
        await getTelemetry(ctx).recordEvent('doom_workflow.open_requested', { outcome: 'requested' });
        // Without a UI there is nothing to foreground, so fall back to handing
        // the user's own terminal to the launcher.
        if (!ctx.hasUI) return openLauncher(record);
        return openOverlay(record, ctx);
      },
      rejectRunner,
    });

    let disposeLeaderActions: (() => void) | undefined;
    options.cordis?.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const dispose = requireDoomUiHub(uiContext).registerLeaderActions<ExtensionContext>({
        source: PACKAGE_SOURCE,
        handlers: {
          [LEADER_ENABLE_ACTION]: async (ctx) => {
            await waitForReadiness();
            return applyWorkflowMode(true, ctx);
          },
          [LEADER_DISABLE_ACTION]: async (ctx) => {
            await waitForReadiness();
            return applyWorkflowMode(false, ctx);
          },
          [LEADER_MANAGE_ACTION]: async (ctx) => {
            await waitForReadiness();
            return openInspector(ctx, true);
          },
          [LEADER_CATALOG_ACTION]: async (ctx) => {
            await waitForReadiness();
            return openWorkflowCatalog(ctx);
          },
          [LEADER_RECOVER_ACTION]: async (ctx) => {
            await waitForReadiness();
            return openRecoveryHandoff(ctx);
          },
        },
        onError: (error, _actionName, ctx) => {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        },
      });
      disposeLeaderActions = dispose;
      return () => {
        dispose();
        if (disposeLeaderActions === dispose) disposeLeaderActions = undefined;
      };
    });

    pi.on('session_start', (_event, ctx) => {
      if (!runtimeActive || !invocationActive()) return;
      const generation = ++sessionGeneration;
      const previousReadiness = readinessHandle;
      readinessAbort?.abort();
      const ownReadinessAbort = new AbortController();
      readinessAbort = ownReadinessAbort;
      sessionCtx = ctx;
      const ownsSession = (): boolean =>
        runtimeActive && generation === sessionGeneration && sessionCtx === ctx && invocationActive();

      // A second start retires every resource tied to the previous context
      // before this context can publish its own state.
      stopRunControl();
      if (monitorTimer) clearInterval(monitorTimer);
      monitorTimer = undefined;
      runProvider?.update([]);
      clearFollow(ctx);
      inspectorHandle?.hide();
      inspectorHandle = undefined;
      inspectorOpen = false;
      inspectorRecords.clear();
      closeOverlay();
      terminals.forget(new Set());
      progressOverlay.setUICtx(ctx.ui);

      const activeTelemetry = getTelemetry(ctx);
      void activeTelemetry.recordEvent('doom_workflow.session_started', {
        mode: process.env.WORKFLOW_MCP_MODE === 'on' ? 'on' : 'off',
        outcome: 'started',
      });

      // Tools registered during extension init are auto-activated by Pi, so the
      // default-off state has to be applied here rather than by not registering.
      // WORKFLOW_MCP_MODE=on is the non-interactive dispatcher path.
      const sessionId = ctx.sessionManager.getSessionId();
      const rootSessionId = resolveRootSessionId(sessionId);
      observeSession(rootSessionId);
      sessionStartedAt = Date.now();
      lifecycleNarrationReady = false;
      previousStages = new Map<string, WorkflowStage>();
      pendingTerminalRuns.clear();
      deliveredTerminalRuns.clear();
      setWorkflowMode(options.initialMode ?? process.env.WORKFLOW_MCP_MODE === 'on');

      const coordinator = readinessCoordinator(ctx);
      readinessHandle = (async (): Promise<DoomReadinessHandle<void>> => {
        if (previousReadiness) {
          await Promise.allSettled([previousReadiness.then((handle) => handle.wait())]);
        }
        if (!ownsSession()) throw new Error('Workflow session initialization was superseded.');
        return coordinator.start(PACKAGE_SOURCE, `${runtimeGeneration}:${generation}`, async (signal) => {
          const retired = (): boolean => ownReadinessAbort.signal.aborted || !ownsSession();
          signal.throwIfAborted();
          if (retired()) return { value: undefined };

          // Subscribed before the first status read, so a transition landing
          // during startup is delivered rather than raced past.
          await startRunControl(ctx);
          signal.throwIfAborted();
          if (retired()) return { value: undefined };
          await refreshStatus(ctx, false);
          signal.throwIfAborted();
          if (retired()) return { value: undefined };
          lifecycleNarrationReady = true;
          // A fallback now, not the mechanism: the observer reports a change
          // within its own debounce, and this only bounds how long a change
          // nothing notified us about stays invisible.
          monitorTimer = setInterval(() => {
            if (ownsSession()) void refreshStatus(ctx, true);
          }, monitorIntervalMs);
          monitorTimer.unref?.();
          return { value: undefined };
        });
      })();
      // The coordinator host owns the single user-facing failure notification;
      // this observer only ensures an idle failed task is still handled.
      void Promise.allSettled([readinessHandle.then((handle) => handle.wait())]);
    });

    const runCleanup = async (label: string, cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        process.emitWarning(`Doom-workflow cleanup could not ${label}: ${String(error)}`);
      }
    };

    let disposal: Promise<void> | undefined;
    const dispose = (context: ExtensionContext | undefined = sessionCtx): Promise<void> => {
      disposal ??= (async () => {
        if (!runtimeActive) return;
        runtimeActive = false;
        sessionGeneration += 1;
        const pendingReadiness = readinessHandle;
        readinessHandle = undefined;
        readinessAbort?.abort();
        readinessAbort = undefined;
        await runCleanup('stop the workflow observer', stopRunControl);
        const ownedReadiness = standaloneReadiness;
        standaloneReadiness = undefined;
        if (ownedReadiness) {
          await runCleanup('dispose standalone workflow readiness', () => ownedReadiness.dispose());
        } else if (pendingReadiness) {
          await Promise.allSettled([pendingReadiness.then((handle) => handle.wait())]);
        }

        // A workflow without a `launch-command` runs its engine inside this
        // process. Interrupt it and wait only for the bounded finalization path.
        if (pendingInlineRuns.size > 0) {
          for (const service of [runService, recoverService]) {
            await runCleanup('interrupt an inline workflow', () =>
              service.interrupt('SIGTERM', { phase: 'workflow', source: 'pi-session-shutdown' }),
            );
          }
          await Promise.race([
            Promise.allSettled(pendingInlineRuns),
            new Promise((settle) => setTimeout(settle, SHUTDOWN_FINALIZE_TIMEOUT_MS).unref?.()),
          ]);
        }
        if (monitorTimer) clearInterval(monitorTimer);
        monitorTimer = undefined;
        if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
        statusRefreshTimer = undefined;
        const provider = runProvider;
        runProvider = undefined;
        if (provider) await runCleanup('unregister the background-work provider', () => provider.dispose());
        lifecycleNarrationReady = false;
        inspectorHandle?.hide();
        inspectorHandle = undefined;
        inspectorOpen = false;
        inspectorRecords.clear();
        terminals.forget(new Set());
        closeOverlay();
        sessionRunCount = 0;
        if (context) clearFollow(context);
        else if (followTimer) clearInterval(followTimer);
        followTimer = undefined;
        followedRun = undefined;
        progressOverlay.dispose();
        workflowMode = false;
        publishedWorkflowState = undefined;
        const mode = modeContribution;
        modeContribution = undefined;
        if (mode) {
          await runCleanup('publish the inactive workflow mode', () => mode.publish(workflowModeState(false, 0)));
          await runCleanup('dispose the workflow mode owner', () => mode.dispose());
        }
        const leaderActions = disposeLeaderActions;
        disposeLeaderActions = undefined;
        if (leaderActions) await runCleanup('dispose workflow leader actions', leaderActions);
        const pendingCount = pendingInlineRuns.size;
        const activeTelemetry = telemetry;
        telemetry = undefined;
        if (activeTelemetry) {
          await runCleanup('record the workflow session finish', () =>
            activeTelemetry.recordEvent('doom_workflow.session_finished', {
              'workflow.pending_count': pendingCount,
              outcome: pendingCount === 0 ? 'completed' : 'interrupted',
            }),
          );
          await runCleanup('stop workflow telemetry', () => activeTelemetry.shutdown());
        }
        pendingInlineRuns.clear();
        pendingTerminalRuns.clear();
        deliveredTerminalRuns.clear();
        announcedRuns.length = 0;
        knownSessionId = undefined;
        sessionCtx = undefined;
      })();
      return disposal;
    };

    return { dispose };
  };
}

/** Direct installer retained for focused tests; the public factory uses Cordis ownership. */
export function createWorkflowPiExtension(options: WorkflowPiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const runtime = installWorkflowPiRuntime(options)(pi);
    pi.on('session_shutdown', (_event, context) => runtime.dispose(context));
  };
}
