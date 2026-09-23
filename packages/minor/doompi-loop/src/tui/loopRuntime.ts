import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordisHost';
import type { DoomPluginTool, PiToolRestriction } from '@agimon-ai/doompi-core/piExtension';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/uiHub';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  ACTIVE_MODE_COLOR,
  LOOPS_GROUP_ORDER,
  MODE_STATUS_ID,
  NOTIFY_INFO_LEVEL,
  PACKAGE_SOURCE,
  STATUS_KEY,
} from '../constants/piLoop';
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  type DoomLoopLaunchersService,
  type LoopInstanceSnapshot,
  type LoopLauncherRegistration,
} from '../schemas/loopLaunchers';
import { createDefaultLoopLauncher } from '../services/defaultLoopLauncher';
import { createDoomLoopLaunchersService } from '../services/loopLaunchers';
import { createLoopTools } from '../services/loopTools';
import { formatLoopStatusView, LOOP_VIEW_STATUS_KEY } from '../types/loopView';
import { registerLeaderContribution } from './leader';
import { openLoopListOverlay } from './loopListOverlay';
import { openStartLoopOverlay } from './startLoopOverlay';

const MODE_ACTION_ACTIVATE = 'activate';
const MODE_ACTION_DEACTIVATE = 'deactivate';
const SESSION_REPLACED_REASON = 'Pi session replaced.';
const SESSION_SHUTDOWN_REASON = 'Pi session shut down.';

interface ActiveLoopSession {
  readonly context: ExtensionContext;
  readonly hostSession: DoomCordisSessionService;
  readonly launchers: DoomLoopLaunchersService;
}

function loopModeState(enabled: boolean, instances: readonly LoopInstanceSnapshot[]): MinorModeState {
  return {
    activation: enabled ? 'active' : 'inactive',
    condition: 'ready',
    ...(enabled ? { detail: `${instances.length} loops`, color: ACTIVE_MODE_COLOR } : {}),
    actions: [
      {
        id: MODE_ACTION_ACTIVATE,
        enabled: !enabled,
        ...(enabled ? { disabledReason: 'Loop mode is already active.' } : {}),
      },
      { id: MODE_ACTION_DEACTIVATE, enabled, ...(enabled ? {} : { disabledReason: 'Loop mode is not active.' }) },
    ],
  };
}

import type { LoopCommandHandlers } from '../types/loopCommand';
interface LoopPiRuntime {
  onAgentSettled(this: void): void;
  services: Array<(context: Context) => void>;
  handlers: LoopCommandHandlers;
  minorModes: MinorModeOwner[];
  loopTools: readonly DoomPluginTool[];
  toolRestrictions: readonly PiToolRestriction[];
  onDispose(): void;
}
/** Install Loop state and external resources into its host-owned Cordis plugin fiber. */
export function createLoopPiRuntime(pi: ExtensionAPI): LoopPiRuntime {
  let active = true;
  let activeSession: ActiveLoopSession | undefined;
  let mode: MinorModeOwner | undefined;
  let disposeLeader: (() => void) | undefined;
  const launchesInProgress = new WeakSet<ActiveLoopSession>();
  let modeEnabled = false;
  const toolListeners = new Set<() => void>();
  const loopTools = createLoopTools(
    () => {
      if (!activeSession) throw new Error('Loop launchers are unavailable for the active session.');
      return activeSession.launchers;
    },
    () => {
      if (!active || !modeEnabled) throw new Error('Enable Loop minor mode before using agent loop tools.');
    },
  );
  const toolNames = new Set(loopTools.map((tool) => tool.name));

  const currentSession = (context: ExtensionContext): ActiveLoopSession | undefined => {
    const binding = activeSession;
    if (
      !active ||
      !binding ||
      binding.context.sessionManager !== context.sessionManager ||
      binding.hostSession.sessionId !== context.sessionManager.getSessionId()
    ) {
      return undefined;
    }
    return binding;
  };

  const clearStatuses = (binding: ActiveLoopSession): void => {
    binding.context.ui?.setStatus(STATUS_KEY, undefined);
    if (binding.context.mode !== 'tui') binding.context.ui?.setStatus(LOOP_VIEW_STATUS_KEY, undefined);
  };
  const publishStatus = (binding: ActiveLoopSession): void => {
    if (!active || activeSession !== binding) return;
    const instances = binding.launchers.listInstances();
    binding.context.ui?.setStatus(STATUS_KEY, instances.length ? `loops: ${instances.length}` : undefined);
    if (binding.context.mode !== 'tui') {
      binding.context.ui?.setStatus(LOOP_VIEW_STATUS_KEY, formatLoopStatusView(instances));
    }
    mode?.publish();
  };

  const defaultLauncher = createDefaultLoopLauncher(pi);

  mode = defineMinorMode({
    descriptor: {
      source: PACKAGE_SOURCE,
      id: MODE_STATUS_ID,
      label: 'Loop',
      description: 'Give the agent tools to create, inspect, and stop session loops.',
      order: LOOPS_GROUP_ORDER,
      actions: [
        {
          id: MODE_ACTION_ACTIVATE,
          label: 'Activate',
          description: 'Expose loop tools to the agent.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
        {
          id: MODE_ACTION_DEACTIVATE,
          label: 'Deactivate',
          description: 'Hide agent loop tools. Existing loops and manual controls remain available.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
      ],
    },
    state: () => loopModeState(modeEnabled, activeSession?.launchers.listInstances() ?? []),
    async handleAction(_runtime, actionId, _arguments, { signal }) {
      signal.throwIfAborted();
      const binding = activeSession ? currentSession(activeSession.context) : undefined;
      if (!binding) throw new Error('Loop launchers are unavailable for the active session.');
      if (actionId !== MODE_ACTION_ACTIVATE && actionId !== MODE_ACTION_DEACTIVATE)
        throw new Error(`Unknown loop mode action: ${actionId}`);
      modeEnabled = actionId === MODE_ACTION_ACTIVATE;
      for (const listener of toolListeners) listener();
      publishStatus(binding);
      return {
        message: modeEnabled ? 'Loop tools activated.' : 'Loop tools deactivated. Existing loops are unchanged.',
      };
    },
  }).createOwner(undefined);
  return {
    onAgentSettled: defaultLauncher.onAgentSettled,
    loopTools,
    toolRestrictions: [
      {
        source: PACKAGE_SOURCE,
        restrict: (incoming) => (modeEnabled ? incoming : incoming.filter((name) => !toolNames.has(name))),
        subscribe(listener) {
          toolListeners.add(listener);
          return () => {
            toolListeners.delete(listener);
          };
        },
      },
    ],
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
          const dispose = registerLeaderContribution(requireDoomUiHub(uiContext));
          disposeLeader = dispose;
          return () => {
            dispose();
            if (disposeLeader === dispose) disposeLeader = undefined;
          };
        });

        cordis.inject([DOOM_CORDIS_SESSION_SERVICE], async (sessionContext) => {
          const hostSession = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
          const launchers = createDoomLoopLaunchersService({
            generation: `${hostSession.generation}:loop-launchers`,
            createInstanceId: () => crypto.randomUUID(),
            timestamp: () => new Date().toISOString(),
          });
          const binding: ActiveLoopSession = { context: hostSession.context, hostSession, launchers };
          activeSession = binding;
          modeEnabled = false;
          for (const listener of toolListeners) listener();
          const provider = cordis.plugin((providerContext) => {
            providerContext.provide(DOOM_LOOP_LAUNCHERS_SERVICE, launchers);
          });

          let defaultRegistration: LoopLauncherRegistration;
          let cronRegistration: LoopLauncherRegistration;
          let unsubscribe: () => void;
          try {
            defaultRegistration = defaultLauncher.register(hostSession.context, launchers);
            cronRegistration = defaultLauncher.registerCron(hostSession.context, launchers);
            unsubscribe = launchers.subscribe(() => publishStatus(binding));
            publishStatus(binding);
          } catch (error) {
            if (activeSession === binding) activeSession = undefined;
            await launchers.dispose(SESSION_REPLACED_REASON);
            await provider.dispose();
            throw error;
          }

          return async () => {
            if (activeSession === binding) activeSession = undefined;
            modeEnabled = false;
            for (const listener of toolListeners) listener();
            unsubscribe();
            clearStatuses(binding);
            mode?.publish();
            const cleanupErrors: unknown[] = [];
            try {
              await Promise.all([
                defaultRegistration.dispose(SESSION_REPLACED_REASON),
                cronRegistration.dispose(SESSION_REPLACED_REASON),
              ]);
            } catch (error) {
              cleanupErrors.push(error);
            }
            try {
              await launchers.dispose(SESSION_SHUTDOWN_REASON);
            } catch (error) {
              cleanupErrors.push(error);
            }
            try {
              await provider.dispose();
            } catch (error) {
              cleanupErrors.push(error);
            }
            if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Loop session cleanup failed.');
          };
        });
      },
    ],
    handlers: {
      async start(ctx, args) {
        const binding = currentSession(ctx);
        if (!binding) return;
        if (launchesInProgress.has(binding)) {
          ctx.ui.notify('A loop setup is already in progress.', NOTIFY_INFO_LEVEL);
          return;
        }
        launchesInProgress.add(binding);
        try {
          const launchers = binding.launchers.listLaunchers();
          if (!launchers.length) {
            ctx.ui.notify('No loop launchers are registered for this session.', NOTIFY_INFO_LEVEL);
            return;
          }

          const argument = args.trim();
          let launcherId: string | undefined;
          if (argument) {
            if (argument.split(/\s+/u).length !== 1) {
              ctx.ui.notify('Usage: /loop [launcherId]', 'error');
              return;
            }
            if (!launchers.some((launcher) => launcher.id === argument)) {
              ctx.ui.notify(`Unknown loop launcher: ${argument}`, 'error');
              return;
            }
            launcherId = argument;
          } else {
            launcherId = await openStartLoopOverlay(ctx, launchers);
            if (activeSession !== binding || !launcherId) return;
          }

          const instance = await binding.launchers.launch(launcherId);
          if (activeSession !== binding) return;
          if (instance) ctx.ui.notify(`${instance.label ?? instance.launcherLabel} started.`, NOTIFY_INFO_LEVEL);
        } catch (error) {
          if (activeSession !== binding) return;
          ctx.ui.notify(`Loop could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
        } finally {
          launchesInProgress.delete(binding);
        }
      },
      async list(ctx, args = '') {
        const binding = currentSession(ctx);
        if (!binding) return;
        if (args.trim().startsWith('stop ')) {
          const stopped = await binding.launchers.stop(args.trim().slice(5).trim(), 'Stopped manually.');
          ctx.ui.notify(stopped ? 'Loop stopped.' : 'Loop instance was not active.', NOTIFY_INFO_LEVEL);
          return;
        }
        if (args.trim()) throw new Error('Usage: /loops [stop instanceId]');
        await openLoopListOverlay(ctx, binding.launchers);
      },
    },
    minorModes: [mode],
    onDispose() {
      active = false;
      const binding = activeSession;
      activeSession = undefined;
      modeEnabled = false;
      for (const listener of toolListeners) listener();
      toolListeners.clear();
      if (binding) clearStatuses(binding);
      mode?.publish();
      disposeLeader?.();
      disposeLeader = undefined;
    },
  };
}
