import { piMinorModes } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GoalPiManager } from './goalManager';
import {
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/background-work';
import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_TOOL_SURFACE_SERVICE, requireDoomToolSurface } from '@agimon-ai/doompi-core/tool-surface';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import { type LeaderBinding } from '@agimon-ai/doompi-core/leader';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createGoalRuntime, isRetainedGoalStatus, createGoalMinorMode } from './runtimeActivation';
import type { GoalExtensionDependencies } from '../types/extension';

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

export function createGoalPlugin(
  pi: ExtensionAPI,
  dependencies: GoalExtensionDependencies | undefined,
  openGoalHistoryOverlay: (context: ExtensionContext, manager: GoalPiManager) => Promise<void>,
): PiPluginContributions<GoalExtensionDependencies> {
  const activation = createGoalRuntime(pi, dependencies);

  const manager = activation.manager;
  const mode = createGoalMinorMode(manager);
  const bindServices = (cordis: Context) => {
    cordis.inject([DOOM_TOOL_SURFACE_SERVICE], (surfaceContext) =>
      manager.bindToolSurface(requireDoomToolSurface(surfaceContext)),
    );
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
    cordis.effect(() => manager.subscribeState(() => mode.publish()));
  };
  return {
    services: [bindServices, piMinorModes([mode])],

    tools: manager.tools(),
    toolRestrictions: manager.toolRestrictions(),
    commands: manager.commands(),
    events: manager.events(),
    onStop: () => activation.dispose(),
    onDispose: () => activation.dispose(),
  };
}
