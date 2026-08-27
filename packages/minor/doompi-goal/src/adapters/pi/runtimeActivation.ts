import {
  type MinorModeCondition,
  type MinorModeCatalogService,
  type MinorModeState,
  registerMinorModeOwner,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DefaultGoalExtensionService } from '../../services/extensionService.ts';
import type { GoalExtensionDependencies } from '../../types/extension.ts';
import { GoalPiManager } from './goalManager.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-goal';
const MODE_ID = 'goal';
const MODE_ORDER = 100;
const MODE_ACTION_START = 'start';
const MODE_ACTION_END = 'end';

function disposeAll(disposers: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Goal cleanup failed.');
}

export function isRetainedGoalStatus(status: unknown): status is string {
  return typeof status === 'string' && status !== 'cleared' && status !== 'complete';
}

function detailForStatus(status: string): string {
  switch (status) {
    case 'usage_limited':
      return 'usage limited';
    case 'budget_limited':
      return 'budget limited';
    default:
      return status;
  }
}

function conditionForStatus(status: unknown): MinorModeCondition {
  switch (status) {
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'blocked';
    case 'usage_limited':
    case 'budget_limited':
      return 'limited';
    default:
      return 'ready';
  }
}

export function goalMinorModeState(status: unknown, goalId?: string): MinorModeState {
  const active = isRetainedGoalStatus(status);
  return {
    activation: active ? 'active' : 'inactive',
    condition: conditionForStatus(status),
    ...(active
      ? {
          detail: detailForStatus(status),
          color: status === 'active' ? ('accent' as const) : ('warning' as const),
          ...(goalId ? { modelContextVariant: goalId } : {}),
        }
      : {}),
    actions: [
      ...(active
        ? [{ id: MODE_ACTION_START, enabled: false, disabledReason: 'A goal is already active.' } as const]
        : [{ id: MODE_ACTION_START, enabled: true } as const]),
      ...(active
        ? [{ id: MODE_ACTION_END, enabled: true } as const]
        : [{ id: MODE_ACTION_END, enabled: false, disabledReason: 'No goal is active.' } as const]),
    ],
  };
}

export interface GoalRuntimeActivation {
  manager: GoalPiManager;
  dispose(): void;
}

export function activateGoalRuntime(pi: ExtensionAPI, dependencies?: GoalExtensionDependencies): GoalRuntimeActivation {
  const resolvedDependencies = dependencies ?? { service: new DefaultGoalExtensionService() };
  const manager = new GoalPiManager(pi, resolvedDependencies, dependencies?.service);
  const disposeManager = manager.register();
  let disposed = false;
  return {
    manager,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeManager();
    },
  };
}

export function registerGoalMinorMode(catalog: MinorModeCatalogService, manager: GoalPiManager): () => void {
  const mode = registerMinorModeOwner<ExtensionContext>(catalog, {
    descriptor: {
      source: PACKAGE_SOURCE,
      id: MODE_ID,
      label: 'Goal',
      description: 'Persistent objective execution with optional token budgeting.',
      order: MODE_ORDER,
      actions: [
        {
          id: MODE_ACTION_START,
          label: 'Start',
          description: 'Start a persistent goal.',
          contexts: ['tui', 'headless'],
          parameters: [
            { name: 'objective', label: 'Objective', kind: 'string', required: true, minLength: 1 },
            { name: 'budget', label: 'Token budget', kind: 'number', required: false, integer: true, minimum: 1 },
          ],
        },
        {
          id: MODE_ACTION_END,
          label: 'End',
          description: 'End the current goal.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
      ],
    },
    initialState: goalMinorModeState(manager.snapshot().goal?.status, manager.snapshot().goal?.id),
    async handleAction(actionId, argumentsValue, execution) {
      if (actionId === MODE_ACTION_START) {
        await manager.startFromCatalog(
          argumentsValue.objective as string,
          argumentsValue.budget as number | undefined,
          execution.context,
        );
        return { message: 'Goal started.' };
      }
      if (actionId === MODE_ACTION_END) {
        await manager.endFromLeader(execution.context);
        return { message: 'Goal ended.' };
      }
      throw new Error(`Unknown goal mode action: ${actionId}`);
    },
  });
  const disposeState = manager.subscribeState((event) => mode.publish(goalMinorModeState(event.status, event.goalId)));
  return () => disposeAll([disposeState, () => mode.dispose()]);
}

export function activateGoalExtension(pi: ExtensionAPI, dependencies?: GoalExtensionDependencies): () => void {
  const activation = activateGoalRuntime(pi, dependencies);
  return () => activation.dispose();
}
