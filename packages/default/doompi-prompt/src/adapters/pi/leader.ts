import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { COMMAND_NAME } from '../../commands/promptsCommand.ts';
import {
  LEADER_BINDING_PREFIX,
  LEADER_DETAIL,
  LEADER_GROUP,
  LEADER_KEY,
  LEADER_LABEL,
  PACKAGE_SOURCE,
} from './promptConstants.ts';

/** Puts the picker on the leader map, and takes it back off on dispose. */
export function registerLeaderContribution(hub: DoomUiHubService): () => void {
  const contribution = hub.registerLeader({
    source: PACKAGE_SOURCE,
    bindings: [
      {
        id: `${LEADER_BINDING_PREFIX}.open`,
        path: [LEADER_GROUP, { key: LEADER_KEY, label: LEADER_LABEL, detail: LEADER_DETAIL }],
        command: { name: COMMAND_NAME },
      },
    ],
  });
  return () => contribution.dispose();
}
