import type { LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import {
  LEADER_CATALOG_ACTION,
  LEADER_DETAIL,
  LEADER_DISABLE_ACTION,
  LEADER_ENABLE_ACTION,
  LEADER_KEY,
  LEADER_LABEL,
  LEADER_MANAGE_ACTION,
  LEADER_ORDER,
  LEADER_RECOVER_ACTION,
  PACKAGE_SOURCE,
} from '../../types/index.ts';

const LEADER_BINDING_PREFIX = 'doom-workflow';
const GROUP_SEGMENT = {
  key: LEADER_KEY,
  label: LEADER_LABEL,
  detail: LEADER_DETAIL,
  order: LEADER_ORDER,
} as const;

export interface WorkflowLeaderHandle {
  /** Republish the menu for the mode's current state. */
  setMode(enabled: boolean): void;
  dispose(): void;
}

/**
 * The menu as it stands with the mode on or off.
 *
 * One entry on `e` rather than an enable row beside a disable row: only one of
 * the two ever does anything, and a menu that prints both makes the reader
 * check the mode line to find out which. The label says which way it flips.
 */
export function workflowLeaderBindings(mode: boolean): LeaderBinding[] {
  return [
    {
      id: `${LEADER_BINDING_PREFIX}.catalog`,
      // Launching lives on this board's own `r` key rather than a second menu
      // entry: picking which workflow to run is the same act as reading what
      // one does.
      path: [GROUP_SEGMENT, { key: 'l', label: 'list', detail: 'browse and launch workflows' }],
      action: { name: LEADER_CATALOG_ACTION },
    },
    {
      id: `${LEADER_BINDING_PREFIX}.manage`,
      path: [GROUP_SEGMENT, { key: 'r', label: 'runs', detail: 'runs in this session' }],
      action: { name: LEADER_MANAGE_ACTION },
    },
    mode
      ? {
          id: `${LEADER_BINDING_PREFIX}.disable`,
          path: [GROUP_SEGMENT, { key: 'e', label: 'exit', detail: 'take back workflow tools', tone: 'exit' }],
          action: { name: LEADER_DISABLE_ACTION },
        }
      : {
          id: `${LEADER_BINDING_PREFIX}.enable`,
          path: [GROUP_SEGMENT, { key: 'e', label: 'enter', detail: 'give the agent workflow tools' }],
          action: { name: LEADER_ENABLE_ACTION },
        },
    // `r` is runs everywhere, so recovery moves off it rather than reading as a
    // third flavour of list in the one space that has both.
    {
      id: `${LEADER_BINDING_PREFIX}.recover`,
      path: [GROUP_SEGMENT, { key: 'c', label: 'recover', detail: 'adopt a failed run' }],
      action: { name: LEADER_RECOVER_ACTION },
    },
  ];
}

export function registerLeaderContribution(hub: DoomUiHubService, enabled = false): WorkflowLeaderHandle {
  const contribution = hub.registerLeader({
    source: PACKAGE_SOURCE,
    bindings: workflowLeaderBindings(enabled),
  });
  return {
    setMode(enabled) {
      contribution.update(workflowLeaderBindings(enabled));
    },
    dispose() {
      contribution.dispose();
    },
  };
}
