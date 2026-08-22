import path from 'node:path';
import { connectDoomCordisHost, type DoomCordisHostMode } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { readDoomMcpStatus } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  createMinorModeCatalogClient,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_UI_HUB_SERVICE } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  type DoomToolOverrideRegistration,
  requireDoomToolOverrides,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent';
import { type DoomLeaderDiagnostic, DoomLeaderRegistry } from '../../services/leader/leaderRegistry.ts';
import { createDoomUiHub } from '../../services/hub/uiHub.ts';
import { DoomUiState, type LeaderSnapshot, projectMinorModeRecords } from '../../services/state/uiState.ts';
import { buildToolSources, type McpServerStatus } from '../../services/tools/toolInventory.ts';
import { openConfigOverlay } from '../../tui/configOverlay.ts';
import { DoomEditor } from '../../tui/doomEditor.ts';
import { DoomFooter } from '../../tui/doomFooter.ts';
import { DoomHeader } from '../../tui/doomHeader.ts';
import { LeaderHints } from '../../tui/leaderHints.ts';
import { DEFAULT_THEME_NAME } from '../../tui/theme.ts';
import { openToolsOverlay } from '../../tui/toolsOverlay.ts';
import { createUiTelemetry, UI_EVENT, type UiTelemetry } from '../telemetry/logSinkTelemetry.ts';
import { extensionName, extensionToolSource } from './extensionName.ts';
import { registerBuiltinToolUi } from './toolOverrides.ts';

const LEADER_WIDGET_KEY = 'doom-pi-leader';
const TUI_MODE = 'tui';
const WIDGET_PLACEMENT = 'belowEditor';
const WARNING_STYLE = 'warning';
const THEME_ENVIRONMENT_KEY = 'DOOMPI_THEME';
const HOTKEYS_COMMAND = 'hotkeys';
const TOOLS_COMMAND = 'tools';
const CONFIG_COMMAND = 'config';
const SESSION_START_EVENT = 'session_start';
const SESSION_MESSAGE_ENTRY = 'message';
const INPUT_EVENT = 'input';
const INTERACTIVE_INPUT_SOURCE = 'interactive';
const SESSION_SHUTDOWN_EVENT = 'session_shutdown';
const TITLE_MESSAGE_MAX_LENGTH = 64;
const TITLE_PREFIX = 'doom-pi';
const BUILTIN_LEADER_COMMANDS = new Set([HOTKEYS_COMMAND]);
const PACKAGE_SOURCE = '@agimon-ai/doompi-ui';

function createMessageTitle(message: string, cwd: string): string | undefined {
  const normalizedMessage = message.trim().replace(/\s+/g, ' ');
  if (!normalizedMessage) return undefined;
  const messageTitle = normalizedMessage.slice(0, TITLE_MESSAGE_MAX_LENGTH).trimEnd();
  return `${TITLE_PREFIX} · ${messageTitle} · ${path.basename(cwd) || cwd}`;
}

interface UiPluginOptions {
  readonly pi: ExtensionAPI;
  readonly telemetry: UiTelemetry;
  readonly hostMode: DoomCordisHostMode;
}

function doomPiUiPlugin(cordis: Context, { pi, telemetry, hostMode }: UiPluginOptions): void {
  cordis.inject([DOOM_TOOL_OVERRIDES_SERVICE], (overridesContext) => {
    const toolOverrides = requireDoomToolOverrides(overridesContext);
    const registrations: DoomToolOverrideRegistration[] = [];
    const shouldRegister = (tool: string): boolean => {
      if (hostMode === 'composed') return true;
      const registration = toolOverrides.claim({ source: PACKAGE_SOURCE, tools: [tool] });
      if (registration.granted) registrations.push(registration);
      return registration.granted;
    };
    try {
      registerBuiltinToolUi(pi, process.cwd(), shouldRegister);
    } catch (error) {
      for (const registration of registrations) registration.dispose();
      throw error;
    }
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  });
  const uiState = new DoomUiState();
  const leaderRegistry = new DoomLeaderRegistry();
  const pendingDiagnostics = new Set<string>();
  let footerData: ReadonlyFooterDataProvider | undefined;
  let activeContext: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let hasSessionMessage = false;

  /**
   * Asks the MCP extension what it is currently connected to.
   *
   * No answer is a normal session: `--no-mcp` leaves nobody providing the query,
   * and the panel simply lists MCP tools under the extension that registered them.
   */
  const readMcpServers = (): readonly McpServerStatus[] | undefined => readDoomMcpStatus(cordis)?.getSnapshot().servers;

  pi.registerCommand(TOOLS_COMMAND, {
    description: 'Browse the tools available in this session',
    handler: async (_args, ctx) => {
      // Read at open time so a reconnected server or a plan-mode tool swap shows
      // up without restarting the session.
      const mcpServers = readMcpServers();
      const sources = buildToolSources({
        tools: pi.getAllTools(),
        activeTools: pi.getActiveTools(),
        ...(mcpServers ? { mcpServers } : {}),
        resolveExtensionName: extensionName,
        resolveExtensionToolSource: (toolName) => extensionToolSource(pi, toolName),
      });
      await openToolsOverlay(ctx, sources);
    },
  });

  pi.registerCommand(CONFIG_COMMAND, {
    description: 'Browse and change the settings extensions contribute',
    handler: async (_args, ctx) => {
      // The registry is passed live rather than snapshotted: a contributor can be
      // fetching or installing something while the panel is open, and that
      // progress is meant to land in it.
      await openConfigOverlay(ctx, hub.config);
    },
  });

  const reportDiagnostics = (diagnostics: readonly DoomLeaderDiagnostic[]): void => {
    for (const diagnostic of diagnostics) {
      const binding = diagnostic.bindingId ? ` (${diagnostic.bindingId})` : '';
      const message = `Leader contribution from ${diagnostic.source}${binding}: ${diagnostic.message}`;
      if (pendingDiagnostics.has(message)) continue;
      pendingDiagnostics.add(message);
      // A rejected contribution silently drops another extension's keybindings,
      // and the notice below only reaches a run that has a TUI attached.
      void telemetry.recordWarning(UI_EVENT.leaderContributionRejected, diagnostic.message, {
        'leader.source': diagnostic.source,
        ...(diagnostic.bindingId ? { 'leader.binding.id': diagnostic.bindingId } : {}),
      });
      if (activeContext?.mode === TUI_MODE) activeContext.ui.notify(message, WARNING_STYLE);
    }
  };

  const hub = createDoomUiHub({ leaderRegistry, reportDiagnostics });
  cordis.provide(DOOM_UI_HUB_SERVICE, hub);
  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
    const catalog = createMinorModeCatalogClient(requireMinorModeCatalog(modeContext));
    const update = (): void => uiState.setModes(projectMinorModeRecords(catalog.list()));
    const dispose = catalog.subscribe(update);
    update();
    return () => {
      dispose();
      uiState.setModes([]);
    };
  });

  pi.on(SESSION_START_EVENT, (_event, ctx) => {
    activeContext = ctx;
    hub.setContext(ctx);
    const activeGeneration = ++sessionGeneration;
    reportDiagnostics(leaderRegistry.flush());
    hasSessionMessage = ctx.sessionManager.getEntries().some((entry) => entry.type === SESSION_MESSAGE_ENTRY);
    if (ctx.mode !== TUI_MODE) return;
    for (const message of pendingDiagnostics) ctx.ui.notify(message, WARNING_STYLE);

    const themeName = process.env[THEME_ENVIRONMENT_KEY] || DEFAULT_THEME_NAME;
    const themeResult = ctx.ui.setTheme(themeName);
    if (!themeResult.success) {
      ctx.ui.notify(`Could not apply Doom Pi theme: ${themeResult.error}`, WARNING_STYLE);
      void telemetry.recordWarning(UI_EVENT.themeApplyFailed, themeResult.error ?? 'Unknown theme error', {
        'ui.theme': themeName,
      });
    }

    ctx.ui.setTitle(`${TITLE_PREFIX} · ${path.basename(ctx.cwd) || ctx.cwd} · pi/coding`);
    ctx.ui.setHeader((tui, theme) => new DoomHeader(theme, ctx.cwd, undefined, ctx, () => tui.terminal.rows));
    ctx.ui.setFooter((tui, theme, data) => {
      footerData = data;
      return new DoomFooter(tui, theme, ctx, data, hub.footer, uiState);
    });
    ctx.ui.setEditorComponent(
      (tui, editorTheme, keybindings) =>
        new DoomEditor(
          tui,
          editorTheme,
          keybindings,
          uiState,
          (snapshot: LeaderSnapshot) => {
            if (!snapshot.active) {
              ctx.ui.setWidget(LEADER_WIDGET_KEY, undefined, { placement: WIDGET_PLACEMENT });
              return;
            }
            ctx.ui.setWidget(
              LEADER_WIDGET_KEY,
              (_widgetTui, widgetTheme) => new LeaderHints(widgetTheme, snapshot, ctx, footerData, uiState.getModes()),
              { placement: WIDGET_PLACEMENT },
            );
          },
          undefined,
          ctx.ui.theme,
          {
            registry: leaderRegistry,
            isCommandAvailable: (commandName) =>
              BUILTIN_LEADER_COMMANDS.has(commandName) ||
              pi.getCommands().some((command) => command.name === commandName),
            onLeaderAction: (source, action) => {
              if (activeContext !== ctx || sessionGeneration !== activeGeneration) {
                ctx.ui.notify(`Leader action ${action} is unavailable.`, WARNING_STYLE);
                return;
              }
              hub.invokeLeaderAction(source, action);
            },
            onUnavailableCommand: (commandName) => {
              void telemetry.recordWarning(
                UI_EVENT.leaderCommandUnavailable,
                `Leader command /${commandName} is unavailable.`,
                { 'ui.kind': 'command' },
              );
              ctx.ui.notify(`Leader command /${commandName} is unavailable.`, WARNING_STYLE);
            },
            onUnavailableAction: (action) => {
              void telemetry.recordWarning(
                UI_EVENT.leaderActionUnavailable,
                `Leader action ${action} is unavailable.`,
                {
                  'ui.kind': 'action',
                },
              );
              ctx.ui.notify(`Leader action ${action} is unavailable.`, WARNING_STYLE);
            },
          },
        ),
    );

    void telemetry.recordEvent(UI_EVENT.shellInstalled, {
      'ui.theme': themeName,
      'ui.theme.applied': themeResult.success,
      'ui.leader.group.count': leaderRegistry.getGroup([])?.options.length ?? 0,
    });
  });

  pi.on(INPUT_EVENT, (event, ctx) => {
    if (ctx.mode !== TUI_MODE || event.source !== INTERACTIVE_INPUT_SOURCE || hasSessionMessage) return;
    hasSessionMessage = true;
    const title = createMessageTitle(event.text, ctx.cwd);
    if (title) ctx.ui.setTitle(title);
  });

  cordis.effect(
    () => async () => {
      const context = activeContext;
      ++sessionGeneration;
      activeContext = undefined;
      hub.setContext(undefined);
      footerData = undefined;
      hub.dispose();
      uiState.reset();
      if (context?.mode === TUI_MODE) {
        context.ui.setWidget(LEADER_WIDGET_KEY, undefined, { placement: WIDGET_PLACEMENT });
      }
      await telemetry.shutdown();
    },
    PACKAGE_SOURCE,
  );
}

/** The package's standard Pi factory, mounted under the session Cordis host. */
export async function doomPiUiExtension(pi: ExtensionAPI, telemetry: UiTelemetry = createUiTelemetry()): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(doomPiUiPlugin, { pi, telemetry, hostMode: connection.runtime.mode });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }

  let disposal: Promise<void> | undefined;
  pi.on(
    SESSION_SHUTDOWN_EVENT,
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}
