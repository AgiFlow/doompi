import {
  LEADER_WIDGET_KEY,
  TUI_MODE,
  WIDGET_PLACEMENT,
  WARNING_STYLE,
  THEME_ENVIRONMENT_KEY,
  TOOLS_COMMAND,
  CONFIG_COMMAND,
  SESSION_START_EVENT,
  SESSION_MESSAGE_ENTRY,
  INPUT_EVENT,
  INTERACTIVE_INPUT_SOURCE,
  TITLE_MESSAGE_MAX_LENGTH,
  TITLE_PREFIX,
  BUILTIN_LEADER_COMMANDS,
} from '../constants/ui';
import path from 'node:path';
import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { readDoomMcpStatus } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import {
  type DoomNotificationLevel,
  readDoomNotificationService,
} from '@agimon-ai/doompi-extension-contracts/notification';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent';
import { type DoomLeaderDiagnostic, DoomLeaderRegistry } from '../services/leaderRegistry';
import { createDoomUiHub } from '../services/uiHub';
import { DoomUiState, type LeaderSnapshot } from '../models/uiState';
import { buildToolSources, type McpServerStatus } from '../services/toolInventory';
import { openConfigOverlay } from './configOverlay';
import { DoomEditor } from './doomEditor';
import { DoomFooter } from './doomFooter';
import { DoomHeader } from './doomHeader';
import { LeaderHints } from './leaderHints';
import { DEFAULT_THEME_NAME } from './theme';
import { openToolsOverlay } from './toolsOverlay';
import { UI_EVENT, type UiTelemetry } from '../services/telemetry';
import { extensionName, extensionPackageName, extensionToolSource } from '../services/extensionSource';

function notify(cordis: Context, context: ExtensionContext, body: string, level: DoomNotificationLevel): void {
  const service = readDoomNotificationService(cordis);
  if (service) {
    try {
      void Promise.resolve(service.request({ body, level })).catch(() => undefined);
    } catch {
      // Notification delivery is best effort and does not fall back after routing.
    }
    return;
  }
  context.ui.notify(body, level);
}

function createMessageTitle(message: string, cwd: string): string | undefined {
  const normalizedMessage = message.trim().replace(/\s+/g, ' ');
  if (!normalizedMessage) return undefined;
  const messageTitle = normalizedMessage.slice(0, TITLE_MESSAGE_MAX_LENGTH).trimEnd();
  return `${TITLE_PREFIX} · ${messageTitle} · ${path.basename(cwd) || cwd}`;
}

interface UiPluginOptions {
  readonly pi: ExtensionAPI;
  readonly telemetry: UiTelemetry;
}

export interface UiRuntime {
  readonly hub: ReturnType<typeof createDoomUiHub>;
  readonly uiState: DoomUiState;
  readonly commands: readonly (readonly [...Parameters<ExtensionAPI['registerCommand']>])[];
  readonly events: PiEventHandlers;
  dispose(): Promise<void>;
}

export function createUiRuntime(cordis: Context, { pi, telemetry }: UiPluginOptions): UiRuntime {
  let disposed = false;
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
      if (activeContext?.mode === TUI_MODE) notify(cordis, activeContext, message, WARNING_STYLE);
    }
  };

  const hub = createDoomUiHub({ leaderRegistry, reportDiagnostics });
  return {
    hub,
    uiState,
    async dispose() {
      if (disposed) return;
      disposed = true;
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
    commands: [
      [
        TOOLS_COMMAND,
        {
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
              resolveExtensionPackageName: extensionPackageName,
              resolveExtensionToolSource: (toolName) => extensionToolSource(pi, toolName),
            });
            await openToolsOverlay(ctx, sources);
          },
        },
      ],

      [
        CONFIG_COMMAND,
        {
          description: 'Browse and change the settings extensions contribute',
          handler: async (_args, ctx) => {
            // The registry is passed live rather than snapshotted: a contributor can be
            // fetching or installing something while the panel is open, and that
            // progress is meant to land in it.
            await openConfigOverlay(ctx, hub.config);
          },
        },
      ],
    ],
    events: {
      [SESSION_START_EVENT]: (_event, ctx) => {
        activeContext = ctx;
        hub.setContext(ctx);
        const activeGeneration = ++sessionGeneration;
        reportDiagnostics(leaderRegistry.flush());
        hasSessionMessage = ctx.sessionManager.getEntries().some((entry) => entry.type === SESSION_MESSAGE_ENTRY);
        if (ctx.mode !== TUI_MODE) return;
        for (const message of pendingDiagnostics) notify(cordis, ctx, message, WARNING_STYLE);

        const themeName = process.env[THEME_ENVIRONMENT_KEY] || DEFAULT_THEME_NAME;
        const themeResult = ctx.ui.setTheme(themeName);
        if (!themeResult.success) {
          notify(cordis, ctx, `Could not apply Doom Pi theme: ${themeResult.error}`, WARNING_STYLE);
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
                  (_widgetTui, widgetTheme) =>
                    new LeaderHints(widgetTheme, snapshot, ctx, footerData, uiState.getModes()),
                  { placement: WIDGET_PLACEMENT },
                );
              },
              undefined,
              ctx.ui.theme,
              {
                registry: leaderRegistry,
                isCommandAvailable: (commandName) =>
                  BUILTIN_LEADER_COMMANDS.includes(commandName) ||
                  pi.getCommands().some((command) => command.name === commandName),
                onLeaderAction: (source, action) => {
                  if (activeContext !== ctx || sessionGeneration !== activeGeneration) {
                    notify(cordis, ctx, `Leader action ${action} is unavailable.`, WARNING_STYLE);
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
                  notify(cordis, ctx, `Leader command /${commandName} is unavailable.`, WARNING_STYLE);
                },
                onUnavailableAction: (action) => {
                  void telemetry.recordWarning(
                    UI_EVENT.leaderActionUnavailable,
                    `Leader action ${action} is unavailable.`,
                    {
                      'ui.kind': 'action',
                    },
                  );
                  notify(cordis, ctx, `Leader action ${action} is unavailable.`, WARNING_STYLE);
                },
              },
            ),
        );

        void telemetry.recordEvent(UI_EVENT.shellInstalled, {
          'ui.theme': themeName,
          'ui.theme.applied': themeResult.success,
          'ui.leader.group.count': leaderRegistry.getGroup([])?.options.length ?? 0,
        });
      },

      [INPUT_EVENT]: (event, ctx) => {
        if (ctx.mode !== TUI_MODE || event.source !== INTERACTIVE_INPUT_SOURCE || hasSessionMessage) return;
        hasSessionMessage = true;
        const title = createMessageTitle(event.text, ctx.cwd);
        if (title) ctx.ui.setTitle(title);
      },
    },
  };
}
