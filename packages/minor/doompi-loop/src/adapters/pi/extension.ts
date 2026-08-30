import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  type DoomLoopLaunchersService,
  type LoopInstanceSnapshot,
  type LoopLauncherRegistration,
  type LoopLauncherSummary,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerCommands } from '../../commands/loopCommand.ts';
import { createDoomLoopLaunchersService } from '../../services/loopLaunchers.ts';
import { openLoopListOverlay } from '../../tui/loopListOverlay.ts';
import { openStartLoopOverlay } from '../../tui/startLoopOverlay.ts';
import { formatLoopStatusView, LOOP_VIEW_STATUS_KEY } from '../../types/loopView.ts';
import { createDefaultLoopLauncher } from './defaultLoopLauncher.ts';
import { registerLeaderContribution } from './leader.ts';
import {
  ACTIVE_MODE_COLOR,
  LOOPS_GROUP_ORDER,
  MODE_STATUS_ID,
  NOTIFY_INFO_LEVEL,
  PACKAGE_SOURCE,
  STATUS_KEY,
} from './loopConstants.ts';

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

/** Install Loop state and external resources into its host-owned Cordis plugin fiber. */
export function installLoopRuntime(cordis: Context, pi: ExtensionAPI): void {
  let active = true;
  let activeSession: ActiveLoopSession | undefined;
  let mode: MinorModeOwnerHandle | undefined;
  let disposeLeader: (() => void) | undefined;

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
    const launchers = binding.launchers.listLaunchers();
    const instances = binding.launchers.listInstances();
    binding.context.ui?.setStatus(STATUS_KEY, instances.length ? `loops: ${instances.length}` : undefined);
    if (binding.context.mode !== 'tui') {
      binding.context.ui?.setStatus(LOOP_VIEW_STATUS_KEY, formatLoopStatusView(instances));
    }
    mode?.publish(loopModeState(launchers, instances));
  };

  cordis.effect(
    () => () => {
      active = false;
      const binding = activeSession;
      activeSession = undefined;
      if (binding) clearStatuses(binding);
      mode?.publish(loopModeState([], []));
      mode?.dispose();
      disposeLeader?.();
      disposeLeader = undefined;
      mode = undefined;
    },
    `${PACKAGE_SOURCE}/runtime`,
  );

  const defaultLauncher = createDefaultLoopLauncher(pi);
  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
    const owner = registerMinorModeOwner<ExtensionContext>(requireMinorModeCatalog(modeContext), {
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
      initialState: loopModeState([], []),
      async handleAction(actionId, argumentsValue, execution) {
        const binding = currentSession(execution.context);
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
    });
    mode = owner;
    const binding = activeSession;
    if (binding) publishStatus(binding);
    return () => {
      owner.dispose();
      if (mode === owner) mode = undefined;
    };
  });
  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const dispose = registerLeaderContribution(requireDoomUiHub(uiContext));
    disposeLeader = dispose;
    return () => {
      dispose();
      if (disposeLeader === dispose) disposeLeader = undefined;
    };
  });

  registerCommands(pi, {
    async start(ctx) {
      const binding = currentSession(ctx);
      if (!binding) return;
      const launchers = binding.launchers.listLaunchers();
      if (!launchers.length) {
        ctx.ui.notify('No loop launchers are registered for this session.', NOTIFY_INFO_LEVEL);
        return;
      }
      const launcherId = await openStartLoopOverlay(ctx, launchers);
      if (activeSession !== binding || !launcherId) return;
      try {
        const instance = await binding.launchers.launch(launcherId);
        if (activeSession !== binding) return;
        if (instance) ctx.ui.notify(`${instance.label ?? instance.launcherLabel} started.`, NOTIFY_INFO_LEVEL);
      } catch (error) {
        if (activeSession !== binding) return;
        ctx.ui.notify(`Loop could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
    async list(ctx) {
      const binding = currentSession(ctx);
      if (!binding) return;
      await openLoopListOverlay(ctx, binding.launchers);
    },
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
      mode?.publish(loopModeState([], []));
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
}

/** The package's single standard Pi factory. */
export async function loopExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(loopPlugin, { pi });
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
    'session_shutdown',
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

interface LoopPluginConfig {
  readonly pi: ExtensionAPI;
}

function loopPlugin(cordis: Context, config: LoopPluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-loop',
          description: 'Use Doom Pi Loop to start, inspect, and stop session-scoped recurring prompts safely.',
        },
      ],
    });
    return () => contribution.dispose();
  });
  installLoopRuntime(cordis, config.pi);
}

export default loopExtension;
