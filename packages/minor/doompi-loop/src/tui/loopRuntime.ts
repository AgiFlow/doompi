import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  type DoomLoopLaunchersService,
  type LoopInstanceSnapshot,
  type LoopLauncherRegistration,
  type LoopLauncherSummary,
} from '../schemas/loopLaunchers';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createDoomLoopLaunchersService } from '../services/loopLaunchers';
import { openLoopListOverlay } from './loopListOverlay';
import { openStartLoopOverlay } from './startLoopOverlay';
import { formatLoopStatusView, LOOP_VIEW_STATUS_KEY } from '../types/loopView';
import { createDefaultLoopLauncher } from '../services/defaultLoopLauncher';
import { registerLeaderContribution } from './leader';
import {
  ACTIVE_MODE_COLOR,
  LOOPS_GROUP_ORDER,
  MODE_STATUS_ID,
  NOTIFY_INFO_LEVEL,
  PACKAGE_SOURCE,
  STATUS_KEY,
} from '../constants/piLoop';

const MODE_ACTION_START = 'start';
const MODE_ACTION_STOP = 'stop';
const SESSION_REPLACED_REASON = 'Pi session replaced.';
const SESSION_SHUTDOWN_REASON = 'Pi session shut down.';

interface ActiveLoopSession {
  readonly context: ExtensionContext;
  readonly hostSession: DoomCordisSessionService;
  readonly launchers: DoomLoopLaunchersService;
}

function loopModeState(
  launchers: readonly LoopLauncherSummary[],
  instances: readonly LoopInstanceSnapshot[],
): MinorModeState {
  const active = instances.length > 0;
  return {
    activation: active ? 'active' : 'inactive',
    condition: instances.some(({ state }) => state === 'starting' || state === 'stopping') ? 'queued' : 'ready',
    ...(active ? { detail: `${instances.length} active`, color: ACTIVE_MODE_COLOR } : {}),
    actions: [
      ...(launchers.length > 0
        ? [{ id: MODE_ACTION_START, enabled: true } as const]
        : [{ id: MODE_ACTION_START, enabled: false, disabledReason: 'No loop launchers are registered.' } as const]),
      ...(active
        ? [{ id: MODE_ACTION_STOP, enabled: true } as const]
        : [{ id: MODE_ACTION_STOP, enabled: false, disabledReason: 'No loops are active.' } as const]),
    ],
  };
}

import type { LoopCommandHandlers } from '../types/loopCommand';
interface LoopPiRuntime {
  onAgentSettled(this: void): void;
  services: Array<(context: Context) => void>;
  handlers: LoopCommandHandlers;
  minorModes: MinorModeOwner[];
  onDispose(): void;
}
/** Install Loop state and external resources into its host-owned Cordis plugin fiber. */
export function createLoopPiRuntime(pi: ExtensionAPI): LoopPiRuntime {
  let active = true;
  let activeSession: ActiveLoopSession | undefined;
  let mode: MinorModeOwner | undefined;
  let disposeLeader: (() => void) | undefined;
  const launchesInProgress = new WeakSet<ActiveLoopSession>();

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
      description: 'Session-scoped recurring prompt loops.',
      order: LOOPS_GROUP_ORDER,
      actions: [
        {
          id: MODE_ACTION_START,
          label: 'Start',
          description: 'Start a loop with a registered launcher.',
          contexts: ['tui', 'headless'],
          parameters: [
            { name: 'launcherId', label: 'Launcher', kind: 'string', required: true, minLength: 1 },
            { name: 'instanceId', label: 'Instance ID', kind: 'string', required: false, minLength: 1 },
          ],
        },
        {
          id: MODE_ACTION_STOP,
          label: 'Stop',
          description: 'Stop one active loop instance.',
          contexts: ['tui', 'headless'],
          parameters: [
            { name: 'instanceId', label: 'Instance ID', kind: 'string', required: true, minLength: 1 },
            { name: 'reason', label: 'Reason', kind: 'string', required: false, minLength: 1 },
          ],
        },
      ],
    },
    state: () =>
      activeSession
        ? loopModeState(activeSession.launchers.listLaunchers(), activeSession.launchers.listInstances())
        : loopModeState([], []),
    async handleAction(_runtime, actionId, argumentsValue, { signal }) {
      signal.throwIfAborted();
      const binding = activeSession ? currentSession(activeSession.context) : undefined;
      if (!binding) throw new Error('Loop launchers are unavailable for the active session.');
      if (actionId === MODE_ACTION_START) {
        const instance = await binding.launchers.launch(
          argumentsValue.launcherId as string,
          argumentsValue.instanceId ? { instanceId: argumentsValue.instanceId as string } : {},
        );
        if (activeSession !== binding) throw new Error('Loop action became stale.');
        return { message: instance ? `Loop '${instance.instanceId}' started.` : 'Loop launch was cancelled.' };
      }
      if (actionId === MODE_ACTION_STOP) {
        const stopped = await binding.launchers.stop(
          argumentsValue.instanceId as string,
          (argumentsValue.reason as string | undefined) ?? 'Stopped through minor_mode.',
        );
        if (activeSession !== binding) throw new Error('Loop action became stale.');
        return { message: stopped ? 'Loop stopped.' : 'Loop instance was not active.' };
      }
      throw new Error(`Unknown loop mode action: ${actionId}`);
    },
  }).createOwner(undefined);
  return {
    onAgentSettled: defaultLauncher.onAgentSettled,
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
          sessionContext.provide(DOOM_LOOP_LAUNCHERS_SERVICE, launchers);

          let defaultRegistration: LoopLauncherRegistration;
          let unsubscribe: () => void;
          try {
            defaultRegistration = defaultLauncher.register(hostSession.context, launchers);
            unsubscribe = launchers.subscribe(() => publishStatus(binding));
            publishStatus(binding);
          } catch (error) {
            if (activeSession === binding) activeSession = undefined;
            await launchers.dispose(SESSION_REPLACED_REASON);
            throw error;
          }

          return async () => {
            if (activeSession === binding) activeSession = undefined;
            unsubscribe();
            clearStatuses(binding);
            mode?.publish();
            const cleanupErrors: unknown[] = [];
            try {
              await defaultRegistration.dispose(SESSION_REPLACED_REASON);
            } catch (error) {
              cleanupErrors.push(error);
            }
            try {
              await launchers.dispose(SESSION_SHUTDOWN_REASON);
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
      async list(ctx) {
        const binding = currentSession(ctx);
        if (!binding) return;
        await openLoopListOverlay(ctx, binding.launchers);
      },
    },
    minorModes: [mode],
    onDispose() {
      active = false;
      const binding = activeSession;
      activeSession = undefined;
      if (binding) clearStatuses(binding);
      mode?.publish();
      disposeLeader?.();
      disposeLeader = undefined;
    },
  };
}
