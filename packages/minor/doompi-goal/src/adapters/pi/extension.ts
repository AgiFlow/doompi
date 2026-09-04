import {
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { type LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  activateGoalRuntime,
  isRetainedGoalStatus,
  registerGoalMinorMode,
} from '../../adapters/pi/runtimeActivation.ts';
import { openGoalHistoryOverlay } from '../../tui/goalHistoryOverlay.ts';
import type { GoalExtensionDependencies } from '../../types/extension.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-goal';
const LEADER_ORDER = 100;
const GOAL_ACTION = {
  show: 'goal.show',
  start: 'goal.start',
  end: 'goal.end',
  history: 'goal.history',
} as const;

/**
 * The goal menu as it stands with a goal held or not.
 *
 * One entry on `e`, the way every other minor mode publishes its toggle: with no
 * goal it starts one, with a goal held it ends that one. Printing `start` beside
 * `end` made the reader check the mode line to find out which of the two did
 * anything.
 */
function goalLeaderBindings(status: unknown): LeaderBinding[] {
  const group = { key: 'g', label: 'goal', detail: 'session objective', order: LEADER_ORDER } as const;
  const retained = isRetainedGoalStatus(status);
  const bindings: LeaderBinding[] = [
    retained
      ? {
          id: GOAL_ACTION.end,
          path: [group, { key: 'e', label: 'exit', detail: 'end the current goal', tone: 'exit' }],
          action: { name: GOAL_ACTION.end },
        }
      : {
          id: GOAL_ACTION.start,
          path: [group, { key: 'e', label: 'enter', detail: 'start a session goal' }],
          action: { name: GOAL_ACTION.start },
        },
    {
      id: GOAL_ACTION.history,
      path: [group, { key: 'l', label: 'list', detail: 'goals in this repository' }],
      action: { name: GOAL_ACTION.history },
    },
  ];
  if (retained) {
    bindings.push({
      id: GOAL_ACTION.show,
      path: [group, { key: 'g', label: 'current', detail: 'the goal being worked' }],
      action: { name: GOAL_ACTION.show },
    });
  }
  return bindings;
}

interface GoalPluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies?: GoalExtensionDependencies;
}

function goalPlugin(cordis: Context, { pi, dependencies }: GoalPluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-goal',
          description:
            'Use Doom Pi Goal to start, budget, pause, resume, complete, block, and inspect persistent repository goals.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  cordis.effect(function* () {
    const activation = activateGoalRuntime(pi, dependencies);
    yield () => activation.dispose();

    const manager = activation.manager;
    cordis.inject([DOOM_BACKGROUND_WORK_SERVICE], (backgroundContext) => {
      const service = readDoomBackgroundWorkService(backgroundContext);
      if (!service) return undefined;
      const disposeBinding = manager.bindBackgroundWork(service);
      const disposeChanged = backgroundContext.on(DOOM_BACKGROUND_WORK_CHANGED_EVENT, () =>
        manager.backgroundWorkChanged(service),
      );
      return () => {
        disposeChanged();
        disposeBinding();
      };
    });
    cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) =>
      registerGoalMinorMode(requireMinorModeCatalog(modeContext), manager),
    );
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const hub = requireDoomUiHub(uiContext);
      const leader = hub.registerLeader({
        source: PACKAGE_SOURCE,
        bindings: goalLeaderBindings(manager.snapshot().goal?.status),
      });
      const stateDisposer = manager.subscribeState((event) => leader.update(goalLeaderBindings(event.status)));
      const actions = hub.registerLeaderActions<ExtensionContext>({
        source: PACKAGE_SOURCE,
        handlers: {
          [GOAL_ACTION.show]: (ctx) => manager.showFromLeader(ctx),
          [GOAL_ACTION.start]: (ctx) => manager.startFromLeader(ctx),
          [GOAL_ACTION.end]: (ctx) => manager.endFromLeader(ctx),
          [GOAL_ACTION.history]: (ctx) => openGoalHistoryOverlay(ctx, manager),
        },
        onError: (error, _action, ctx) => {
          if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        },
      });
      return () => {
        stateDisposer();
        actions();
        leader.dispose();
      };
    });
  }, PACKAGE_SOURCE);
}

/** The package's single standard Pi factory, with optional typed host integrations included. */
export async function registerGoalExtension(pi: ExtensionAPI, dependencies?: GoalExtensionDependencies): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(goalPlugin, { pi, dependencies });
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
