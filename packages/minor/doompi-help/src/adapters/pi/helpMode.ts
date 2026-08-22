import type { LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import {
  type MinorModeCatalogService,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HelpActivationService, HelpRuntimeState } from '../../types/help.ts';

export const HELP_PACKAGE_SOURCE = '@agimon-ai/doompi-help';
export const HELP_MODE_ID = 'help';
export const HELP_MODE_ORDER = 50;
export const HELP_LEADER_ACTION = 'help.toggle';

const HELP_GROUP = { key: 'h', label: 'help', detail: 'package docs and logs', order: 70 } as const;
const MODE_ACTION_ACTIVATE = 'activate';
const MODE_ACTION_DEACTIVATE = 'deactivate';
const MAX_MODE_DETAIL_LENGTH = 160;

function boundedDetail(value: string): string {
  return value.slice(0, MAX_MODE_DETAIL_LENGTH);
}

export function helpMinorModeState(state: HelpRuntimeState): MinorModeState {
  if (state.activation === 'activating') {
    return {
      activation: 'activating',
      condition: 'queued',
      detail: 'loading package Help',
      actions: [
        { id: MODE_ACTION_ACTIVATE, enabled: false, disabledReason: 'Help activation is already running.' },
        { id: MODE_ACTION_DEACTIVATE, enabled: true },
      ],
    };
  }
  if (state.activation === 'active' || state.activation === 'degraded') {
    const degraded = state.activation === 'degraded';
    return {
      activation: 'active',
      condition: degraded ? 'degraded' : 'ready',
      detail: boundedDetail(`${state.skills.length} package Help skill${state.skills.length === 1 ? '' : 's'}`),
      ...(degraded ? { color: 'warning' as const } : { color: 'accent' as const }),
      actions: [
        { id: MODE_ACTION_ACTIVATE, enabled: false, disabledReason: 'Help is already active.' },
        { id: MODE_ACTION_DEACTIVATE, enabled: true },
      ],
    };
  }
  const failure = state.diagnostics[0]?.message;
  return {
    activation: 'inactive',
    condition: failure ? 'failed' : 'ready',
    ...(failure ? { detail: boundedDetail(failure), color: 'warning' as const } : {}),
    actions: [
      { id: MODE_ACTION_ACTIVATE, enabled: true },
      { id: MODE_ACTION_DEACTIVATE, enabled: false, disabledReason: 'Help is not active.' },
    ],
  };
}

function leaderBindings(state: HelpRuntimeState): LeaderBinding[] {
  const active = state.activation !== 'inactive';
  return [
    {
      id: 'help.toggle',
      path: [
        HELP_GROUP,
        active
          ? { key: 'e', label: 'exit', detail: 'hide package Help' }
          : { key: 'e', label: 'enter', detail: 'load package Help' },
      ],
      action: { name: HELP_LEADER_ACTION },
    },
  ];
}

function reportAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

export interface HelpModeIntegration {
  mode: MinorModeOwnerHandle;
  dispose(): void;
}

export function registerHelpModeIntegration(
  catalog: MinorModeCatalogService,
  activation: HelpActivationService,
): HelpModeIntegration {
  const mode = registerMinorModeOwner<ExtensionContext>(catalog, {
    descriptor: {
      source: HELP_PACKAGE_SOURCE,
      id: HELP_MODE_ID,
      label: 'Help',
      description: 'Activation-gated package guidance from exact installed package versions.',
      order: HELP_MODE_ORDER,
      actions: [
        {
          id: MODE_ACTION_ACTIVATE,
          label: 'Activate',
          description: 'Load package-owned Help indexes and expose their generated skills.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
        {
          id: MODE_ACTION_DEACTIVATE,
          label: 'Deactivate',
          description: 'Remove all active package Help skills immediately.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
      ],
    },
    initialState: helpMinorModeState(activation.getState()),
    async handleAction(actionId, _arguments, execution) {
      if (actionId === MODE_ACTION_ACTIVATE) {
        const state = await activation.activate(execution.signal);
        return {
          message: boundedDetail(
            `Activated ${state.skills.length} package Help skill${state.skills.length === 1 ? '' : 's'}${state.activation === 'degraded' ? ' with diagnostics.' : '.'}`,
          ),
        };
      }
      if (actionId === MODE_ACTION_DEACTIVATE) {
        activation.deactivate();
        return { message: 'Package Help deactivated.' };
      }
      throw new Error(`Unknown Help mode action: ${actionId}`);
    },
    onError: reportAsync,
  });
  const stateDisposer = activation.subscribe((state) => mode.publish(helpMinorModeState(state)));
  let disposed = false;
  return {
    mode,
    dispose() {
      if (disposed) return;
      disposed = true;
      stateDisposer();
      mode.dispose();
    },
  };
}

export function registerHelpUiIntegration(hub: DoomUiHubService, activation: HelpActivationService): () => void {
  const leader = hub.registerLeader({
    source: HELP_PACKAGE_SOURCE,
    bindings: leaderBindings(activation.getState()),
  });
  const actionDisposer = hub.registerLeaderActions<ExtensionContext>({
    source: HELP_PACKAGE_SOURCE,
    handlers: {
      [HELP_LEADER_ACTION]: async (context) => {
        const state = activation.getState();
        if (state.activation === 'inactive') await activation.activate();
        else activation.deactivate();
        if (context.hasUI) {
          context.ui.notify(
            activation.getState().activation === 'inactive' ? 'Package Help deactivated.' : 'Package Help activated.',
            'info',
          );
        }
      },
    },
    onError: (error, _action, context) => {
      if (context.hasUI) context.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      else reportAsync(error);
    },
  });
  const stateDisposer = activation.subscribe((state) => leader.update(leaderBindings(state)));
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    stateDisposer();
    actionDisposer();
    leader.dispose();
  };
}
